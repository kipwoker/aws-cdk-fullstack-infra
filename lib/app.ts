import { App, Tags } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { loadConfig } from '../config'
import { AppConfig, CLOUDFRONT_CERTIFICATE_REGION } from '../config/types'
import { ApplicationStack } from './application-stack'
import { CertificateStack } from './certificate-stack'
import { NetworkStack } from './network-stack'
import { RegistryStack } from './registry-stack'
import { ZoneStack } from './zone-stack'

export interface AssembleOptions {
  /** Use a pre-resolved config (offline synth, tests) instead of loading env. */
  readonly config?: AppConfig
}

/**
 * Set to `1` for synth/deploy without AWS lookups: the offline synth and the
 * fakecloud run both use it. Real deployments must leave it unset.
 */
export const OFFLINE_ENV_VAR = 'CDK_OFFLINE'

const OFFLINE_AZ_SUFFIXES = ['a', 'b', 'c']
/** Only used when fck-nat would otherwise look its AMI up at synth time. */
const PLACEHOLDER_NAT_AMI = 'ami-0123456789abcdef0'

/**
 * Seeds the context `cdk synth` would normally fetch from AWS, so the same
 * templates can be built on a laptop with no credentials.
 */
export function applyOfflineDefaults(app: App, config: AppConfig): AppConfig {
  app.node.setContext(
    `availability-zones:account=${config.account}:region=${config.region}`,
    OFFLINE_AZ_SUFFIXES.map((suffix) => `${config.region}${suffix}`),
  )

  if (config.network.nat !== 'fck-nat' || config.network.natMachineImage) return config
  return {
    ...config,
    network: {
      ...config.network,
      natMachineImage: ec2.MachineImage.genericLinux({ [config.region]: PLACEHOLDER_NAT_AMI }),
    },
  }
}

/**
 * Builds every stack in deploy order. Shared by `bin/app.ts`, the offline synth
 * and the fakecloud run, so they always describe the same infrastructure.
 */
export function assembleStacks(app: App, options: AssembleOptions = {}): AppConfig {
  const resolved = options.config ?? loadConfig({ stage: app.node.tryGetContext('stage') })
  const config = process.env[OFFLINE_ENV_VAR] === '1' ? applyOfflineDefaults(app, resolved) : resolved

  const env = { account: config.account, region: config.region }
  // CloudFront only accepts certificates from us-east-1; the value lives in config/types.ts.
  const certificateEnv = { account: config.account, region: CLOUDFRONT_CERTIFICATE_REGION }
  const stageSuffix = `-${config.stage}`

  // Shared per root domain - deploy once, then every stage reuses it.
  const zoneStack = new ZoneStack(app, `${config.projectName}-zone`, {
    env: certificateEnv,
    crossRegionReferences: true,
    description: 'Route 53 hosted zone',
    config,
  })

  const certificateStack = new CertificateStack(app, `${config.projectName}-certificate`, {
    env: certificateEnv,
    crossRegionReferences: true,
    description: `CloudFront wildcard certificate (${CLOUDFRONT_CERTIFICATE_REGION})`,
    config,
    hostedZoneId: zoneStack.hostedZoneId,
  })
  certificateStack.addDependency(zoneStack)

  // The repository exists before the API service so the first image can be pushed.
  const registryStack = new RegistryStack(app, `${config.projectName}-registry${stageSuffix}`, {
    env,
    description: 'ECR repository for the API image',
    config,
  })

  const networkStack = new NetworkStack(app, `${config.projectName}-network${stageSuffix}`, {
    env,
    description: 'VPC, subnets, NAT and VPC endpoints',
    config,
  })
  networkStack.addDependency(zoneStack)

  const applicationStack = new ApplicationStack(app, `${config.projectName}-app${stageSuffix}`, {
    env,
    crossRegionReferences: true,
    description: 'Database, API, frontend and analytics',
    config,
    vpc: networkStack.vpc,
    repository: registryStack.repository,
    hostedZoneId: zoneStack.hostedZoneId,
    certificateArn: certificateStack.certificateArn,
  })
  applicationStack.addDependency(networkStack)
  applicationStack.addDependency(certificateStack)
  applicationStack.addDependency(registryStack)

  Tags.of(app).add('Project', config.projectName)
  Tags.of(app).add('Stage', config.stage)
  Tags.of(app).add('ManagedBy', 'aws-cdk')

  return config
}
