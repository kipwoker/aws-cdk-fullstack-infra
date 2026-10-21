import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as r53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { AppConfig } from '../../config/types'

export interface StaticSiteProps {
  readonly config: AppConfig
  readonly hostedZone: r53.IHostedZone
  readonly certificate: acm.ICertificate
  readonly domainName: string
}

const PRICE_CLASSES: Record<AppConfig['site']['priceClass'], cloudfront.PriceClass> = {
  all: cloudfront.PriceClass.PRICE_CLASS_ALL,
  '100': cloudfront.PriceClass.PRICE_CLASS_100,
  '200': cloudfront.PriceClass.PRICE_CLASS_200,
}

/**
 * SPA routing at the edge: extension-less paths get the shell, real files are
 * left alone. Mapping 403/404 to index.html instead would serve HTML with a 200
 * for a missing `/assets/<hash>.js`, which browsers report as a broken module
 * and CDN logs no longer attribute to the deploy.
 */
const SPA_FALLBACK_CODE = `function handler(event) {
  var request = event.request\n  var uri = request.uri\n  if (uri.endsWith('/')) {\n    request.uri = uri + 'index.html'\n    return request\n  }\n  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1)\n  if (lastSegment.indexOf('.') === -1) {\n    request.uri = '/index.html'\n  }\n  return request\n}`

/**
 * Private S3 bucket served through CloudFront (OAC), with SPA routing fallback.
 * Deploy files with: `aws s3 sync ./dist s3://<bucket> --delete`
 */
export class StaticSite extends Construct {
  public readonly bucket: s3.Bucket
  public readonly distribution: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id)

    const { config } = props

    this.bucket = new s3.Bucket(this, 'Assets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.retainData,
    })

    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket)

    const spaFallback = new cloudfront.Function(this, 'SpaFallback', {
      comment: 'Serve index.html for client-side routes only',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(SPA_FALLBACK_CODE),
    })

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      priceClass: PRICE_CLASSES[config.site.priceClass],
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: spaFallback, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/assets/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        // The shell must never be stale after a deploy.
        '/index.html': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
      domainNames: [props.domainName],
      certificate: props.certificate,
    })

    new r53.ARecord(this, 'AliasRecord', {
      zone: props.hostedZone,
      recordName: props.domainName,
      target: r53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    })
  }
}
