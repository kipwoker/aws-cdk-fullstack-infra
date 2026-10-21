/**
 * Synthesizes every stack into `cdk.out/` without AWS credentials or lookups.
 *
 * `cdk synth` resolves availability zones and the fck-nat AMI through AWS APIs,
 * which fails on a laptop without credentials and in CI. This script uses the
 * same offline defaults the tests and the fakecloud run use, then writes the
 * real templates so `cfn-lint` (or a diff review) can inspect them offline.
 *
 *   npm run synth:offline
 *   npm run lint:cfn
 */
import { App } from 'aws-cdk-lib'
import { existsSync, readFileSync } from 'fs'
import { loadConfig, parseDotEnv } from '../config'
import { assembleStacks, OFFLINE_ENV_VAR } from '../lib/app'

const OUTPUT_DIR = 'cdk.out'
/** Template shape does not depend on the account or domain, so these are safe. */
const PLACEHOLDER_ACCOUNT = '111111111111'
const PLACEHOLDER_DOMAIN = 'example.com'

const loaded = existsSync('.env') ? parseDotEnv(readFileSync('.env', 'utf8')) : {}
const env: NodeJS.ProcessEnv = { ...loaded, ...process.env }
const usingPlaceholders = !env.CDK_ACCOUNT && !env.CDK_DEFAULT_ACCOUNT
if (usingPlaceholders) env.CDK_ACCOUNT = PLACEHOLDER_ACCOUNT
if (!env.ROOT_DOMAIN) env.ROOT_DOMAIN = PLACEHOLDER_DOMAIN

process.env[OFFLINE_ENV_VAR] = '1'

const app = new App({ outdir: OUTPUT_DIR })
const config = loadConfig({ stage: process.env.CDK_STAGE, env, dotEnv: false })
assembleStacks(app, { config })

const assembly = app.synth()
console.log(`Synthesized ${assembly.stacks.map((stack) => stack.stackName).join(', ')} into ${OUTPUT_DIR}/`)
if (usingPlaceholders) {
  console.log(`No CDK_ACCOUNT in the environment or .env: built with the placeholder ${PLACEHOLDER_ACCOUNT}.`)
}
