import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { loadConfig } from '../config'
import { AppConfig } from '../config/types'
import { ApplicationStack } from '../lib/application-stack'
import { CertificateStack } from '../lib/certificate-stack'
import { NetworkStack } from '../lib/network-stack'
import { RegistryStack } from '../lib/registry-stack'
import { ZoneStack } from '../lib/zone-stack'

const ACCOUNT = '111111111111'
const REGION = 'eu-west-1'

function createApp(config: AppConfig) {
  const app = new App({ context: { 'cli-telemetry': false } })
  // Avoid AWS lookups so tests run offline.
  app.node.setContext(`availability-zones:account=${ACCOUNT}:region=${REGION}`, [
    `${REGION}a`,
    `${REGION}b`,
    `${REGION}c`,
  ])

  const zone = new ZoneStack(app, 'zone', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    crossRegionReferences: true,
    config,
  })
  const certificate = new CertificateStack(app, 'certificate', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    crossRegionReferences: true,
    config,
    hostedZoneId: zone.hostedZoneId,
  })
  const registry = new RegistryStack(app, 'registry', {
    env: { account: ACCOUNT, region: REGION },
    config,
  })
  const network = new NetworkStack(app, 'network', {
    env: { account: ACCOUNT, region: REGION },
    crossRegionReferences: true,
    config,
  })
  const application = new ApplicationStack(app, 'application', {
    env: { account: ACCOUNT, region: REGION },
    crossRegionReferences: true,
    config,
    vpc: network.vpc,
    repository: registry.repository,
    hostedZoneId: zone.hostedZoneId,
    certificateArn: certificate.certificateArn,
  })

  return { app, zone, certificate, registry, network, application }
}

const baseEnv = { CDK_ACCOUNT: ACCOUNT, ROOT_DOMAIN: 'example.com' }

const productionConfig = loadConfig({ stage: 'production', env: { ...baseEnv }, dotEnv: false })

const allFeaturesConfig: AppConfig = {
  ...productionConfig,
  dashboard: {
    ...productionConfig.dashboard,
    enabled: true,
    allowedCidrs: ['203.0.113.0/24'],
  },
  network: {
    ...productionConfig.network,
    // Deterministic fck-nat AMI: no synth-time EC2 lookup.
    natMachineImage: ec2.MachineImage.genericLinux({ [REGION]: 'ami-0123456789abcdef0' }),
  },
}

