import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as r53 from 'aws-cdk-lib/aws-route53'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import { domainName } from '../config'
import { AppConfig } from '../config/types'
import { ApiService } from './constructs/api-service'
import { AnalyticsCluster, CLICKHOUSE_HTTP_PORT } from './constructs/analytics'
import { Dashboard } from './constructs/dashboard'
import { Database } from './constructs/database'
import { StaticSite } from './constructs/static-site'

/** 32 random bytes, base64-encoded, with punctuation stripped. */
const APP_SECRET_LENGTH = 44

export interface ApplicationStackProps extends cdk.StackProps {
  readonly config: AppConfig
  readonly hostedZoneId: string
  /** Wildcard certificate from `CertificateStack` (us-east-1). */
  readonly certificateArn: string
  readonly vpc: ec2.IVpc
  /** Image repository from `RegistryStack`. */
  readonly repository: ecr.IRepository
}

/**
 * Everything that runs the application: database, API, frontend, analytics.
 * Networking, DNS and certificates live in their own stacks with their own
 * lifecycle.
 */
export class ApplicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props)

    const { config, vpc } = props
    const rootDomain = config.domain.rootDomain

    const hostedZone = r53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: rootDomain,
    })

    const cloudFrontCertificate = acm.Certificate.fromCertificateArn(
      this,
      'CloudFrontCertificate',
      props.certificateArn,
    )

    // ALBs and API Gateway need a certificate in their own region.
    const regionalCertificate = new acm.Certificate(this, 'RegionalCertificate', {
      domainName: `*.${rootDomain}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    })

    // Security groups
    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      description: 'API tasks',
      allowAllOutbound: true,
    })
    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'PostgreSQL',
    })
    databaseSecurityGroup.addIngressRule(
      apiSecurityGroup,
      ec2.Port.tcp(config.database.port),
      'API to PostgreSQL',
    )

    // Secrets
    const appSecret = config.api.secrets.existingSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'AppSecret', config.api.secrets.existingSecretArn)
      : new secretsmanager.Secret(this, 'AppSecret', {
          secretName: `${config.projectName}/${config.stage}/app`,
          description: 'Application secrets as JSON. Add your API keys as extra keys.',
          generateSecretString: {
            secretStringTemplate: JSON.stringify({}),
            generateStringKey: config.api.secrets.generatedKey,
            excludePunctuation: true,
            includeSpace: false,
            passwordLength: APP_SECRET_LENGTH,
          },
        })

    // Storage
    const uploadsBucket = config.storage.uploadsBucket
      ? new s3.Bucket(this, 'Uploads', {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: !config.retainData,
        })
      : undefined

    // Data stores
    const database = new Database(this, 'Database', {
      config,
      vpc,
      securityGroup: databaseSecurityGroup,
    })

    const analytics = config.analytics.enabled
      ? new AnalyticsCluster(this, 'Analytics', {
          config,
          vpc,
          hostedZone,
          domainName: domainName(config.analytics.subdomain, rootDomain),
          allowedSecurityGroups: [apiSecurityGroup],
        })
      : undefined

    const dashboard = config.dashboard.enabled
      ? new Dashboard(this, 'Dashboard', {
          config,
          vpc,
          hostedZone,
          domainName: domainName(config.dashboard.subdomain, rootDomain),
          certificate: regionalCertificate,
        })
      : undefined

    if (dashboard) {
      databaseSecurityGroup.addIngressRule(
        dashboard.securityGroup,
        ec2.Port.tcp(config.database.port),
        'Dashboard to PostgreSQL',
      )
      analytics?.securityGroup.addIngressRule(
        dashboard.securityGroup,
        ec2.Port.tcp(CLICKHOUSE_HTTP_PORT),
        'Dashboard to ClickHouse',
      )
    }

    // API
    const apiDomain = domainName(config.api.subdomain, rootDomain)
    const apiService = new ApiService(this, 'Api', {
      config,
      vpc,
      securityGroup: apiSecurityGroup,
      hostedZone,
      certificate: regionalCertificate,
      domainName: apiDomain,
      repository: props.repository,
      database,
      appSecret,
      uploadsBucket,
      analyticsUrl: analytics?.url,
      analyticsSecret: analytics?.password,
    })

    // Frontend
    const siteDomain = domainName(config.site.subdomain, rootDomain)
    const site = config.site.enabled
      ? new StaticSite(this, 'Site', {
          config,
          hostedZone,
          certificate: cloudFrontCertificate,
          domainName: siteDomain,
        })
      : undefined

    // Outputs - the only values you need after `cdk deploy`.
    new cdk.CfnOutput(this, 'ApiUrl', { value: `https://${apiDomain}` })
    // Used by scripts/push-image.sh to trigger a rolling deployment.
    new cdk.CfnOutput(this, 'ClusterName', { value: apiService.service.cluster.clusterName })
    new cdk.CfnOutput(this, 'ServiceName', { value: apiService.service.service.serviceName })
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.instance.dbInstanceEndpointAddress,
    })
    new cdk.CfnOutput(this, 'DatabaseSecretArn', { value: database.secret.secretArn })
    new cdk.CfnOutput(this, 'AppSecretArn', { value: appSecret.secretArn })

    if (site) {
      new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${siteDomain}` })
      new cdk.CfnOutput(this, 'SiteBucketName', { value: site.bucket.bucketName })
      new cdk.CfnOutput(this, 'DistributionId', { value: site.distribution.distributionId })
    }

    if (uploadsBucket) {
      new cdk.CfnOutput(this, 'UploadsBucketName', { value: uploadsBucket.bucketName })
    }

    if (analytics) {
      new cdk.CfnOutput(this, 'ClickHouseUrl', { value: analytics.url })
    }

    if (dashboard) {
      new cdk.CfnOutput(this, 'DashboardUrl', { value: dashboard.url })
    }
  }
}
