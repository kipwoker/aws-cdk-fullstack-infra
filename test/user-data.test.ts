import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { instanceMemoryGiB } from '../lib/host-image'
import { renderUserData } from '../lib/user-data'

describe('instanceMemoryGiB', () => {
  it('maps size suffixes to RAM', () => {
    expect(instanceMemoryGiB(ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL))).toBe(2)
    expect(instanceMemoryGiB(ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.LARGE))).toBe(8)
    expect(
      instanceMemoryGiB(ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO)),
    ).toBe(1)
  })

  it('refuses instance types it cannot size', () => {
    expect(() => instanceMemoryGiB(new ec2.InstanceType('t3.metal'))).toThrow(/Unknown memory/)
  })
})

describe('renderUserData', () => {
  const clickhouseValues = {
    REGION: 'eu-west-1',
    BUCKET: 'clickhouse-storage',
    HTTP_PORT: '8123',
    SECRET_ARN: 'arn:aws:secretsmanager:eu-west-1:111111111111:secret:clickhouse-AbCdEf',
    MAX_MEMORY_BYTES: '3221225472',
    CACHE_SIZE: '4Gi',
  }

  it('resolves every placeholder in the ClickHouse script', () => {
    const script = renderUserData('clickhouse.sh', clickhouseValues)

    expect(script).not.toContain('{{')
    expect(script).toContain('<max_memory_usage>3221225472</max_memory_usage>')
    expect(script).toContain('<max_size>4Gi</max_size>')
    expect(script).toContain('https://s3.eu-west-1.amazonaws.com/clickhouse-storage/')
    // Password comes from Secrets Manager at boot, never from user-data.
    expect(script).toContain('secretsmanager get-secret-value')
    expect(script).toContain(clickhouseValues.SECRET_ARN)
  })

  it('fails loudly when a placeholder is left unresolved', () => {
    expect(() => renderUserData('clickhouse.sh', {})).toThrow(/Unresolved user-data placeholders/)
  })

  it('pins the Redash image from config', () => {
    const script = renderUserData('dashboard.sh', { REDASH_IMAGE: 'redash/redash:10.1.0' })

    expect(script.match(/redash\/redash:10\.1\.0/g)).toHaveLength(3)
    expect(script).not.toContain('redash/redash:latest')
  })
})
