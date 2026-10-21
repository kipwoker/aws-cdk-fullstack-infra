import * as cdk from 'aws-cdk-lib'
import * as r53 from 'aws-cdk-lib/aws-route53'
import { Construct } from 'constructs'
import { AppConfig } from '../config/types'

export interface ZoneStackProps extends cdk.StackProps {
  readonly config: AppConfig
}

/**
 * Route 53 hosted zone only - no certificate.
 *
 * Keeping the zone separate means the first deploy finishes in seconds, so you
 * can copy the `NameServers` output to your registrar before any certificate
 * validation runs.
 *
 * Reusing an existing zone? Set `HOSTED_ZONE_ID` and this stack imports it.
 */
export class ZoneStack extends cdk.Stack {
  public readonly hostedZoneId: string

  constructor(scope: Construct, id: string, props: ZoneStackProps) {
    super(scope, id, props)

    const { rootDomain, hostedZoneId } = props.config.domain

    let hostedZone: r53.IPublicHostedZone
    let nameServers: string[] | undefined

    if (hostedZoneId) {
      hostedZone = r53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId,
        zoneName: rootDomain,
      })
    } else {
      const zone = new r53.PublicHostedZone(this, 'HostedZone', {
        zoneName: rootDomain,
        comment: `Managed by ${props.config.projectName} (${props.config.stage})`,
      })
      hostedZone = zone
      nameServers = zone.hostedZoneNameServers
    }

    this.hostedZoneId = hostedZone.hostedZoneId

    new cdk.CfnOutput(this, 'HostedZoneId', { value: hostedZone.hostedZoneId })
    if (nameServers) {
      new cdk.CfnOutput(this, 'NameServers', {
        value: cdk.Fn.join(', ', nameServers),
        description: 'Point your registrar NS records here before deploying everything else',
      })
    }
  }
}
