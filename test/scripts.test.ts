import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/**
 * Runs the deploy scripts' shared helpers against temporary files. No AWS
 * account, no deployment: this is the offline check that the stage scoping and
 * the `.env` parsing behave like `config/index.ts`.
 */
const SCRIPTS = [
  'lib.sh',
  'bootstrap.sh',
  'cfn-lint.sh',
  'deploy-demo.sh',
  'deploy-site.sh',
  'fakecloud.sh',
  'push-image.sh',
]
const projectRoot = resolve(__dirname, '..')
const libPath = join(projectRoot, 'scripts', 'lib.sh').replace(/\\/g, '/')

/** Variables the tests both set and must not inherit from the parent shell. */
const ISOLATED = ['CDK_STAGE', 'CDK_OUTPUTS_FILE', 'CDK_REGION', 'CDK_ACCOUNT', 'CDK_DEFAULT_REGION']

function isolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (ISOLATED.includes(key) || key === 'ROOT_DOMAIN') delete env[key]
  }
  return { ...env, ...overrides }
}

function bash(script: string, cwd: string, env: NodeJS.ProcessEnv = isolatedEnv()): string {
  return execFileSync('bash', ['-c', script], { cwd, env, encoding: 'utf8' }).trim()
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'fullstack-scripts-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('deploy scripts', () => {
  it('are syntactically valid', () => {
    for (const file of SCRIPTS) {
      expect(() => execFileSync('bash', ['-n', join(projectRoot, 'scripts', file)])).not.toThrow()
    }
    // The S3 rewrite proxy is plain Node, so its syntax check is Node's own.
    expect(() =>
      execFileSync('node', ['--check', join(projectRoot, 'scripts', 's3-path-proxy.js')]),
    ).not.toThrow()
  })

  it('read .env values the way config/index.ts does', () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, '.env'),
        [
          '# comment',
          'ROOT_DOMAIN=example.com  # apex domain',
          'CDK_STAGE=staging',
          'QUOTED="a # b"',
          '',
        ].join('\n'),
      )

      const output = bash(
        `. "${libPath}" && load_env && printf '%s|%s|%s' "$ROOT_DOMAIN" "$CDK_STAGE" "$QUOTED"`,
        dir,
      )

      expect(output).toBe('example.com|staging|a # b')
    })
  })

  it('never reads another stage\u2019s outputs file', () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, 'cdk-outputs.development.json'),
        JSON.stringify({ 'fullstack-app-development': { ApiUrl: 'https://dev.example.com' } }),
      )
      writeFileSync(
        join(dir, 'cdk-outputs.production.json'),
        JSON.stringify({ 'fullstack-app-production': { ApiUrl: 'https://api.example.com' } }),
      )

      const read = (stage?: string) =>
        bash(
          `. "${libPath}" && stack_output ApiUrl`,
          dir,
          isolatedEnv(stage ? { CDK_STAGE: stage } : {}),
        )

      expect(read('development')).toBe('https://dev.example.com')
      expect(read('production')).toBe('https://api.example.com')
      // Deploy scripts default to development, so a missing stage must not fall
      // back to production.
      expect(read()).toBe('https://dev.example.com')
    })
  })

  it('treats a missing output as empty instead of failing', () => {
    withTempDir((dir) => {
      const output = bash(`. "${libPath}" && stack_output SiteUrl; echo "rc=$?"`, dir)
      expect(output).toBe('rc=0')
    })
  })
})
