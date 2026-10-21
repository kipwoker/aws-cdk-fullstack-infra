import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import { FckNatInstanceProvider } from 'cdk-fck-nat'
import { AppConfig, VpcEndpoint } from '../config/types'

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: AppConfig
}

const INTERFACE_ENDPOINTS: Partial<Record<VpcEndpoint, ec2.InterfaceVpcEndpointAwsService>> = {
  ecr: ec2.InterfaceVpcEndpointAwsService.ECR,
  'ecr-docker': ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
  ecs: ec2.InterfaceVpcEndpointAwsService.ECS,
  'ecs-agent': ec2.InterfaceVpcEndpointAwsService.ECS_AGENT,
  'ecs-telemetry': ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
  'secrets-manager': ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  'cloudwatch-logs': ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
  ssm: ec2.InterfaceVpcEndpointAwsService.SSM,
  sts: ec2.InterfaceVpcEndpointAwsService.STS,
  kms: ec2.InterfaceVpcEndpointAwsService.KMS,
  rds: ec2.InterfaceVpcEndpointAwsService.RDS,
}

/**
 * Networking only: VPC, public/private subnets, NAT and optional VPC endpoints.
 * Kept separate so it can be replaced or shared between application stacks.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props)

    const { network } = props.config

    const natGatewayProvider =
      network.nat === 'fck-nat'
        ? new FckNatInstanceProvider({
            instanceType: network.natInstanceType,
            machineImage: network.natMachineImage,
          })
        : undefined

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: network.maxAzs,
      natGatewayProvider,
      natGateways: natGatewayProvider ? undefined : 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: network.subnetCidrMask,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: network.subnetCidrMask,
        },
      ],
    })

    if (natGatewayProvider) {
      // Allow the whole VPC to route through the NAT instance.
      natGatewayProvider.securityGroup.addIngressRule(
        ec2.Peer.ipv4(vpc.vpcCidrBlock),
        ec2.Port.allTraffic(),
        'VPC egress through fck-nat',
      )
    }

    for (const endpoint of network.endpoints) {
      if (endpoint === 's3') {
        vpc.addGatewayEndpoint('S3Endpoint', {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        })
        continue
      }
      const service = INTERFACE_ENDPOINTS[endpoint]
      if (!service) {
        throw new Error(`Unsupported VPC endpoint "${endpoint}".`)
      }
      vpc.addInterfaceEndpoint(`${endpoint.replace(/(^|-)(\w)/g, (_, __, char) => char.toUpperCase())}Endpoint`, {
        service,
        privateDnsEnabled: true,
      })
    }

    this.vpc = vpc
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId })
  }
}
