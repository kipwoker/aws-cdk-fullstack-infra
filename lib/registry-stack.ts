import * as cdk from 'aws-cdk-lib'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import { Construct } from 'constructs'
import { AppConfig } from '../config/types'

/** Images kept in ECR; `latest` is always replaced, older builds fall off. */
const IMAGE_RETENTION_COUNT = 10

export interface RegistryStackProps extends cdk.StackProps {
  readonly config: AppConfig
}

/**
 * The API image repository, deployed before the application stack.
 *
 * Splitting it out removes the chicken-and-egg of "the service needs an image,
 * the repository does not exist yet": push first, then deploy the service.
 */
export class RegistryStack extends cdk.Stack {
  public readonly repository: ecr.Repository

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props)

    const { config } = props

    this.repository = new ecr.Repository(this, 'Api', {
      repositoryName: `${config.projectName}/${config.stage}/api`,
      imageScanOnPush: true,
      removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        { description: `Keep the last ${IMAGE_RETENTION_COUNT} images`, maxImageCount: IMAGE_RETENTION_COUNT },
      ],
    })

    new cdk.CfnOutput(this, 'RepositoryUri', { value: this.repository.repositoryUri })
    new cdk.CfnOutput(this, 'RepositoryName', { value: this.repository.repositoryName })
  }
}