describe('infrastructure stacks', () => {
  it('creates the hosted zone before any certificate', () => {
    const { zone } = createApp(allFeaturesConfig)
    const template = Template.fromStack(zone)

    template.resourceCountIs('AWS::Route53::HostedZone', 1)
    expect(Object.keys(template.toJSON().Outputs ?? {})).toEqual(
      expect.arrayContaining(['HostedZoneId', 'NameServers']),
    )
  })

  it('creates the image repository in its own stack', () => {
    const { registry } = createApp(allFeaturesConfig)
    const template = Template.fromStack(registry)

    template.resourceCountIs('AWS::ECR::Repository', 1)
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'fullstack/production/api',
      ImageScanningConfiguration: { ScanOnPush: true },
    })
    expect(Object.keys(template.toJSON().Outputs ?? {})).toEqual(
      expect.arrayContaining(['RepositoryUri', 'RepositoryName']),
    )
  })

  it('creates a VPC with fck-nat and private subnets', () => {
    const { network } = createApp(allFeaturesConfig)
    const template = Template.fromStack(network)

    template.resourceCountIs('AWS::EC2::VPC', 1)
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ Description: 'VPC egress through fck-nat' }),
      ]),
    })
    // S3 gateway + six interface endpoints in production.
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 7)
    template.resourceCountIs('AWS::EC2::Subnet', 4)
  })

  it('wires the API, database, storage and frontend', () => {
    const { application } = createApp(allFeaturesConfig)
    const template = Template.fromStack(application)

    template.resourceCountIs('AWS::RDS::DBInstance', 1)
    template.resourceCountIs('AWS::ECS::Service', 1)
    template.resourceCountIs('AWS::ECS::Cluster', 1)
    template.resourceCountIs('AWS::CloudFront::Distribution', 1)
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1)
    template.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 1)
    // Assets, uploads and ClickHouse storage.
    template.resourceCountIs('AWS::S3::Bucket', 3)

    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.example.com.',
    })
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'example.com.',
    })
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'DATABASE_HOST' }),
            Match.objectLike({ Name: 'UPLOADS_BUCKET' }),
            Match.objectLike({ Name: 'ANALYTICS_URL' }),
          ]),
        }),
      ]),
    })
    // Deploy scripts read these to roll the service after a push.
    expect(Object.keys(template.toJSON().Outputs ?? {})).toEqual(
      expect.arrayContaining(['ClusterName', 'ServiceName']),
    )
  })

  it('creates optional ClickHouse and dashboard hosts when enabled', () => {
    const { application } = createApp(allFeaturesConfig)
    const template = Template.fromStack(application)

    // ClickHouse instance + Redash instance.
    template.resourceCountIs('AWS::EC2::Instance', 2)
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'clickhouse.example.com.',
    })
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'dash.example.com.',
    })
    // TLS terminates on the ALB; the host itself has no public entry point.
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Redash dashboard ALB',
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: '203.0.113.0/24', FromPort: 443 }),
        Match.objectLike({ CidrIp: '203.0.113.0/24', FromPort: 80 }),
      ]),
    })
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    })
    template.resourceCountIs('AWS::EC2::EIP', 0)
  })

  it('never opens a security group to the whole internet', () => {
    const { application } = createApp(allFeaturesConfig)
    const template = Template.fromStack(application)
    const resources = template.toJSON().Resources as Record<string, any>

    const worldOpen: string[] = []
    for (const [id, resource] of Object.entries(resources)) {
      const ingress = resource?.Properties?.SecurityGroupIngress
      if (!Array.isArray(ingress)) continue
      for (const rule of ingress) {
        if (rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0') {
          worldOpen.push(`${id}:${rule.FromPort}`)
        }
      }
    }

    // Listener `open: true` (the CDK default) adds these quietly.
    expect(worldOpen).toEqual([])
  })

  it('authenticates ClickHouse and sizes it from the configured instance', () => {
    const { application } = createApp(allFeaturesConfig)
    const template = Template.fromStack(application)
    const everything = JSON.stringify(template.toJSON())

    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ ExcludePunctuation: true }),
    })
    // The host reads the password at boot with its instance role.
    expect(everything).toContain('secretsmanager:GetSecretValue')
    expect(everything).toContain('secretsmanager get-secret-value')
    expect(everything).toContain('users.d/default-user.xml')

    // Production analytics host is t3.large: 8 GiB * 0.75 = 6 GiB, 100 GB * 20% -> capped at 10Gi.
    expect(everything).toContain('max_memory_usage>6442450944<')
    expect(everything).toContain('max_size>10Gi<')
    expect(everything).not.toContain('4000000000')
  })

  it('only rewrites extension-less paths for the SPA shell', () => {
    const { application } = createApp(allFeaturesConfig)
    const template = Template.fromStack(application)
    const everything = JSON.stringify(template.toJSON())

    template.resourceCountIs('AWS::CloudFront::Function', 1)
    expect(everything).toContain('indexOf(\'.\') === -1')
    // No blanket 403/404 -> 200 mapping, so a missing /assets/* file still 404s.
    const distribution = Object.values(
      template.toJSON().Resources as Record<string, any>,
    ).find((resource) => resource.Type === 'AWS::CloudFront::Distribution')
    expect(distribution?.Properties?.DistributionConfig?.CustomErrorResponses).toBeUndefined()
  })

  it('can be trimmed to a database + API only', () => {
    const minimalConfig: AppConfig = {
      ...productionConfig,
      site: { ...productionConfig.site, enabled: false },
      analytics: { ...productionConfig.analytics, enabled: false },
      storage: { uploadsBucket: false },
      network: {
        ...productionConfig.network,
        endpoints: [],
        natMachineImage: ec2.MachineImage.genericLinux({ [REGION]: 'ami-0123456789abcdef0' }),
      },
    }
    const { application } = createApp(minimalConfig)
    const template = Template.fromStack(application)

    template.resourceCountIs('AWS::CloudFront::Distribution', 0)
    template.resourceCountIs('AWS::S3::Bucket', 0)
    template.resourceCountIs('AWS::EC2::Instance', 0)
    template.resourceCountIs('AWS::RDS::DBInstance', 1)
    template.resourceCountIs('AWS::ECS::Service', 1)
  })

  it('only embeds the configured account and domain', () => {
    const { zone, certificate, registry, network, application } = createApp(allFeaturesConfig)
    const everything = [zone, certificate, registry, network, application]
      .map((stack) => JSON.stringify(Template.fromStack(stack).toJSON()))
      .join('\n')

    const accounts = new Set(everything.match(/\b\d{12}\b/g) ?? [])
    expect([...accounts]).toEqual([ACCOUNT])
    expect(everything).toContain('example.com')
    expect(everything).not.toMatch(/BEGIN (RSA |EC )?PRIVATE KEY/)
  })
})
