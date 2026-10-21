# AGENTS.md

Playbook for coding agents working in this repository, and for starting a **new** project from it.
Read this before touching a stack, a construct or `config/`.

---

## Mental model

- **Five stacks, one direction of dependency:**
  `zone` (us-east-1, Route 53) → `certificate` (us-east-1, wildcard ACM); `network` (VPC, NAT, endpoints) and `registry` (ECR) feed `app-<stage>` (everything else).
  The zone is split from the certificate on purpose: the zone deploys in seconds, so NS delegation can happen before certificate validation starts. The registry is split out so an image exists before the API service is created.
- **`config/` is the only source of truth.** `config/types.ts` is the contract, `config/stages.ts` holds defaults and per-stage overrides, `config/index.ts` merges `.env` + environment variables and validates them.
- **Stacks wire constructs; constructs own resources.** `lib/application-stack.ts` should stay readable — new service types belong in `lib/constructs/`.
- **One command deploys the sample.** `npm run deploy:demo` = registry → push `examples/api` → all stacks → build/upload `examples/web`. It writes `cdk-outputs.<stage>.json`, which every helper script reads.

## Hard rules

1. **No hardcoded environment data.** Account IDs, domains, regions, AMI IDs, bucket names, chat IDs, IPs and secret values never appear in stack or construct code. They belong in `.env` (environment-specific) or `config/stages.ts` (typed defaults/overrides).
2. **Secrets stay in Secrets Manager.** Use `ecs.Secret.fromSecretsManager`; never render a secret into a template, user-data or an output.
3. **Certificate regions matter.** CloudFront only accepts `us-east-1` certificates (`certificate` stack). ALBs and API Gateway need a certificate in their own region (`RegionalCertificate` in `application-stack.ts`). Do not reuse the CloudFront ARN for them.
4. **Wildcards cover one label.** `*.example.com` matches `api.example.com`, not `api.dev.example.com`. Stage subdomains must stay single-label (`api-dev`, `dev`, `clickhouse-dev`).
5. **One public entrance per layer.** Users reach CloudFront, API Gateway and (optionally) the dashboard ALB only. The API ALB stays `internetFacing: false`, the VPC link is its only client, and ClickHouse stays on an internal ALB. Every listener created with an explicit security group must pass `open: false` — CDK's default opens the port to `0.0.0.0/0`. No SSH, no key pairs — SSM Session Manager only.
6. **fck-nat defaults to an arm64 AMI.** Keep `natInstanceType` Graviton (`t4g.*`) or provide `network.natMachineImage`. Do not silently switch to x86.
7. **Data retention is opt-in.** `retainData` and `database.deletionProtection` default to safe values; never weaken them without an explicit request.
8. **Do not add dependencies casually.** `.env` parsing, AMI lookup and user-data templating are already dependency-free. Check `package.json` before introducing a package.
9. **Every change keeps synth offline-capable.** Tests synthesize all stacks without AWS calls (AZ context + `natMachineImage`). Preserve that.
10. **Scripts derive, never hardcode.** Repository, bucket, distribution, cluster and service come from stack outputs (`cdk-outputs.<stage>.json`) or env overrides. One outputs file per stage, so a run for one stage can never read another stage's resources. Do not reintroduce literal bucket names, account IDs or distribution IDs in `scripts/`.

## Repo map

| Path | Responsibility |
| --- | --- |
| `bin/app.ts` | CDK entry point (delegates to `lib/app.ts`) |
| `lib/app.ts` | Stack assembly, order, tags — shared with the offline synth and fakecloud |
| `config/types.ts` | Typed configuration surface (`AppConfig`) |
| `config/stages.ts` | Defaults + `development` / `staging` / `production` overrides |
| `config/index.ts` | `.env` loader, env overrides, validation |
| `lib/zone-stack.ts` | Hosted zone (new or imported), outputs name servers |
| `lib/certificate-stack.ts` | Apex + wildcard certificate in us-east-1 |
| `lib/registry-stack.ts` | ECR repository for the API image |
| `lib/network-stack.ts` | VPC, subnets, fck-nat/NAT Gateway, VPC endpoints |
| `lib/application-stack.ts` | Security groups, secrets, construct wiring, outputs |
| `lib/constructs/` | `database`, `api-service`, `static-site`, `analytics`, `dashboard` |
| `lib/user-data/` | ClickHouse and Redash cloud-init scripts (`{{PLACEHOLDER}}` templates) |
| `examples/api` | Sample Node API + Dockerfile (what `push-image` builds) |
| `examples/web` | Sample React + Vite frontend (built with `VITE_API_URL`) |
| `test/` | Config tests + offline synth tests |
| `scripts/` | `deploy-demo.sh`, `push-image.sh`, `deploy-site.sh`, `bootstrap.sh`, shared `lib.sh` |

## Start a new project from this bootstrap

