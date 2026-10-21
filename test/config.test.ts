import { loadConfig, parseDotEnv, validateConfig } from '../config'

const baseEnv = {
  CDK_ACCOUNT: '111111111111',
  ROOT_DOMAIN: 'example.com',
}

describe('loadConfig', () => {
  it('loads development defaults', () => {
    const config = loadConfig({ env: { ...baseEnv }, dotEnv: false })

    expect(config.stage).toBe('development')
    expect(config.region).toBe('eu-west-1')
    expect(config.domain.rootDomain).toBe('example.com')
    expect(config.api.subdomain).toBe('api-dev')
    expect(config.retainData).toBe(false)
  })

  it('applies per-stage overrides', () => {
    const config = loadConfig({ stage: 'production', env: { ...baseEnv }, dotEnv: false })

    expect(config.stage).toBe('production')
    expect(config.api.subdomain).toBe('api')
    expect(config.site.subdomain).toBe('')
    expect(config.database.multiAz).toBe(true)
    expect(config.database.deletionProtection).toBe(true)
    expect(config.api.spot).toBe(false)
    expect(config.network.endpoints).toContain('ecr-docker')
    expect(config.retainData).toBe(true)
  })

  it('reads host-related settings from the environment', () => {
    const config = loadConfig({
      env: {
        ...baseEnv,
        CDK_REGION: 'us-west-2',
        HOSTED_ZONE_ID: 'Z0123456789',
        APP_SECRET_ARN: 'arn:aws:secretsmanager:us-west-2:111111111111:secret:app-AbCdEf',
      },
      dotEnv: false,
    })

    expect(config.region).toBe('us-west-2')
    expect(config.domain.hostedZoneId).toBe('Z0123456789')
    expect(config.api.secrets.existingSecretArn).toContain('secret:app-')
  })

  it('normalizes a domain given as a URL', () => {
    const config = loadConfig({
      env: { ...baseEnv, ROOT_DOMAIN: 'https://example.com/' },
      dotEnv: false,
    })

    expect(config.domain.rootDomain).toBe('example.com')
  })

  it('parses .env the way dotenv does', () => {
    const parsed = parseDotEnv(
      [
        '# comment line',
        'ROOT_DOMAIN=example.com  # apex',
        'CDK_ACCOUNT="111111111111" # quoted, comment outside',
        'QUOTED_HASH="a # b"',
        'INLINE_HASH=val#ue',
        '',
      ].join('\r\n'),
    )

    expect(parsed.ROOT_DOMAIN).toBe('example.com')
    expect(parsed.CDK_ACCOUNT).toBe('111111111111')
    expect(parsed.QUOTED_HASH).toBe('a # b')
    // A `#` without leading whitespace stays part of the value.
    expect(parsed.INLINE_HASH).toBe('val#ue')
  })

  it('rejects environment variables the stack owns', () => {
    const config = loadConfig({ env: { ...baseEnv }, dotEnv: false })

    expect(() => validateConfig(config)).not.toThrow()
    expect(() =>
      validateConfig({ ...config, api: { ...config.api, environment: { DATABASE_HOST: 'x' } } }),
    ).toThrow(/DATABASE_HOST/)
    expect(() =>
      validateConfig({ ...config, api: { ...config.api, secrets: { ...config.api.secrets, env: { PORT: 'x' } } } }),
    ).toThrow(/PORT/)
  })

  it('refuses a dashboard with no allowed CIDRs', () => {
    const config = loadConfig({ env: { ...baseEnv }, dotEnv: false })

    expect(() =>
      validateConfig({ ...config, dashboard: { ...config.dashboard, enabled: true, allowedCidrs: [] } }),
    ).toThrow(/allowedCidrs/)
  })

  it('refuses host instance types that contradict hostImage.architecture', () => {
    const config = loadConfig({ env: { ...baseEnv }, dotEnv: false })

    expect(() =>
      validateConfig({ ...config, hostImage: { ...config.hostImage, architecture: 'arm64' } }),
    ).toThrow(/hostImage.architecture/)
  })

  it('fails fast without an account', () => {
    expect(() => loadConfig({ env: { ROOT_DOMAIN: 'example.com' }, dotEnv: false })).toThrow(
      /CDK_ACCOUNT/,
    )
  })

  it('fails fast without a domain', () => {
    expect(() => loadConfig({ env: { CDK_ACCOUNT: '111111111111' }, dotEnv: false })).toThrow(
      /ROOT_DOMAIN/,
    )
  })

  it('rejects unknown stages', () => {
    expect(() => loadConfig({ stage: 'qa', env: { ...baseEnv }, dotEnv: false })).toThrow(
      /Unknown stage/,
    )
  })
})
