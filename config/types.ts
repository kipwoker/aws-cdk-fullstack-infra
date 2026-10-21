import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'

export const STAGES = ['development', 'staging', 'production'] as const
export type Stage = (typeof STAGES)[number]

/**
 * CloudFront only accepts certificates from us-east-1, so both the certificate
 * stack and every CloudFront distribution must agree on this value. Keep it here
 * instead of repeating the literal in the app, the stacks and the scripts.
 */
export const CLOUDFRONT_CERTIFICATE_REGION = 'us-east-1'

/** Used when neither `CDK_REGION` nor `CDK_DEFAULT_REGION` is set. */
export const DEFAULT_REGION = 'eu-west-1'

/**
 * Environment variables the stacks derive themselves. `api.environment` and
 * `api.secrets.env` may not override them, or the container silently loses its
 * database connection or port binding.
 */
export const RESERVED_ENV_KEYS = [
  'PORT',
  'APP_DOMAIN',
  'API_DOMAIN',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USERNAME',
  'DATABASE_PASSWORD',
  'UPLOADS_BUCKET',
  'ANALYTICS_URL',
  'CLICKHOUSE_PASSWORD',
] as const

/** Gateway endpoint services that can be enabled per stage. */
export const VPC_ENDPOINTS = [
  's3',
  'ecr',
  'ecr-docker',
  'ecs',
  'ecs-agent',
  'ecs-telemetry',
  'secrets-manager',
  'cloudwatch-logs',
  'ssm',
  'sts',
  'kms',
  'rds',
] as const
export type VpcEndpoint = (typeof VPC_ENDPOINTS)[number]

export interface DomainConfig {
  /** Apex domain, e.g. `example.com`. Comes from `ROOT_DOMAIN`. */
  readonly rootDomain: string
  /** Reuse an existing Route 53 zone instead of creating one. Comes from `HOSTED_ZONE_ID`. */
  readonly hostedZoneId?: string
}

export interface NetworkConfig {
  readonly maxAzs: number
  readonly subnetCidrMask: number
  /** `fck-nat` is an EC2 NAT instance (~10x cheaper); `gateway` is the managed NAT Gateway. */
  readonly nat: 'fck-nat' | 'gateway'
  /** fck-nat's default AMI is arm64 - keep Graviton instance types (t4g.*). */
  readonly natInstanceType: ec2.InstanceType
  /**
   * Optional fck-nat AMI. By default cdk-fck-nat looks up its arm64 AMI at synth
   * time (cached in cdk.context.json). Provide one for offline/air-gapped synths.
   */
  readonly natMachineImage?: ec2.IMachineImage
  readonly endpoints: VpcEndpoint[]
}

export interface DatabaseConfig {
  /** PostgreSQL engine version, e.g. `rds.PostgresEngineVersion.VER_17_4`. */
  readonly engineVersion: rds.PostgresEngineVersion
  readonly databaseName: string
  /** Master username stored in the generated credentials secret. */
  readonly masterUsername: string
  readonly port: number
  readonly instanceType: ec2.InstanceType
  readonly allocatedStorageGb: number
  readonly deletionProtection: boolean
  readonly backupRetentionDays: number
  readonly multiAz: boolean
}

export interface ApiSecretsConfig {
  /** Import an existing secret ARN instead of creating one. Must be a JSON secret. */
  readonly existingSecretArn?: string
  /** JSON key generated on first deploy when the secret is created by CDK. */
  readonly generatedKey: string
  /** Secret JSON key -> container environment variable. */
  readonly env: Record<string, string>
}

export interface ApiConfig {
  readonly subdomain: string
  readonly containerPort: number
  readonly cpu: number
  readonly memoryMiB: number
  readonly desiredCount: number
  readonly spot: boolean
  readonly healthCheckPath: string
  /** Extra non-secret environment variables for the container. */
  readonly environment: Record<string, string>
  readonly secrets: ApiSecretsConfig
}

export interface SiteConfig {
  readonly enabled: boolean
  /** Empty string serves the site on the apex domain. */
  readonly subdomain: string
  readonly priceClass: 'all' | '100' | '200'
}

export interface StorageConfig {
  /** Create a private S3 bucket for user uploads and expose it as `UPLOADS_BUCKET`. */
  readonly uploadsBucket: boolean
}

export interface AnalyticsConfig {
  readonly enabled: boolean
  readonly subdomain: string
  readonly instanceType: ec2.InstanceType
  /** Root EBS volume size; ClickHouse keeps hot data here and cold data in S3. */
  readonly volumeGb: number
}

export interface DashboardConfig {
  readonly enabled: boolean
  readonly subdomain: string
  readonly instanceType: ec2.InstanceType
  readonly volumeGb: number
  /**
   * CIDR ranges allowed to reach the dashboard. Must not be empty when the
   * dashboard is enabled: the instance is only reachable through its ALB.
   */
  readonly allowedCidrs: string[]
  /** Upstream Redash image. Pin the tag for reproducible hosts. */
  readonly redashImage: string
}

export interface HostImageConfig {
  /** Ubuntu release used for auxiliary EC2 hosts (ClickHouse, dashboard). */
  readonly ubuntuVersion: string
  /** Must match the chosen instance types (t3/t4g, m6g/m7g, ...). */
  readonly architecture: 'x86_64' | 'arm64'
  /** Root device name of the chosen AMI; the EBS volume size is applied here. */
  readonly rootDeviceName: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

export interface AppConfig {
  readonly stage: Stage
  readonly projectName: string
  readonly account: string
  readonly region: string
  readonly domain: DomainConfig
  readonly network: NetworkConfig
  readonly database: DatabaseConfig
  readonly api: ApiConfig
  readonly site: SiteConfig
  readonly storage: StorageConfig
  readonly analytics: AnalyticsConfig
  readonly dashboard: DashboardConfig
  readonly hostImage: HostImageConfig
  /** Keep buckets and databases after `cdk destroy`; false also allows data loss. */
  readonly retainData: boolean
}
