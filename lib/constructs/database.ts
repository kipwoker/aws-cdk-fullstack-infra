import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import { AppConfig } from '../../config/types'

export interface DatabaseProps {
  readonly config: AppConfig
  readonly vpc: ec2.IVpc
  readonly securityGroup: ec2.ISecurityGroup
}

/** Single PostgreSQL instance with generated credentials in Secrets Manager. */
export class Database extends Construct {
  public readonly instance: rds.DatabaseInstance

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id)

    const { config } = props
    const { database } = config

    this.instance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: database.engineVersion }),
      instanceType: database.instanceType,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      databaseName: database.databaseName,
      port: database.port,
      credentials: rds.Credentials.fromGeneratedSecret(database.masterUsername),
      allocatedStorage: database.allocatedStorageGb,
      storageEncrypted: true,
      multiAz: database.multiAz,
      backupRetention: cdk.Duration.days(database.backupRetentionDays),
      deletionProtection: database.deletionProtection,
      removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
    })
  }

  public get secret(): secretsmanager.ISecret {
    if (!this.instance.secret) {
      throw new Error('Database credentials secret is missing.')
    }
    return this.instance.secret
  }

  public connection(config: AppConfig) {
    return {
      host: this.instance.dbInstanceEndpointAddress,
      port: this.instance.dbInstanceEndpointPort,
      name: config.database.databaseName,
    }
  }
}
