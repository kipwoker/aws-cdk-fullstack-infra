import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as elbTargets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as r53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import { AppConfig } from '../../config/types'
import { instanceMemoryGiB, ubuntuMachineImage } from '../host-image'
import { renderUserData } from '../user-data'

export interface AnalyticsProps {
  readonly config: AppConfig
  readonly vpc: ec2.IVpc
  readonly hostedZone: r53.IHostedZone
  readonly domainName: string
  /** Security groups allowed to query ClickHouse (API, dashboard, ...). */
  readonly allowedSecurityGroups: ec2.ISecurityGroup[]
}

export const CLICKHOUSE_HTTP_PORT = 8123

/** Leave headroom for the OS, the SSM agent and the page cache. */
const MAX_MEMORY_RATIO = 0.75
/** S3 disk cache: a fifth of the data volume, capped, so a small root disk survives. */
const CACHE_RATIO = 0.2
const MAX_CACHE_GIB = 10
/** gp3 baseline, free at any volume size. */
const GP3_BASELINE_IOPS = 3000
const GP3_BASELINE_THROUGHPUT_MIB = 125

/**
 * ClickHouse on a single EC2 instance (private subnet) behind an internal ALB.
 * No baked AMIs: Ubuntu comes from the public SSM parameter, ClickHouse from
 * the official apt repository, and heavy data is tiered to S3.
 */
export class AnalyticsCluster extends Construct {
  public readonly bucket: s3.Bucket
  public readonly securityGroup: ec2.SecurityGroup
  public readonly instance: ec2.Instance
  /** Password of the ClickHouse `default` user, injected into the API task. */
  public readonly password: secretsmanager.Secret
  public readonly url: string

  constructor(scope: Construct, id: string, props: AnalyticsProps) {
    super(scope, id)

    const { config } = props

    // Sizing follows the configured instance and volume instead of fixed literals.
    const memoryGiB = instanceMemoryGiB(config.analytics.instanceType)
    const maxMemoryBytes = Math.floor(memoryGiB * MAX_MEMORY_RATIO) * 1024 ** 3
    const cacheGiB = Math.max(1, Math.min(MAX_CACHE_GIB, Math.round(config.analytics.volumeGb * CACHE_RATIO)))

    this.password = new secretsmanager.Secret(this, 'Password', {
      description: 'ClickHouse default user password',
      generateSecretString: { passwordLength: 32, excludePunctuation: true, includeSpace: false },
    })

    this.bucket = new s3.Bucket(this, 'Storage', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.retainData,
    })

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'ClickHouse host: S3 tiering + SSM access',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    })
    this.bucket.grantReadWrite(role)
    // The host reads its password at boot; nothing is baked into user-data.
    this.password.grantRead(role)

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'ClickHouse instance and internal ALB',
      allowAllOutbound: true,
    })
    // The ALB and the instance share this security group.
    this.securityGroup.addIngressRule(
      this.securityGroup,
      ec2.Port.tcp(CLICKHOUSE_HTTP_PORT),
      'ALB to ClickHouse',
    )
    for (const [index, securityGroup] of props.allowedSecurityGroups.entries()) {
      this.securityGroup.addIngressRule(
        securityGroup,
        ec2.Port.tcp(CLICKHOUSE_HTTP_PORT),
        `ClickHouse client ${index + 1}`,
      )
    }

    const loadBalancer = new elb.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: this.securityGroup,
    })

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: config.analytics.instanceType,
      machineImage: ubuntuMachineImage(config),
      role,
      securityGroup: this.securityGroup,
      requireImdsv2: true,
      userData: ec2.UserData.custom(
        renderUserData('clickhouse.sh', {
          REGION: config.region,
          BUCKET: this.bucket.bucketName,
          HTTP_PORT: String(CLICKHOUSE_HTTP_PORT),
          SECRET_ARN: this.password.secretArn,
          MAX_MEMORY_BYTES: String(maxMemoryBytes),
          CACHE_SIZE: `${cacheGiB}Gi`,
        }),
      ),
      blockDevices: [
        {
          deviceName: config.hostImage.rootDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(config.analytics.volumeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            iops: GP3_BASELINE_IOPS,
            throughput: GP3_BASELINE_THROUGHPUT_MIB,
          }),
        },
      ],
    })

    const targetGroup = new elb.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: CLICKHOUSE_HTTP_PORT,
      protocol: elb.ApplicationProtocol.HTTP,
      targets: [new elbTargets.InstanceTarget(this.instance)],
      healthCheck: {
        path: '/ping',
        port: String(CLICKHOUSE_HTTP_PORT),
        protocol: elb.Protocol.HTTP,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        // `/ping` is unauthenticated even once the default user has a password.
        healthyHttpCodes: '200',
      },
    })

    loadBalancer.addListener('Http', {
      port: CLICKHOUSE_HTTP_PORT,
      protocol: elb.ApplicationProtocol.HTTP,
      // Ingress is granted per security group below; `open` would add 0.0.0.0/0.
      open: false,
      defaultTargetGroups: [targetGroup],
    })

    new r53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone,
      recordName: props.domainName,
      target: r53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer)),
    })

    this.url = `http://${props.domainName}:${CLICKHOUSE_HTTP_PORT}`
  }
}
