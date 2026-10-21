import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as elbTargets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as r53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import { Construct } from 'constructs'
import { AppConfig } from '../../config/types'
import { ubuntuMachineImage } from '../host-image'
import { renderUserData } from '../user-data'

export interface DashboardProps {
  readonly config: AppConfig
  readonly vpc: ec2.IVpc
  readonly hostedZone: r53.IHostedZone
  readonly domainName: string
  /** Existing wildcard certificate covering the dashboard subdomain. */
  readonly certificate: acm.ICertificate
}

/** Redash listens on port 80 inside the instance; the ALB terminates TLS. */
const REDASH_PORT = 80

/**
 * Optional Redash instance for ad-hoc SQL (PostgreSQL + ClickHouse).
 *
 * The instance sits in a private subnet and is only reachable through its ALB:
 * HTTPS terminates there and ingress is limited to `dashboard.allowedCidrs`.
 * There is no SSH - use SSM Session Manager.
 */
export class Dashboard extends Construct {
  public readonly instance: ec2.Instance
  /** Instance security group - also the client identity used for database access. */
  public readonly securityGroup: ec2.SecurityGroup
  public readonly loadBalancer: elb.ApplicationLoadBalancer
  public readonly url: string

  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id)

    const { config } = props
    if (config.dashboard.allowedCidrs.length === 0) {
      throw new Error('dashboard.allowedCidrs must contain at least one CIDR when the dashboard is enabled.')
    }

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Redash dashboard',
      allowAllOutbound: true,
    })

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: props.vpc,
      description: 'Redash dashboard ALB',
      allowAllOutbound: true,
    })
    for (const cidr of config.dashboard.allowedCidrs) {
      loadBalancerSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), `HTTPS from ${cidr}`)
      loadBalancerSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), `HTTP redirect from ${cidr}`)
    }
    this.securityGroup.addIngressRule(
      loadBalancerSecurityGroup,
      ec2.Port.tcp(REDASH_PORT),
      'Dashboard ALB to Redash',
    )

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Dashboard host: SSM access only',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    })

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      // Private: no public IP, no inbound rule on the host itself.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: config.dashboard.instanceType,
      machineImage: ubuntuMachineImage(config),
      role,
      securityGroup: this.securityGroup,
      requireImdsv2: true,
      userData: ec2.UserData.custom(
        renderUserData('dashboard.sh', { REDASH_IMAGE: config.dashboard.redashImage }),
      ),
      blockDevices: [
        {
          deviceName: config.hostImage.rootDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(config.dashboard.volumeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    })

    const targetGroup = new elb.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: REDASH_PORT,
      protocol: elb.ApplicationProtocol.HTTP,
      targets: [new elbTargets.InstanceTarget(this.instance, REDASH_PORT)],
      healthCheck: {
        path: '/ping',
        port: String(REDASH_PORT),
        protocol: elb.Protocol.HTTP,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    })

    this.loadBalancer = new elb.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: loadBalancerSecurityGroup,
    })

    // Ingress is granted per CIDR above; `open` would add 0.0.0.0/0 and make
    // the allowedCidrs setting meaningless.
    this.loadBalancer.addListener('Https', {
      port: 443,
      protocol: elb.ApplicationProtocol.HTTPS,
      certificates: [props.certificate],
      open: false,
      defaultTargetGroups: [targetGroup],
    })
    this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elb.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elb.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
    })

    new r53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone,
      recordName: props.domainName,
      target: r53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.loadBalancer)),
    })

    this.url = `https://${props.domainName}`
  }
}