1. **Copy, don't fork history:** copy the folder (or `degit`) into a new repo, then `git init`.
2. **Rename the project:** `projectName` in `config/stages.ts` controls stack names, ECR paths and tags. Update `package.json`, `README.md` title and the MIT copyright line too.
3. **Set the environment:** `cp .env.example .env`, fill `CDK_ACCOUNT`, `ROOT_DOMAIN`, optionally `CDK_REGION` / `HOSTED_ZONE_ID`.
4. **Verify locally:** `npm install && npm run build && npm test`. Everything must pass before any AWS call.
5. **Bootstrap:** `npm run bootstrap` (app region + `us-east-1`).
6. **Deploy the zone first when it is new:**
   `npx cdk deploy <projectName>-zone` → copy the `NameServers` output into the registrar.
   With an existing zone in `HOSTED_ZONE_ID`, skip this.
7. **Deploy the whole sample:** `npm run deploy:demo`. It deploys the registry, pushes `examples/api`, deploys certificate/network/app, builds `examples/web` with the API URL and uploads it.
8. **Point the API at your own image:** `npm run push-image -- <docker-context> <tag>`. The script derives the repository from `cdk-outputs.<stage>.json` and rolls the ECS service.
9. **Verify the stack:** `curl <ApiUrl>/health`, open `<SiteUrl>`, check `aws ecs describe-services` for a stable service. ClickHouse is internal — verify it through the API or `aws ssm start-session`.
10. **Write down deviations** in `README.md`; the next agent inherits only what is documented.

## Common tasks

| Task | Change |
| --- | --- |
| Resize / rescale a stage | `config/stages.ts` (`instanceType`, `allocatedStorageGb`, `cpu`, `desiredCount`) |
| Add an env var for the API | `config/stages.ts` → `api.environment` |
| Expose another secret key | `api.secrets.env` + `aws secretsmanager put-secret-value` |
| Add a VPC endpoint | `VPC_ENDPOINTS` in `config/types.ts`, map it in `lib/network-stack.ts`, add to `network.endpoints` |
| Enable the BI dashboard | `dashboard.enabled: true` + a non-empty `dashboard.allowedCidrs` (synth fails otherwise) |
| Change the image the service runs | `npm run push-image -- <context> <tag>` (the service always pulls `latest`) |
| Pin the Redash image | `dashboard.redashImage` in `config/stages.ts` |
| Deploy the sample apps | `npm run deploy:demo` (`-- --skip-infra` for frontend only) |
| Add a new AWS service | New construct in `lib/constructs/`, wire it in `lib/application-stack.ts`, cover it in `test/stacks.test.ts` |
| Add a stage | `STAGES` in `config/types.ts` + entry in `STAGE_OVERRIDES` + unique subdomains |

## Verification

```bash
npm run validate                     # tsc + jest + a real offline synth into cdk.out/
npm run lint:cfn                     # cfn-lint over the synthesized templates
npm run validate:fakecloud           # deploy all five stacks into fakecloud (real ECS/RDS)
npm --prefix examples/web run build  # sample frontend compiles
```

- Do **not** run `cdk deploy`, `cdk destroy` or any mutating AWS command unless the human explicitly asked for it.
- `cdk.context.json` and `cdk.out/` are git-ignored and environment-specific; never commit them.
- A stack is not "done" because it compiles: synth it, assert the resources, and report what you actually ran.

## Pitfalls

- **Certificate validation needs delegation.** Deploying the certificate before the registrar's NS records point at the zone leaves the stack waiting for validation. Keep `zone` and `certificate` separate.
- **Empty ECR repo + `desiredCount > 0`** = ECS service never stabilizes. That is why the repository lives in `registry` and `deploy:demo` pushes before deploying `app`. Do not merge the registry back into the app stack.
- **`cdk-outputs.<stage>.json`** is git-ignored but required by the helper scripts. `cdk deploy` must run with `--outputs-file cdk-outputs.<stage>.json` (the npm scripts already do); one shared file lets one stage's bucket or cluster leak into another stage's deploy.
- **`latest` + force deployment:** the service always pulls `:latest`; `push-image.sh` pushes both the version tag and `:latest` and triggers `--force-new-deployment`, so new tasks pick up the new image. Changing a tag in config alone would deploy a tag nobody pushed.
- **`fakecloud` needs two adapters.** CDK publishes assets virtual-hosted while fakecloud parses path-style only (`scripts/s3-path-proxy.js`), and the CDK CLI's on-disk account cache can keep a stale `test -> 000000000000` mapping from LocalStack (`scripts/fakecloud.sh` drops it). Do not remove either without re-running `npm run validate:fakecloud`.
- **EC2 hosts are not real under any emulator.** ClickHouse/Redash cloud-init only runs on real EC2; tests can only assert the rendered user-data.
- **Listener `open` defaults to true.** `addListener()` on an ALB adds `0.0.0.0/0` on the listener port unless `open: false` is passed, which silently defeats CIDR restriction. `test/stacks.test.ts` fails if any security group is world-open.
- **`fromSecretCompleteArn`** needs the full ARN including the random suffix. Use `fromSecretNameV2` only when you know the name.
- **User-data placeholders** are validated at synth: adding `{{TOKEN}}` to a script without passing a value fails on purpose.
- **The VPC is passed between stacks as a construct reference** on purpose; re-importing it with `fromVpcAttributes` loses subnet types and adds synth warnings.
- **CloudFront caching:** `index.html` is served with caching disabled; hashed assets are cached. Keep that split.
- **`retainData: true`** leaves S3 buckets and the database behind on `destroy` — that is a feature, not a leak. Clean up manually when needed.
