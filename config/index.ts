import * as fs from 'fs'
import * as path from 'path'
import { defaultConfig, STAGE_OVERRIDES } from './stages'
import { AppConfig, DEFAULT_REGION, DeepPartial, RESERVED_ENV_KEYS, STAGES, Stage } from './types'

export { STAGES } from './types'
export type { Stage } from './types'

export interface LoadConfigOptions {
  /** Pass `cdk deploy -c stage=production` to override `CDK_STAGE`. */
  readonly stage?: unknown
  readonly env?: NodeJS.ProcessEnv
  /** Disable `.env` loading (used by tests). */
  readonly dotEnv?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function deepMerge<T extends object>(base: T, override?: DeepPartial<T>): T {
  if (!override) return base
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return result as T
}

/**
 * Reads a value the way dotenv does: quoted values keep their content (including
 * `#`), unquoted values end at the first ` #` comment marker.
 */
function parseDotEnvValue(rawValue: string): string {
  const value = rawValue.trim()
  const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(value)
  if (quoted) return quoted[2]
  return value.replace(/\s+#.*$/, '').trim()
}

/** Parses `.env` contents so the project works without extra dependencies. */
export function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const [, key, rawValue] = match
    values[key] = parseDotEnvValue(rawValue)
  }
  return values
}

/** Minimal `.env` loader; real environment variables always win. */
function loadDotEnv(env: NodeJS.ProcessEnv): void {
  const file = path.join(process.cwd(), '.env')
  if (!fs.existsSync(file)) return
  for (const [key, value] of Object.entries(parseDotEnv(fs.readFileSync(file, 'utf8')))) {
    if (env[key] !== undefined) continue
    env[key] = value
  }
}

function parseStage(value: unknown): Stage {
  const stage = value ?? 'development'
  if (typeof stage !== 'string' || !(STAGES as readonly string[]).includes(stage)) {
    throw new Error(`Unknown stage "${String(stage)}". Expected one of: ${STAGES.join(', ')}.`)
  }
  return stage as Stage
}

function requireValue(value: string | undefined, name: string, hint: string): string {
  if (!value) {
    throw new Error(`Missing ${name}. ${hint}`)
  }
  return value
}

/**
 * Resolves the app configuration from (in order):
 * defaults -> per-stage overrides -> environment variables.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env
  if (options.dotEnv !== false) {
    loadDotEnv(env)
  }

  const stage = parseStage(options.stage ?? env.CDK_STAGE)
  const account = requireValue(
    env.CDK_ACCOUNT ?? env.CDK_DEFAULT_ACCOUNT,
    'CDK_ACCOUNT',
    'Copy .env.example to .env and set your 12-digit AWS account ID.',
  )
  const rootDomain = requireValue(
    env.ROOT_DOMAIN,
    'ROOT_DOMAIN',
    'Set it in .env, e.g. ROOT_DOMAIN=example.com.',
  )
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(rootDomain)) {
    throw new Error(`ROOT_DOMAIN "${rootDomain}" is not a valid domain name.`)
  }

  const merged = deepMerge(defaultConfig, STAGE_OVERRIDES[stage])

  const config: AppConfig = {
    ...merged,
    stage,
    account,
    region: env.CDK_REGION ?? env.CDK_DEFAULT_REGION ?? DEFAULT_REGION,
    domain: {
      ...merged.domain,
      rootDomain,
      hostedZoneId: env.HOSTED_ZONE_ID || merged.domain.hostedZoneId,
    },
    api: {
      ...merged.api,
      secrets: {
        ...merged.api.secrets,
        existingSecretArn: env.APP_SECRET_ARN || merged.api.secrets.existingSecretArn,
      },
    },
  }

  validateConfig(config)
  return config
}

/**
 * Rejects combinations that would only fail during (or after) a deploy.
 * Runs on every synth, so mistakes surface before any AWS call is made.
 */
export function validateConfig(config: AppConfig): void {
  const reserved = new Set<string>(RESERVED_ENV_KEYS)

  for (const key of Object.keys(config.api.environment)) {
    if (reserved.has(key)) {
      throw new Error(
        `api.environment may not set ${key}: the stack derives it from the database, bucket or API itself.`,
      )
    }
  }
  for (const key of Object.keys(config.api.secrets.env)) {
    if (reserved.has(key)) {
      throw new Error(
        `api.secrets.env may not map ${key}: the stack derives it from the database, bucket or API itself.`,
      )
    }
  }

  if (config.dashboard.enabled && config.dashboard.allowedCidrs.length === 0) {
    throw new Error(
      'dashboard.enabled needs dashboard.allowedCidrs (your office or VPN range) in config/stages.ts.',
    )
  }

  const hosts = [
    { name: 'analytics', enabled: config.analytics.enabled, instanceType: config.analytics.instanceType },
    { name: 'dashboard', enabled: config.dashboard.enabled, instanceType: config.dashboard.instanceType },
  ]
  for (const host of hosts) {
    if (!host.enabled) continue
    const architecture = String(host.instanceType.architecture)
    if (architecture !== config.hostImage.architecture) {
      throw new Error(
        `hostImage.architecture is "${config.hostImage.architecture}" but the ${host.name} instance type ${host.instanceType} is "${architecture}". They must match, or the instance will not launch.`,
      )
    }
  }
}

/** Builds `api.example.com`, or the apex when `subdomain` is empty. */
export function domainName(subdomain: string, rootDomain: string): string {
  return subdomain ? `${subdomain}.${rootDomain}` : rootDomain
}

