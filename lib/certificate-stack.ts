import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as r53 from 'aws-cdk-lib/aws-route53'
import { Construct } from 'constructs'
import { AppConfig } from '../config/types'

export interface CertificateStackProps extends cdk.StackProps {
  readonly config: AppConfig
  readonly hostedZoneId: string
}

/**
 * Wildcard certificate for `ROOT_DOMAIN` and `*.ROOT_DOMAIN` in us-east-1.
 *
 * CloudFront only accepts certificates from us-east-1. The apex + wildcard SANs
 * cover every single-label subdomain used by the app and API Gateway.
 *
 * This stack needs the domain delegated to the zone created by `ZoneStack`.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificateArn: string

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props)

    const { rootDomain } = props.config.domain

    const hostedZone = r53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: rootDomain,
    })

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: rootDomain,
      subjectAlternativeNames: [`*.${rootDomain}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    })

    this.certificateArn = certificate.certificateArn
    new cdk.CfnOutput(this, 'CertificateArn', { value: certificate.certificateArn })
  }
}
