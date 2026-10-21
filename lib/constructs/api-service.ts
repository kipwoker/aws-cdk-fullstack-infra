import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns'
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as r53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import { AppConfig } from '../../config/types'
import { Database } from './database'

export interface ApiServiceProps {
  readonly config: AppConfig
  readonly vpc: ec2.IVpc
  /** Shared with the database so only this service can reach PostgreSQL. */
  readonly securityGroup: ec2.ISecurityGroup
  readonly hostedZone: r53.IHostedZone
  /** Regional wildcard certificate (the CloudFront one lives in us-east-1). */
  readonly certificate: acm.ICertificate
  readonly domainName: string
  /** Repository from `RegistryStack`; images are pushed before the app deploys. */
  readonly repository: ecr.IRepository
  readonly database: Database
  readonly appSecret: secretsmanager.ISecret
  readonly uploadsBucket?: s3.IBucket
  readonly analyticsUrl?: string
  /** ClickHouse password, injected as `CLICKHOUSE_PASSWORD` (never as plain env). */
  readonly analyticsSecret?: secretsmanager.ISecret
}

/**
 * The service always pulls `latest`; `scripts/push-image.sh` pushes the version
 * tag and `latest`, then forces a new deployment, so no redeploy is needed.
 */
const IMAGE_TAG = 'latest'

/** Only the VPC link talks to the ALB, so plain HTTP on port 80 is enough. */
const ALB_LISTENER_PORT = 80
const HEALTH_CHECK_GRACE_PERIOD = cdk.Duration.seconds(120)
const HEALTH_CHECK_INTERVAL = cdk.Duration.seconds(30)
const HEALTH_CHECK_TIMEOUT = cdk.Duration.seconds(5)
const HEALTHY_THRESHOLD_COUNT = 2
const UNHEALTHY_THRESHOLD_COUNT = 5
const LOG_STREAM_PREFIX = 'api'
const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS
/** A single task may not be replaced in place: that is downtime, not a rollout. */
const MIN_HEALTHY_PERCENT_SINGLE_TASK = 100
const MIN_HEALTHY_PERCENT_MULTI_TASK = 50

/**
 * Containerised API:
 *   ECR -> Fargate (private subnets) <- ALB (internal) <- API Gateway (VPC link) <- Route 53
 *
 * The ALB is never public; API Gateway is the single entry point.
 */
export class ApiService extends Construct {
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService
  public readonly httpApi: apigatewayv2.HttpApi

  constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id)

    const { api } = props.config

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc })

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: props.vpc,
      description: 'Internal ALB in front of the API service',
      allowAllOutbound: true,
    })
    const vpcLinkSecurityGroup = new ec2.SecurityGroup(this, 'VpcLinkSecurityGroup', {
      vpc: props.vpc,
      description: 'API Gateway VPC link',
      allowAllOutbound: true,
    })
    loadBalancerSecurityGroup.addIngressRule(
      vpcLinkSecurityGroup,
      ec2.Port.tcp(ALB_LISTENER_PORT),
      'API Gateway VPC link to ALB',
    )

    const loadBalancer = new elb.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: loadBalancerSecurityGroup,
    })

    const spotSettings = api.spot
      ? { capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] }
      : {}

    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster,
      loadBalancer,
      listenerPort: ALB_LISTENER_PORT,
      publicLoadBalancer: false,
      // The ALB is internal and only the VPC link may reach it: do not let
      // ecs-patterns open the listener port to 0.0.0.0/0.
      openListener: false,
      desiredCount: api.desiredCount,
      cpu: api.cpu,
      memoryLimitMiB: api.memoryMiB,
      securityGroups: [props.securityGroup],
      healthCheckGracePeriod: HEALTH_CHECK_GRACE_PERIOD,
      // 50% of 1 rounds down to 0, so a one-task service would stop before the
      // replacement is healthy on every `push-image`.
      minHealthyPercent:
        api.desiredCount > 1 ? MIN_HEALTHY_PERCENT_MULTI_TASK : MIN_HEALTHY_PERCENT_SINGLE_TASK,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(props.repository, IMAGE_TAG),
        containerPort: api.containerPort,
        environment: this.environment(props),
        secrets: this.secrets(props),
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: LOG_STREAM_PREFIX,
          logRetention: LOG_RETENTION,
        }),
      },
      ...spotSettings,
    })

    this.service.targetGroup.configureHealthCheck({
      path: api.healthCheckPath,
      healthyThresholdCount: HEALTHY_THRESHOLD_COUNT,
      unhealthyThresholdCount: UNHEALTHY_THRESHOLD_COUNT,
      interval: HEALTH_CHECK_INTERVAL,
      timeout: HEALTH_CHECK_TIMEOUT,
    })

    if (props.uploadsBucket) {
      props.uploadsBucket.grantReadWrite(this.service.taskDefinition.taskRole)
    }

    const apiDomain = new apigatewayv2.DomainName(this, 'DomainName', {
      domainName: props.domainName,
      certificate: props.certificate,
    })

    this.httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      disableExecuteApiEndpoint: true,
      defaultIntegration: new integrations.HttpAlbIntegration('AlbIntegration', this.service.listener, {
        vpcLink: new apigatewayv2.VpcLink(this, 'VpcLink', {
          vpc: props.vpc,
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [vpcLinkSecurityGroup],
        }),
      }),
    })

    new apigatewayv2.ApiMapping(this, 'ApiMapping', {
      api: this.httpApi,
      domainName: apiDomain,
      stage: this.httpApi.defaultStage,
    })

    new r53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone,
      recordName: props.domainName,
      target: r53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(apiDomain.regionalDomainName, apiDomain.regionalHostedZoneId),
      ),
    })
  }

  private environment(props: ApiServiceProps): Record<string, string> {
    const { api } = props.config
    const connection = props.database.connection(props.config)

    return {
      PORT: String(api.containerPort),
      APP_DOMAIN: props.config.domain.rootDomain,
      API_DOMAIN: props.domainName,
      DATABASE_HOST: connection.host,
      DATABASE_PORT: connection.port,
      DATABASE_NAME: connection.name,
      ...(props.uploadsBucket ? { UPLOADS_BUCKET: props.uploadsBucket.bucketName } : {}),
      ...(props.analyticsUrl ? { ANALYTICS_URL: props.analyticsUrl } : {}),
      ...api.environment,
    }
  }

  private secrets(props: ApiServiceProps): Record<string, ecs.Secret> {
    const secrets: Record<string, ecs.Secret> = {
      DATABASE_USERNAME: ecs.Secret.fromSecretsManager(props.database.secret, 'username'),
      DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(props.database.secret, 'password'),
    }
    if (props.analyticsSecret) {
      secrets.CLICKHOUSE_PASSWORD = ecs.Secret.fromSecretsManager(props.analyticsSecret)
    }
    for (const [envVar, jsonKey] of Object.entries(props.config.api.secrets.env)) {
      secrets[envVar] = ecs.Secret.fromSecretsManager(props.appSecret, jsonKey)
    }
    return secrets
  }
}

