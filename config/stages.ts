import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import { AppConfig, DeepPartial, DomainConfig, Stage } from './types'

/** Everything except the values that come from the environment. */
export type BaseConfig = Omit<AppConfig, 'stage' | 'account' | 'region' | 'domain'> & {
  readonly domain: Omit<DomainConfig, 'rootDomain'>
}

export const defaultConfig: BaseConfig = {
  projectName: 'fullstack',
  retainData: false,

  domain: {},

  network: {
    maxAzs: 2,
    subnetCidrMask: 24,
    // fck-nat replaces the managed NAT Gateway with a tiny EC2 instance (~10x cheaper).
    nat: 'fck-nat',
    natInstanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.NANO),
    // Interface endpoints cost ~$7/AZ/month, so dev only routes through NAT.
    endpoints: ['s3'],
  },

  database: {
    // Pinned explicitly: `PostgresEngineVersion.VER_17_4` in aws-cdk-lib 2.181 is
    // already deprecated by RDS, which refuses to create new instances on it.
    engineVersion: rds.PostgresEngineVersion.of('17.7', '17'),
    databaseName: 'app',
    masterUsername: 'app',
    port: 5432,
    // RDS has no db.t4g.micro; the smallest Graviton instance is db.t4g.medium.
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MEDIUM),
    allocatedStorageGb: 20,
    deletionProtection: false,
    backupRetentionDays: 1,
    multiAz: false,
  },

  api: {
    subdomain: 'api',
    containerPort: 8080,
    cpu: 256,
    memoryMiB: 512,
    desiredCount: 1,
    // Fargate Spot is ~70% cheaper and fine for anything but production traffic.
    spot: true,
    healthCheckPath: '/health',
    environment: {},
    secrets: {
      generatedKey: 'encryption_key',
      env: {
        ENCRYPTION_KEY: 'encryption_key',
      },
    },
  },

  site: {
    enabled: true,
    // Empty string serves the frontend on the apex domain.
    subdomain: '',
    priceClass: '100',
  },

  storage: {
    uploadsBucket: true,
  },

  analytics: {
    enabled: true,
    subdomain: 'clickhouse',
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
    volumeGb: 20,
  },

  dashboard: {
    enabled: false,
    subdomain: 'dash',
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
    volumeGb: 20,
    // Fail closed: set your office/VPN range before enabling the dashboard.
    allowedCidrs: [],
    // Pin a release tag for reproducible hosts: https://hub.docker.com/r/redash/redash/tags
    redashImage: 'redash/redash:latest',
  },

  hostImage: {
    ubuntuVersion: '22.04',
    architecture: 'x86_64',
    // Root device of the Canonical Ubuntu AMIs; the EBS volume size is applied here.
    rootDeviceName: '/dev/sda1',
  },
}

/** Per-stage overrides, merged on top of `defaultConfig`. */
export const STAGE_OVERRIDES: Record<Stage, DeepPartial<BaseConfig>> = {
  development: {
    // Single-label prefixes stay inside the `*.example.com` certificate.
    api: { subdomain: 'api-dev' },
    site: { subdomain: 'dev' },
    analytics: { subdomain: 'clickhouse-dev' },
    dashboard: { subdomain: 'dash-dev' },
  },

  staging: {
    api: { subdomain: 'api-staging' },
    site: { subdomain: 'staging' },
    analytics: {
      subdomain: 'clickhouse-staging',
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MEDIUM),
      volumeGb: 50,
    },
    database: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.SMALL),
      allocatedStorageGb: 50,
      backupRetentionDays: 7,
    },
    retainData: true,
  },

  production: {
    network: {
      // Keep image pulls, secrets and logs inside the VPC in production.
      endpoints: ['s3', 'ecr', 'ecr-docker', 'secrets-manager', 'cloudwatch-logs', 'ssm', 'rds'],
    },
    database: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MEDIUM),
      allocatedStorageGb: 200,
      deletionProtection: true,
      backupRetentionDays: 14,
      multiAz: true,
    },
    api: {
      cpu: 512,
      memoryMiB: 1024,
      desiredCount: 2,
      spot: false,
    },
    site: {
      priceClass: 'all',
    },
    analytics: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.LARGE),
      volumeGb: 100,
    },
    dashboard: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MEDIUM),
      volumeGb: 50,
    },
    retainData: true,
  },
}
