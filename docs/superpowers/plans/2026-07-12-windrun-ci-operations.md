# Windrun GitHub CI and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build secretless GitHub delivery for the `windrun-ai` Pulumi project, with isolated production, staging, preview, production-edge, staging-edge, and foundation identities plus reproducible bootstrap and teardown operations.

**Architecture:** GitHub Actions exchanges its OIDC identity independently with Pulumi Cloud and Google Workload Identity Federation. A thin pull-request caller runs uncredentialed checks and delegates credentialed preview work only to reusable workflows pinned to `main`, allowing both trust policies to require an exact `job_workflow_ref`; credentialed preview infrastructure runs from a separate trusted `main` checkout and treats PR code only as application build input. Routine branch workflows operate one application stack; manually approved edge and normal foundation workflows use distinct least-privilege identities, while project lifecycle/billing operations remain local under verified `rohan@windrun.ai` and a local-only Pulumi `delivery` stack owns all GitHub/Pulumi Cloud delivery-plane configuration.

**Tech Stack:** GitHub Actions, Node.js 22 LTS, pnpm/Corepack, Pulumi TypeScript, Pulumi Cloud, Google Workload Identity Federation, Node's built-in test runner.

## Global Constraints

- GitHub repository `rohanprabhu/windrun-ai` is the sole trusted source.
- GitHub repository ID is `1095528250` and owner ID is `136263`.
- Pulumi project name is exactly `windrun-ai`.
- Google Cloud organization is `391332700711` and billing account is `018EDA-2A53D0-A39B57`.
- Shared project is `windrun-ai-shared-20260712`.
- Staging project is `windrun-ai-staging-20260712`.
- Production project is `windrun-ai-prod-20260712`.
- Production deploy and production-edge identities have no staging-project role.
- Staging, preview, and staging-edge identities have no production-project role.
- Production-edge and staging-edge use separate Workload Identity providers and service accounts.
- Every `pulumi up` is preceded by lint, typecheck, application tests, infrastructure tests, build, and `pulumi preview`.
- Pulumi updates use non-canceling per-stack queues.
- Fork pull requests run uncredentialed quality checks only.
- No workflow uses `pull_request_target` to execute pull-request code.
- Credentialed preview deploy/destroy steps exist only in `_preview-deploy.yml@main` and `_preview-destroy.yml@main` reusable workflows.
- The pull-request caller passes typed event data, inherits no long-lived secrets, and contains no credentialed shell or action step.
- No workflow or operations script uses a service-account JSON key or long-lived Pulumi token.
- Root `.gitignore` and `.dockerignore` both exclude `gha-creds-*.json` and `.workload_identity.jwt`; policy tests enforce both patterns because static application builds use the repository root as Docker context.
- Every checkout in a credentialed job sets `persist-credentials: false`; the untrusted preview source checkout must never leave `GITHUB_TOKEN` in `source/.git/config` where a PR-controlled Dockerfile could read it.
- Every external GitHub Action in a credentialed workflow/composite action is pinned to a reviewed full 40-character commit SHA; mutable major-version tags are forbidden.
- No script creates, updates, or deletes a cloud resource through `gcloud`, `doctl`, or a provider console. Local lifecycle scripts may use only read-only `gcloud auth list` and `gcloud auth application-default print-access-token` checks to refuse the wrong Google identity; all cloud mutations remain Pulumi operations.
- GitHub environments, environment deployment policies, repository Actions variables, and Pulumi Cloud OIDC are mutated only by the local Pulumi `delivery` stack.
- Direct GitHub configuration mutations are prohibited. Operations scripts may invoke only `gh auth status` and `gh auth token` to bootstrap the explicit `@pulumi/github` provider locally; operators may still use the documented `gh workflow run`/`gh run watch` commands to trigger and observe approved workflows.
- CI stays disabled until the Pulumi agent account is claimed by `rohan@windrun.ai` and the agent logs into the transferred account.

---

## File Map and Integration Contract

The CI/operations track creates or modifies only these implementation files:

- `package.json` — adds CI contract and operations test commands.
- `.github/actions/setup/action.yml` — installs Node 22 and the repository-pinned pnpm through Corepack.
- `.github/actions/auth-cloud/action.yml` — exchanges GitHub OIDC for short-lived Pulumi Cloud and GCP credentials.
- `.github/workflows/deploy-production.yml` — maps pushes to `main` to the `production` stack.
- `.github/workflows/deploy-staging.yml` — maps pushes to `staging` to the `staging` stack.
- `.github/workflows/pull-request.yml` — uncredentialed PR event/quality caller with same-repository gates.
- `.github/workflows/_preview-deploy.yml` — main-pinned reusable workflow that deploys, smoke-tests, and comments on one preview.
- `.github/workflows/_preview-destroy.yml` — main-pinned reusable workflow that destroys/removes and comments on one preview.
- `.github/workflows/manage-edge.yml` — manually previews/applies one edge stack after environment approval.
- `.github/workflows/manage-foundation.yml` — manually previews/applies foundation after environment approval.
- `scripts/ci/validate-contract.mjs` — checks cross-track package/Pulumi interfaces.
- `scripts/ci/smoke-test.mjs` — performs bounded health retries.
- `scripts/ci/upsert-preview-comment.mjs` — creates or updates one marker PR comment.
- `scripts/ci/destroy-preview.mjs` — safely destroys/removes one numeric preview stack.
- `scripts/ci/*.test.mjs` — tests CI helpers and workflow policy.
- `scripts/ops/enable-ci-after-claim.mjs` — applies the local-only delivery stack after claim using authenticated Pulumi and GitHub CLI identities.
- `scripts/ops/lib/pulumi.mjs` — the only process-spawning library used by lifecycle scripts.
- `scripts/ops/bootstrap-platform.mjs` — previews/applies stacks in initial order.
- `scripts/ops/destroy-environment.mjs` — tears down production or staging in dependency order.
- `scripts/ops/destroy-platform.mjs` — performs acknowledged full teardown.
- `scripts/ops/*.test.mjs` — verifies ordering, refusal behavior, and Pulumi-only mutations.
- `docs/operations/*.md` — bootstrap, CI/OIDC, preview, privileged operations, and teardown runbooks.

The infrastructure track must provide a local-only `delivery` stack through `infra/Pulumi.delivery.yaml` and `infra/src/delivery/{index,github,pulumi-oidc}.ts`. It consumes foundation outputs, creates no GCP/DigitalOcean resources, and uses these exact Pulumi config keys:

```text
windrun-ai:stackKind
windrun-ai:gitCommitSha
windrun-ai:pullRequestNumber
windrun-ai:allowProjectDeletion
windrun-ai:enablePulumiGithubOidc
windrun-ai:pulumiOrganization
```

The exact stack kinds are `foundation`, `delivery`, `production-edge`, `production`, `staging-edge`, `staging`, and `preview`. The delivery stack owns an explicit `@pulumi/github` provider authenticated by `GITHUB_TOKEN`, the Pulumi Service `OidcIssuer` and policies, GitHub `RepositoryEnvironment` resources, GitHub `RepositoryEnvironmentDeploymentPolicy` resources, and GitHub `ActionsVariable` resources.

The foundation stack must expose these exact outputs:

```text
productionWifProvider
productionDeployServiceAccount
stagingWifProvider
stagingDeployServiceAccount
previewWifProvider
previewDeployServiceAccount
productionEdgeWifProvider
productionEdgeDeployServiceAccount
stagingEdgeWifProvider
stagingEdgeDeployServiceAccount
foundationWifProvider
foundationDeployServiceAccount
```

Application stacks expose `publicUrl`, `projectId`, `serviceName`, and `imageDigest`. Edge stacks expose `publicUrl`, `globalIp`, and `certificateStatus`.

The post-claim delivery stack writes these GitHub repository variables as Pulumi-managed `github.ActionsVariable` resources:

```text
PULUMI_CI_ENABLED
PULUMI_ORGANIZATION
GCP_WIF_PROVIDER_PRODUCTION
GCP_SERVICE_ACCOUNT_PRODUCTION
GCP_WIF_PROVIDER_STAGING
GCP_SERVICE_ACCOUNT_STAGING
GCP_WIF_PROVIDER_PREVIEW
GCP_SERVICE_ACCOUNT_PREVIEW
GCP_WIF_PROVIDER_PRODUCTION_EDGE
GCP_SERVICE_ACCOUNT_PRODUCTION_EDGE
GCP_WIF_PROVIDER_STAGING_EDGE
GCP_SERVICE_ACCOUNT_STAGING_EDGE
GCP_WIF_PROVIDER_FOUNDATION
GCP_SERVICE_ACCOUNT_FOUNDATION
```

### Task 1: Add CI contracts and reusable setup/authentication actions

**Files:**
- Modify: `package.json`
- Create: `.github/actions/setup/action.yml`
- Create: `.github/actions/auth-cloud/action.yml`
- Create: `scripts/ci/validate-contract.mjs`
- Test: `scripts/ci/validate-contract.test.mjs`

**Interfaces:**
- Consumes: root `packageManager`; root scripts `lint`, `typecheck`, `test`, `test:infra`, and `build`; `infra/Pulumi.yaml` with `name: windrun-ai`.
- Produces: `pnpm ci:quality`, `pnpm test:ci`, `pnpm ci:validate-contract`, local action `./.github/actions/setup`, and local action `./.github/actions/auth-cloud`.

- [ ] **Step 1: Write contract tests**

Create `scripts/ci/validate-contract.test.mjs` with temporary package and Pulumi fixtures. Assert that `validateContract(root)`:

```js
assert.deepEqual(validateContract(validRoot), [])
assert.deepEqual(validateContract(rootMissingTypecheck), [
  'package.json is missing script "typecheck"',
])
assert.deepEqual(validateContract(rootWithWrongPulumiName), [
  'infra/Pulumi.yaml must declare name: windrun-ai',
])
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --test scripts/ci/validate-contract.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/ci/validate-contract.mjs`.

- [ ] **Step 3: Implement the contract validator**

Export:

```ts
export function validateContract(root: string): string[]
```

It must check:

1. `package.json.packageManager` begins with `pnpm@`.
2. All five quality scripts exist.
3. `infra/Pulumi.yaml` parses to `name: windrun-ai`.
4. `infra/Pulumi.delivery.yaml` exists and declares `windrun-ai:stackKind: delivery`.
5. `infra/src/delivery/index.ts`, `infra/src/delivery/github.ts`, and `infra/src/delivery/pulumi-oidc.ts` exist.
6. `infra/package.json` exists and includes `@pulumi/github` and `@pulumi/pulumiservice`.
7. The validator prints `CI contract OK: windrun-ai` and exits zero only when the error list is empty.

- [ ] **Step 4: Add exact package commands**

Merge these entries into `package.json` without replacing application-track commands:

```json
{
  "scripts": {
    "ci:quality": "pnpm lint && pnpm typecheck && pnpm test && pnpm test:infra && pnpm build",
    "ci:validate-contract": "node scripts/ci/validate-contract.mjs",
    "test:ci": "node --test scripts/ci/*.test.mjs scripts/ops/*.test.mjs"
  },
  "devDependencies": {
    "yaml": "^2.8.1"
  }
}
```

- [ ] **Step 5: Add the setup composite action**

Create `.github/actions/setup/action.yml`:

```yaml
name: Setup Windrun
description: Install Node and the repository-pinned pnpm dependencies
runs:
  using: composite
  steps:
    - uses: actions/setup-node@<reviewed-full-commit-sha>
      with:
        node-version: "22"
    - shell: bash
      run: corepack enable
    - shell: bash
      run: pnpm install --frozen-lockfile
```

- [ ] **Step 6: Add the cloud-authentication composite action**

Create `.github/actions/auth-cloud/action.yml`:

```yaml
name: Authenticate Windrun Cloud
description: Exchange GitHub OIDC for short-lived Pulumi and Google credentials
inputs:
  pulumi-organization:
    required: true
  gcp-project-id:
    required: true
  workload-identity-provider:
    required: true
  service-account:
    required: true
runs:
  using: composite
  steps:
    - uses: pulumi/auth-actions@<reviewed-full-commit-sha>
      with:
        organization: ${{ inputs.pulumi-organization }}
        requested-token-type: urn:pulumi:token-type:access_token:personal
        scope: user:${{ inputs.pulumi-organization }}
        token-expiration: 3600
    - uses: google-github-actions/auth@<reviewed-full-commit-sha>
      with:
        project_id: ${{ inputs.gcp-project-id }}
        workload_identity_provider: ${{ inputs.workload-identity-provider }}
        service_account: ${{ inputs.service-account }}
        create_credentials_file: true
        export_environment_variables: true
```

- [ ] **Step 7: Run contract tests**

Run:

```bash
pnpm test:ci
pnpm ci:validate-contract
```

Expected: Node reports all tests passing and the validator prints `CI contract OK: windrun-ai`.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml .github/actions scripts/ci/validate-contract.mjs scripts/ci/validate-contract.test.mjs
git commit -m "ci: add delivery contracts and OIDC actions"
```

### Task 2: Add bounded smoke testing and deterministic preview comments

**Files:**
- Create: `scripts/ci/smoke-test.mjs`
- Test: `scripts/ci/smoke-test.test.mjs`
- Create: `scripts/ci/upsert-preview-comment.mjs`
- Test: `scripts/ci/upsert-preview-comment.test.mjs`

**Interfaces:**
- Produces: `smokeTest(url, { attempts, delayMs, fetchImpl, sleep })` and `upsertPreviewComment({ token, repository, pullNumber, state, previewUrl, runUrl, fetchImpl })`.
- Comment states: `ready`, `failed`, or `destroyed`.

- [ ] **Step 1: Write smoke-test cases**

Use a local `node:http` server. Test immediate success, two 503 responses followed by success, invalid JSON, `ok: false`, and exhaustion. The success assertion is:

```js
assert.equal(
  await smokeTest(url, {
    attempts: 3,
    delayMs: 0,
    fetchImpl: fetch,
    sleep: async () => {},
  }),
  200,
)
```

- [ ] **Step 2: Verify smoke tests fail**

Run:

```bash
node --test scripts/ci/smoke-test.test.mjs
```

Expected: FAIL because `smokeTest` is not exported.

- [ ] **Step 3: Implement bounded health retries**

The CLI interface is exact:

```bash
node scripts/ci/smoke-test.mjs URL --attempts 30 --delay-ms 10000
```

Retry only network errors and HTTP `404`, `429`, `500`, `502`, `503`, or `504`. Require HTTP 200 with JSON property `ok === true`. Print:

```text
SMOKE OK url=https://app.windrun.ai/api/health status=200
```

On exhaustion, exit one and print the final status without a response body.

- [ ] **Step 4: Write comment API tests**

Mock GitHub's issue-comments API and assert:

1. No existing marker produces one POST.
2. An existing `<!-- windrun-preview -->` marker produces one PATCH.
3. A different bot comment remains untouched.
4. The token never appears in the generated body or thrown error.

- [ ] **Step 5: Implement one-comment upsert**

The CLI consumes:

```text
GITHUB_TOKEN
GITHUB_REPOSITORY
PR_NUMBER
PREVIEW_STATE
PREVIEW_URL
GITHUB_RUN_URL
```

For `ready`, generate:

```markdown
<!-- windrun-preview -->
Windrun preview is ready: https://pr-42.staging.app.windrun.ai

[Deployment run](https://github.com/rohanprabhu/windrun-ai/actions/runs/123)
```

For `failed`, retain the URL and say the deployment failed. For `destroyed`, say the preview was destroyed and omit a live link.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test scripts/ci/smoke-test.test.mjs scripts/ci/upsert-preview-comment.test.mjs
```

Expected: all helper tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/ci/smoke-test.mjs scripts/ci/smoke-test.test.mjs scripts/ci/upsert-preview-comment.mjs scripts/ci/upsert-preview-comment.test.mjs
git commit -m "ci: add deployment smoke tests and preview comments"
```

### Task 3: Deploy production and staging from fixed branches

**Files:**
- Create: `.github/workflows/deploy-production.yml`
- Create: `.github/workflows/deploy-staging.yml`
- Test: `scripts/ci/workflows.test.mjs`

**Interfaces:**
- Consumes: Task 1 local actions, Task 2 smoke CLI, GitHub variables, and fixed primary stacks created by bootstrap.
- Produces: `main -> production` and `staging -> staging` delivery.

- [ ] **Step 1: Write workflow policy tests**

Parse YAML and assert:

```js
assert.equal(production.on.push.branches[0], 'main')
assert.equal(staging.on.push.branches[0], 'staging')
assert.equal(production.jobs.deploy.concurrency['cancel-in-progress'], false)
assert.equal(staging.jobs.deploy.concurrency['cancel-in-progress'], false)
assert.equal(production.jobs.deploy.environment, 'production')
assert.equal(staging.jobs.deploy.environment, 'staging')
```

Also assert preview step index is less than up step index, the quality job has no `id-token` permission, and the deploy job is guarded by `PULUMI_CI_ENABLED`.

- [ ] **Step 2: Verify workflow tests fail**

Run:

```bash
node --test scripts/ci/workflows.test.mjs
```

Expected: FAIL because both workflow files are absent.

- [ ] **Step 3: Implement the production workflow**

Create `.github/workflows/deploy-production.yml` with:

```yaml
name: Deploy production
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - run: pnpm ci:validate-contract
      - run: pnpm ci:quality
  deploy:
    needs: quality
    if: vars.PULUMI_CI_ENABLED == 'true'
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
    concurrency:
      group: windrun-production
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - uses: ./.github/actions/auth-cloud
        with:
          pulumi-organization: ${{ vars.PULUMI_ORGANIZATION }}
          gcp-project-id: windrun-ai-prod-20260712
          workload-identity-provider: ${{ vars.GCP_WIF_PROVIDER_PRODUCTION }}
          service-account: ${{ vars.GCP_SERVICE_ACCOUNT_PRODUCTION }}
      - uses: pulumi/actions@v7
        with:
          command: preview
          stack-name: ${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/production
          work-dir: infra
          config-map: |
            windrun-ai:stackKind:
              value: production
            windrun-ai:gitCommitSha:
              value: ${{ github.sha }}
      - id: up
        uses: pulumi/actions@v7
        with:
          command: up
          stack-name: ${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/production
          work-dir: infra
          config-map: |
            windrun-ai:stackKind:
              value: production
            windrun-ai:gitCommitSha:
              value: ${{ github.sha }}
      - run: node scripts/ci/smoke-test.mjs https://app.windrun.ai/api/health --attempts 30 --delay-ms 10000
```

- [ ] **Step 4: Implement the staging workflow**

Create `.github/workflows/deploy-staging.yml` with the same full structure and these exact substitutions:

```text
workflow name: Deploy staging
branch: staging
environment: staging
concurrency group: windrun-staging
project: windrun-ai-staging-20260712
provider variable: GCP_WIF_PROVIDER_STAGING
service-account variable: GCP_SERVICE_ACCOUNT_STAGING
stack: ${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/staging
stackKind: staging
health URL: https://staging.app.windrun.ai/api/health
```

- [ ] **Step 5: Validate syntax and policy**

Run:

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
node --test scripts/ci/workflows.test.mjs
```

Expected: actionlint emits no diagnostics and workflow tests pass.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy-production.yml .github/workflows/deploy-staging.yml scripts/ci/workflows.test.mjs
git commit -m "ci: deploy main and staging through isolated stacks"
```

### Task 4: Manage same-repository pull-request previews safely

**Files:**
- Create: `.github/workflows/pull-request.yml`
- Create: `.github/workflows/_preview-deploy.yml`
- Create: `.github/workflows/_preview-destroy.yml`
- Create: `scripts/ci/destroy-preview.mjs`
- Test: `scripts/ci/destroy-preview.test.mjs`
- Modify: `scripts/ci/workflows.test.mjs`

**Interfaces:**
- Consumes: Task 1 actions, Task 2 helpers, preview WIF variables, and trusted GitHub event fields.
- Produces: an uncredentialed event/quality caller plus main-pinned reusable deploy/destroy workflows for `pr-N`.

- [ ] **Step 1: Write preview policy and destroy-helper tests**

Assert that:

- trigger types are `opened`, `reopened`, `synchronize`, and `closed`, restricted to pull requests targeting `main`;
- `quality` has `contents: read` and no `id-token`;
- `pull-request.yml` has no credentialed steps and both called jobs require both immutable `github.event.pull_request.head.repo.id == github.event.repository.id` and `github.event.pull_request.head.repo.full_name == github.repository` checks;
- the called jobs use exactly `rohanprabhu/windrun-ai/.github/workflows/_preview-deploy.yml@main` and `rohanprabhu/windrun-ai/.github/workflows/_preview-destroy.yml@main`;
- neither called job declares `secrets: inherit` or any explicit secret input;
- both reusable workflows declare only `workflow_call`, recheck the same-repository pull-request event and every input against the immutable event payload, and use `windrun-preview-${{ inputs.pr-number }}` with cancellation disabled;
- both reusables declare typed inputs and the trusted workflow owns every checkout, auth, Pulumi, smoke, destroy, and comment step;
- credentialed preview Pulumi always runs from a distinct trusted `main` platform checkout; PR application source is checked out separately and supplied only as the Docker build source, never as executable infrastructure code;
- all three files contain no `pull_request_target`;
- destroy rejects `production`, `pr-0`, `pr-one`, and `pr-1/production`.

- [ ] **Step 2: Verify focused tests fail**

Run:

```bash
node --test scripts/ci/destroy-preview.test.mjs scripts/ci/workflows.test.mjs
```

Expected: FAIL because the caller, reusable workflows, and destroy helper do not exist.

- [ ] **Step 3: Implement safe destroy**

Export:

```ts
export function assertPreviewStackRef(stackRef: string): void
export async function destroyPreview(stackRef: string, runPulumi: RunPulumi): Promise<'absent' | 'destroyed'>
```

Accept only `/^[^/]+\/windrun-ai\/pr-[1-9][0-9]*$/`. Query `pulumi stack ls --json`; print `PREVIEW STACK ABSENT` when missing. Otherwise run:

```bash
pulumi destroy --yes --remove --stack $STACK_REF
```

from `infra/`.

- [ ] **Step 4: Implement the uncredentialed PR caller**

Create `.github/workflows/pull-request.yml` with workflow-level `contents: read` only and `pull_request.branches: [main]`. Its `quality` job runs every non-closed PR. Its deploy job contains no `steps` and calls:

```yaml
deploy-preview:
  needs: quality
  if: >-
    needs.quality.result == 'success' &&
    vars.PULUMI_CI_ENABLED == 'true' &&
    github.event.pull_request.head.repo.id == github.event.repository.id &&
    github.event.pull_request.head.repo.full_name == github.repository
  permissions:
    contents: read
    id-token: write
    pull-requests: write
  uses: rohanprabhu/windrun-ai/.github/workflows/_preview-deploy.yml@main
  with:
    pr-number: ${{ github.event.pull_request.number }}
    merge-sha: ${{ github.event.pull_request.merge_commit_sha }}
    head-sha: ${{ github.event.pull_request.head.sha }}
    preview-url: https://pr-${{ github.event.pull_request.number }}.staging.app.windrun.ai
```

Its close job likewise has no `steps` and calls:

```yaml
destroy-preview:
  if: >-
    github.event.action == 'closed' &&
    vars.PULUMI_CI_ENABLED == 'true' &&
    github.event.pull_request.head.repo.id == github.event.repository.id &&
    github.event.pull_request.head.repo.full_name == github.repository
  permissions:
    contents: read
    id-token: write
    pull-requests: write
  uses: rohanprabhu/windrun-ai/.github/workflows/_preview-destroy.yml@main
  with:
    pr-number: ${{ github.event.pull_request.number }}
    base-sha: ${{ github.event.pull_request.base.sha }}
    preview-url: https://pr-${{ github.event.pull_request.number }}.staging.app.windrun.ai
```

Do not add `secrets` to either call. The caller delegates `id-token: write` because GitHub does not let a called workflow elevate permissions, but only the main-pinned called workflow may request or exchange the token.

- [ ] **Step 5: Implement the trusted deploy reusable workflow**

Create `.github/workflows/_preview-deploy.yml` with:

```yaml
on:
  workflow_call:
    inputs:
      pr-number:
        type: number
        required: true
      merge-sha:
        type: string
        required: true
      head-sha:
        type: string
        required: true
      preview-url:
        type: string
        required: true
```

Its sole job must recheck `github.event_name == 'pull_request'`, `github.event.action` is one of `opened|reopened|synchronize`, `github.event.pull_request.base.ref == 'main'`, `github.event.pull_request.base.repo.id == github.event.repository.id`, immutable `github.event.pull_request.head.repo.id == github.event.repository.id`, `github.event.pull_request.head.repo.full_name == github.repository`, `inputs.pr-number == github.event.pull_request.number`, `inputs.merge-sha == github.event.pull_request.merge_commit_sha`, `inputs.head-sha == github.event.pull_request.head.sha`, and `inputs.preview-url == format('https://pr-{0}.staging.app.windrun.ai', github.event.pull_request.number)` before any step. It owns `environment: preview` and:

```yaml
concurrency:
  group: windrun-preview-${{ inputs.pr-number }}
  cancel-in-progress: false
```

The caller's uncredentialed `quality` job is the only job that executes repository scripts from `inputs.merge-sha`. The called workflow starts on a fresh runner, checks out `refs/heads/main` into `platform` with `persist-credentials:false`, checks out `inputs.merge-sha` separately into `source` with `persist-credentials:false`, and does not execute source-checkout scripts. It authenticates with preview WIF only after both checkouts, then runs Pulumi from `platform/infra` with `WINDRUN_APP_SOURCE=${{ github.workspace }}/source`. The trusted Pulumi program validates the `pr-N` stack/service name and uses that source directory only as Docker Build context. It runs preview/up for:

```yaml
stack-name: ${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/pr-${{ inputs.pr-number }}
upsert: true
config-map: |
  windrun-ai:stackKind:
    value: preview
  windrun-ai:pullRequestNumber:
    value: ${{ inputs.pr-number }}
  windrun-ai:gitCommitSha:
    value: ${{ inputs.head-sha }}
```

It smoke-tests `${{ inputs.preview-url }}/api/health` and calls `upsert-preview-comment.mjs` with `github.token`. An `if: always()` comment passes `ready` only when up and smoke succeeded; otherwise it passes `failed`. No long-lived secret is declared or inherited.

- [ ] **Step 6: Implement the trusted destroy reusable workflow**

Create `.github/workflows/_preview-destroy.yml` with typed inputs `pr-number: number`, `base-sha: string`, and `preview-url: string`. Its sole job requires `github.event.action == 'closed'`, base branch `main`, base repository ID equal to the event repository ID, repeats both the immutable head-repository-ID and full-name event/repository/number/URL checks, and also requires `inputs.base-sha == github.event.pull_request.base.sha`. It uses `environment: preview` and owns the identical non-canceling `windrun-preview-${{ inputs.pr-number }}` group. Its WIF trust accepts either the PR merge ref/caller or exact `refs/heads/main` ref/caller because GitHub reports the base ref after a merged close event.

It checks out `refs/heads/main` as its trusted platform code with `persist-credentials:false` (while still validating `inputs.base-sha` against the event), authenticates with preview WIF, installs Pulumi via a reviewed full-SHA pin of `pulumi/actions` without a command, invokes the trusted `destroy-preview.mjs` for `${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/pr-${{ inputs.pr-number }}`, then updates the marker comment to `destroyed` with `github.token`. It declares no secrets.

- [ ] **Step 7: Validate fork, reusable trust, and concurrency behavior**

Run:

```bash
node --test scripts/ci/destroy-preview.test.mjs scripts/ci/workflows.test.mjs
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

Expected: tests pass; actionlint is silent; the caller has no credentialed steps or inherited secrets; both same-repository calls point to exact `@main` reusable refs; both trusted reusable jobs share the same non-canceling group.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/pull-request.yml .github/workflows/_preview-deploy.yml .github/workflows/_preview-destroy.yml scripts/ci/destroy-preview.mjs scripts/ci/destroy-preview.test.mjs scripts/ci/workflows.test.mjs
git commit -m "ci: manage isolated pull request preview stacks"
```

### Task 5: Add separately isolated edge and foundation workflows

**Files:**
- Create: `.github/workflows/manage-edge.yml`
- Create: `.github/workflows/manage-foundation.yml`
- Modify: `scripts/ci/workflows.test.mjs`

**Interfaces:**
- Consumes: separate production-edge, staging-edge, and foundation outputs/variables.
- Produces: manual preview/apply operations guarded by GitHub environment approval.

- [ ] **Step 1: Write privileged-workflow tests**

Assert that edge declares `options: [production-edge, staging-edge]` exactly once and accepts only operations `preview` and `apply`; foundation accepts only `preview` and `apply`. Assert there is no destroy input. Assert production-edge references only production-edge variables and project, and staging-edge references only staging-edge variables and project.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
node --test scripts/ci/workflows.test.mjs
```

Expected: FAIL because both manual workflows are absent.

- [ ] **Step 3: Implement the edge workflow**

Create `.github/workflows/manage-edge.yml` with `workflow_dispatch` inputs:

```yaml
stack:
  type: choice
  required: true
  options: [production-edge, staging-edge]
operation:
  type: choice
  required: true
  default: preview
  options: [preview, apply]
```

The single job must require `github.ref == 'refs/heads/main'`, use `environment: ${{ inputs.stack }}`, and serialize with:

```yaml
concurrency:
  group: windrun-${{ inputs.stack }}
  cancel-in-progress: false
```

Use exact conditional values:

```yaml
gcp-project-id: ${{ inputs.stack == 'production-edge' && 'windrun-ai-prod-20260712' || 'windrun-ai-staging-20260712' }}
workload-identity-provider: ${{ inputs.stack == 'production-edge' && vars.GCP_WIF_PROVIDER_PRODUCTION_EDGE || vars.GCP_WIF_PROVIDER_STAGING_EDGE }}
service-account: ${{ inputs.stack == 'production-edge' && vars.GCP_SERVICE_ACCOUNT_PRODUCTION_EDGE || vars.GCP_SERVICE_ACCOUNT_STAGING_EDGE }}
```

Always run `pulumi preview` for `${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/${{ inputs.stack }}`. Run `pulumi up` only when `inputs.operation == 'apply'`.

- [ ] **Step 4: Implement the foundation workflow**

Create `.github/workflows/manage-foundation.yml` with one `preview|apply` input, `environment: foundation`, group `windrun-foundation`, cancellation disabled, project `windrun-ai-shared-20260712`, and the foundation-specific provider/service-account variables. Guard the job with `github.ref == 'refs/heads/main'` and `PULUMI_CI_ENABLED`.

- [ ] **Step 5: Validate**

Run:

```bash
pnpm test:ci
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

Expected: tests pass, actionlint is silent, and the workflow test confirms exactly one stack-option declaration plus separate production-edge and staging-edge identities.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/manage-edge.yml .github/workflows/manage-foundation.yml scripts/ci/workflows.test.mjs
git commit -m "ci: add reviewed edge and foundation operations"
```

### Task 6: Enforce Pulumi and GCP OIDC claims and the account-claim checkpoint

**Files:**
- Create: `scripts/ops/enable-ci-after-claim.mjs`
- Test: `scripts/ops/enable-ci-after-claim.test.mjs`
- Create: `docs/operations/ci-oidc.md`

**Interfaces:**
- Consumes: foundation outputs, the infrastructure track's local-only `delivery` stack, an authenticated claimed Pulumi individual account, and a local `gh` identity for `rohanprabhu/windrun-ai`.
- Produces: Pulumi-managed OIDC policy, GitHub environments/deployment policies, fourteen repository variables, and `PULUMI_CI_ENABLED=true`.

- [ ] **Step 1: Write enablement failure tests**

Test refusal when the confirmation argument is absent or not exactly `rohan@windrun.ai`, Pulumi backend is not `https://api.pulumi.com`, `gh auth status` does not identify `rohanprabhu`, either local token is empty, or any of the twelve foundation outputs is empty. Assert the only `gh` subprocesses are `auth status` and `auth token`; `ci:validate-contract` and `ci:quality` both precede exactly one `pulumi preview` and one `pulumi up` of `LOGIN/windrun-ai/delivery`.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
node --test scripts/ops/enable-ci-after-claim.test.mjs
```

Expected: FAIL because the enablement module is absent.

- [ ] **Step 3: Specify exact Pulumi issuer policies**

The `delivery` stack must register `https://token.actions.githubusercontent.com` with a 3600-second maximum and deny-by-default policy. Every allow rule creates a personal-token policy whose `userLogin` is the raw Pulumi login returned by `pulumi whoami` (for example `alice`, never `user:alice`) and requires:

```text
aud = urn:pulumi:org:$PULUMI_ORGANIZATION
repository = rohanprabhu/windrun-ai
repository_id = 1095528250
repository_owner_id = 136263
```

GitHub's legacy and immutable-ID subject prefixes are both valid for this existing repository. Do not hard-code `repo:rohanprabhu/windrun-ai`. Each rule must instead combine the exact numeric claims above with `sub = repo:*:environment:<environment>` and an exact `environment` claim. The suffix pattern accepts either documented prefix without trusting another repository because both immutable numeric claims are mandatory.

Add distinct rules for these exact environments, events, refs, caller workflows, and trusted reusable-workflow claims:

```text
foundation       workflow_dispatch / refs/heads/main    / manage-foundation.yml
production       push              / refs/heads/main    / deploy-production.yml
production-edge  workflow_dispatch / refs/heads/main    / manage-edge.yml
staging          push              / refs/heads/staging / deploy-staging.yml
staging-edge     workflow_dispatch / refs/heads/main    / manage-edge.yml
preview          pull_request      / refs/pull/*/merge  / pull-request.yml / job_workflow_ref rohanprabhu/windrun-ai/.github/workflows/_preview-deploy.yml@refs/heads/main
preview destroy  pull_request      / refs/pull/*/merge or refs/heads/main / pull-request.yml / job_workflow_ref rohanprabhu/windrun-ai/.github/workflows/_preview-destroy.yml@refs/heads/main
```

The token exchange still uses the prefixed action scope `user:<LOGIN>`; that value is intentionally different from the issuer policy's raw `userLogin`.

In `infra/src/delivery/github.ts`, create the environment and branch-deployment-policy resources with this exact contract:

```text
foundation       main                required reviewer User 136263
production       main                no reviewer
production-edge  main                required reviewer User 136263
staging          staging             no reviewer
staging-edge     main                required reviewer User 136263
preview          refs/pull/*/merge   no reviewer
preview          main                no reviewer (merged-close destroy only; OIDC still exact)
```

Every environment/policy and Actions variable uses the explicit `github.Provider`. No default GitHub provider or direct `gh` mutation is permitted.

- [ ] **Step 4: Specify exact GCP claim mapping and conditions**

Every provider uses this common mapping. Mapping the numeric repository ID as `google.subject` keeps it immutable, below Google's 127-byte subject limit, and independent of GitHub's legacy versus post-2026-07-15 subject formats:

```text
google.subject=assertion.repository_id
attribute.repository=assertion.repository
attribute.repository_id=assertion.repository_id
attribute.repository_owner_id=assertion.repository_owner_id
attribute.event_name=assertion.event_name
attribute.ref=assertion.ref
attribute.workflow_ref=assertion.workflow_ref
attribute.environment=assertion.environment
```

Only the preview provider extends the mapping with `attribute.job_workflow_ref=assertion.job_workflow_ref`; direct jobs are not guaranteed to receive that claim. All provider conditions require exact numeric repository and owner IDs plus the expected `environment`, `event_name`, `ref`, and `workflow_ref`. Foundation accepts only `manage-foundation.yml` on `main`. Production accepts only `deploy-production.yml` on `main`. Production-edge accepts only `manage-edge.yml` on `main`. Staging accepts only `deploy-staging.yml` on `staging`. Staging-edge accepts only `manage-edge.yml` on `main`. Preview additionally requires `assertion.base_ref == 'main'`. Preview deploy requires `event_name == 'pull_request'`, a `refs/pull/*/merge` ref/caller, the exact `pull-request.yml` caller, and the exact main-pinned deploy `job_workflow_ref`. Preview destroy requires the exact main-pinned destroy `job_workflow_ref` and accepts either the PR merge ref/caller or the exact `refs/heads/main` ref/caller reported by GitHub for a merged close event; it must never accept a wildcard reusable ref. Production-edge and staging-edge remain separate providers and service accounts with roles only in their own projects.

Each service-account impersonation member uses `principalSet://iam.googleapis.com/projects/<numeric-pool-project-number>/locations/global/workloadIdentityPools/<pool-id>/attribute.repository_id/1095528250`; a string project ID is invalid in that URI. GitHub `assertion.*` expressions belong only in the provider's CEL condition and must not be copied into project or service-account IAM binding conditions.

- [ ] **Step 5: Implement post-claim enablement**

The only accepted invocation is:

```bash
node scripts/ops/enable-ci-after-claim.mjs --confirm-claimed-by rohan@windrun.ai
```

The script must:

1. Derive `LOGIN` from `pulumi whoami --json` and verify the managed backend is `https://api.pulumi.com`.
2. Read the current claimed Pulumi token from the local Pulumi credentials entry for `https://api.pulumi.com` and keep it only in the child-process environment as `PULUMI_ACCESS_TOKEN` for the explicit `pulumiservice.Provider`.
3. Run `gh auth status --hostname github.com` and verify login `rohanprabhu`.
4. Read `GITHUB_TOKEN` from `gh auth token --hostname github.com` and keep it only in the child-process environment for the explicit `github.Provider`.
5. Select or initialize `LOGIN/windrun-ai/delivery`.
6. Set `windrun-ai:stackKind=delivery`, `windrun-ai:pulumiOrganization=LOGIN`, and `windrun-ai:enablePulumiGithubOidc=true` on delivery.
7. Run `pnpm ci:validate-contract` followed by `pnpm ci:quality` from the repository root and stop before preview if either fails.
8. Run `pulumi preview --stack LOGIN/windrun-ai/delivery` with both tokens in its process environment.
9. Run `pulumi up --yes --stack LOGIN/windrun-ai/delivery` with both tokens in its process environment.
10. Let Pulumi create the six environments, seven reviewer/deployment policies, OIDC issuer, `PULUMI_ORGANIZATION`, the twelve GCP variables, and `PULUMI_CI_ENABLED=true`.
11. Require the `PULUMI_CI_ENABLED` `github.ActionsVariable` to depend on the issuer, all environments/policies, and the other thirteen variables so it is created last.
12. Clear both in-process token values in a `finally` block; never print, persist in stack config, or store either as a GitHub Actions secret.

- [ ] **Step 6: Document the human checkpoint**

`docs/operations/ci-oidc.md` must require:

```bash
pulumi logout
pulumi login
pulumi whoami --json
node scripts/ops/enable-ci-after-claim.mjs --confirm-claimed-by rohan@windrun.ai
```

Explain that claim transfers stacks/ESC state, invalidates the agent credential, restores durable write access, and must occur before the local-only delivery stack is created. State that `gh` is used only to read the current identity/token, the claimed Pulumi token is supplied only as `PULUMI_ACCESS_TOKEN` to the explicit Pulumi Service provider process, and every GitHub/Pulumi Cloud configuration mutation is a `pulumi preview/up` of `delivery`.

- [ ] **Step 7: Validate with mocks**

Run:

```bash
node --test scripts/ops/enable-ci-after-claim.test.mjs
```

Expected: all refusal, delivery-stack ordering, no-`gh`-mutation, output-name, local-token handling, and secret-redaction cases pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/ops/enable-ci-after-claim.mjs scripts/ops/enable-ci-after-claim.test.mjs docs/operations/ci-oidc.md
git commit -m "ops: enable secretless CI after Pulumi account claim"
```

### Task 7: Add reproducible bootstrap and environment teardown

**Files:**
- Create: `scripts/ops/lib/pulumi.mjs`
- Create: `scripts/ops/bootstrap-platform.mjs`
- Create: `scripts/ops/destroy-environment.mjs`
- Test: `scripts/ops/pulumi-operations.test.mjs`

**Interfaces:**
- Produces:

```ts
runPulumi(args: string[], options?: { capture?: boolean }): Promise<string>
stackRef(organization: string, stack: string): string
stackHasResources(stack: string): Promise<boolean>
destroyAndRemove(stack: string): Promise<void>
```

- [ ] **Step 1: Write fake-Pulumi ordering tests**

Set `PULUMI_BIN` to a fixture executable that appends JSON-encoded arguments to a log. Assert bootstrap order:

```text
foundation
production
production-edge
staging
staging-edge
delivery (post-claim only, through enable-ci-after-claim.mjs)
```

Assert staging teardown destroys numeric `pr-*` stacks, then `staging`, then `staging-edge`. Assert production teardown destroys `production`, then `production-edge`.

- [ ] **Step 2: Verify operation tests fail**

Run:

```bash
node --test scripts/ops/pulumi-operations.test.mjs
```

Expected: FAIL because `scripts/ops/lib/pulumi.mjs` is absent.

- [ ] **Step 3: Implement the Pulumi-only process library**

`runPulumi` always uses `cwd: infra` and inherits ADC. Production code must reject `PULUMI_BIN` values whose basename is not `pulumi`; tests may opt in through an exported injected runner rather than executing another cloud CLI. `stackHasResources` parses `pulumi stack export --stack STACK` and ignores the root `pulumi:pulumi:Stack` resource. Export an `assertExactGoogleIdentity` preflight that permits only the exact read-only commands `gcloud auth list --filter=status:ACTIVE --format=value(account)` and `gcloud auth application-default print-access-token`, then calls Google's OpenID userinfo endpoint with the ADC token without logging it. It must refuse unless both emails are exactly `rohan@windrun.ai`; no generic gcloud runner is allowed.

- [ ] **Step 4: Implement bootstrap**

Bootstrap is explicitly two-phase. Before selecting or previewing a stack, it runs `assertExactGoogleIdentity` and prints only `GOOGLE IDENTITY VERIFIED: rohan@windrun.ai`. Before claim, the default invocation previews the five cloud stacks:

```bash
node scripts/ops/bootstrap-platform.mjs
```

The apply invocation previews and applies each of those stacks before continuing:

```bash
node scripts/ops/bootstrap-platform.mjs --apply
```

Every application stack receives `windrun-ai:gitCommitSha=$(git rev-parse HEAD)`. Phase one ends with `BOOTSTRAP PHASE 1 COMPLETE; CLAIM ACCOUNT BEFORE DELIVERY`. After claim, `node scripts/ops/enable-ci-after-claim.mjs --confirm-claimed-by rohan@windrun.ai` previews/applies `delivery` and prints `DELIVERY ENABLED; BOOTSTRAP COMPLETE`. No pre-claim bootstrap path may select or create `delivery`.

- [ ] **Step 5: Implement environment teardown**

Accepted commands are:

```bash
node scripts/ops/destroy-environment.mjs --environment staging --apply
node scripts/ops/destroy-environment.mjs --environment production --apply
```

Without `--apply`, print the exact planned order and perform no mutation. Staging teardown discovers only stack names matching `pr-[1-9][0-9]*`, sorts numerically, destroys/removes them, then destroys `staging` and `staging-edge`. Production destroys `production` and `production-edge`. Foundation remains untouched.

- [ ] **Step 6: Verify**

Run:

```bash
node --test scripts/ops/pulumi-operations.test.mjs
node scripts/ops/bootstrap-platform.mjs
node scripts/ops/destroy-environment.mjs --environment staging
```

Expected: tests pass; the latter two commands print plans without changing cloud resources.

- [ ] **Step 7: Commit**

```bash
git add scripts/ops/lib/pulumi.mjs scripts/ops/bootstrap-platform.mjs scripts/ops/destroy-environment.mjs scripts/ops/pulumi-operations.test.mjs
git commit -m "ops: add platform bootstrap and environment teardown"
```

### Task 8: Add acknowledged full-platform teardown

**Files:**
- Create: `scripts/ops/destroy-platform.mjs`
- Modify: `scripts/ops/pulumi-operations.test.mjs`
- Create: `docs/operations/teardown.md`

**Interfaces:**
- Consumes: Task 7 Pulumi library.
- Produces: the sole full teardown entry point.

- [ ] **Step 1: Write refusal and ordering tests**

Assert missing `--destroy-projects` exits two with:

```text
REFUSED: pass --destroy-projects to acknowledge deletion of all three GCP projects
```

Assert exact order:

```text
all pr-* stacks
staging
production
staging-edge
production-edge
delivery
foundation
```

Assert delivery is destroyed after all application/edge resources and foundation is refused while any earlier stack, including delivery, has a non-root resource. For the delivery-disable update, assert `ci:validate-contract` and `ci:quality` run before its preview/up.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
node --test scripts/ops/pulumi-operations.test.mjs
```

Expected: FAIL because the full destroy module is missing.

- [ ] **Step 3: Implement the acknowledged destroy**

The sole mutating invocation is:

```bash
node scripts/ops/destroy-platform.mjs --destroy-projects
```

The script must:

1. Destroy/remove all numeric preview stacks.
2. Destroy `staging` and `production`.
3. Destroy `staging-edge` and `production-edge`.
4. Verify all application and edge stacks contain zero non-root resources.
5. If `delivery` exists, run `pnpm ci:validate-contract` and `pnpm ci:quality`, read the current local Pulumi and GitHub tokens without printing them, set `windrun-ai:enablePulumiGithubOidc=false` on delivery, and run delivery preview/up so `PULUMI_CI_ENABLED` becomes false before deletion.
6. Destroy `delivery` with both explicit provider tokens in the Pulumi child-process environment; this removes Pulumi Cloud OIDC, GitHub environments/policies, and Actions variables through Pulumi.
7. Verify delivery is absent or contains zero non-root resources.
8. Verify active gcloud identity and ADC are both exactly `rohan@windrun.ai`, then set `windrun-ai:allowProjectDeletion=true` on foundation.
9. Run and display foundation preview; require it to show only the expected protection removals and project deletion-policy transition before confirmation.
10. Run foundation `pulumi up` locally to persist `protect:false` and `deletionPolicy: DELETE`, then verify those values from stack state.
11. Destroy foundation locally under the same verified account.
12. Clear both local tokens and print that all three projects enter `DELETE_REQUESTED` with a 30-day recovery window and permanently unavailable project IDs.

If any operation fails after the teardown transition was applied but before foundation is fully destroyed, reset `windrun-ai:allowProjectDeletion=false` and run a local foundation `pulumi up` to re-protect all surviving resources and restore project `deletionPolicy: PREVENT` before exiting.

- [ ] **Step 4: Document recovery boundaries**

`docs/operations/teardown.md` must contain environment-only commands, full destroy command, exact dependency order, delivery disable/destroy before foundation, the `--destroy-projects` acknowledgement, the preview-plus-up protection/deletion-policy transition, state verification, the 30-day recovery window, and the rule that scripts invoke no mutating `gcloud`, `doctl`, or GitHub CLI subcommands. Document the two exact read-only gcloud identity checks as the only gcloud exception.

- [ ] **Step 5: Verify**

Run:

```bash
node --test scripts/ops/pulumi-operations.test.mjs
node scripts/ops/destroy-platform.mjs
```

Expected: tests pass; the second command exits two with the refusal text and makes no Pulumi mutation.

- [ ] **Step 6: Commit**

```bash
git add scripts/ops/destroy-platform.mjs scripts/ops/pulumi-operations.test.mjs docs/operations/teardown.md
git commit -m "ops: add acknowledged full platform teardown"
```

### Task 9: Complete runbooks and end-to-end validation

**Files:**
- Create: `docs/operations/README.md`
- Create: `docs/operations/bootstrap.md`
- Create: `docs/operations/preview-environments.md`
- Create: `docs/operations/edge-and-foundation.md`
- Modify: `docs/operations/ci-oidc.md`
- Modify: `docs/operations/teardown.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one operator entry point and recorded acceptance procedure.

- [ ] **Step 1: Write the operations index**

`docs/operations/README.md` links the other four runbooks and states which operations are automatic, manual/approved, local-only, and destructive. Identify `delivery` as local-only and the sole owner of GitHub/Pulumi Cloud delivery-plane mutations.

- [ ] **Step 2: Document bootstrap**

Include:

```bash
pnpm install --frozen-lockfile
pnpm ci:quality
node scripts/ops/bootstrap-platform.mjs
node scripts/ops/bootstrap-platform.mjs --apply
node scripts/ops/enable-ci-after-claim.mjs --confirm-claimed-by rohan@windrun.ai
```

Record phase-one order `foundation -> production -> production-edge -> staging -> staging-edge`, the mandatory account-claim checkpoint, then post-claim `delivery`. Explain why primary services precede edge stacks and why delivery cannot run before claim.

- [ ] **Step 3: Document preview operations**

State the exact branch/event mapping, deterministic hostname formula, same-repository gate, fork behavior, shared non-canceling concurrency group, smoke retries, single marker comment, and close-time destroy/remove behavior. Document that `pull-request.yml` is a thin caller, no secrets are inherited, and only `_preview-deploy.yml@main`/`_preview-destroy.yml@main` contain credentialed steps; OIDC trusts their exact `job_workflow_ref` claims.

- [ ] **Step 4: Document privileged operations**

Include:

```bash
gh workflow run manage-edge.yml --ref main -f stack=production-edge -f operation=preview
gh workflow run manage-edge.yml --ref main -f stack=staging-edge -f operation=preview
gh workflow run manage-foundation.yml --ref main -f operation=preview
```

Explain the distinct production-edge/staging-edge identities and required environment approvals.

- [ ] **Step 5: Run all static validation**

Run:

```bash
pnpm install --frozen-lockfile
pnpm ci:quality
pnpm test:ci
pnpm ci:validate-contract
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
rg -n 'pull_request_target|cancel-in-progress: true|gcloud .*create|gcloud .*delete|doctl|gh api|gh variable set' .github scripts
```

Expected: tests and builds pass, actionlint is silent, and the prohibited-pattern search returns no matches.

- [ ] **Step 6: Validate secretless configuration after account claim**

Run:

```bash
gh variable list
gh secret list | rg 'PULUMI_ACCESS_TOKEN|GOOGLE_CREDENTIALS|GCP_SA_KEY'
gh workflow run manage-foundation.yml --ref main -f operation=preview
gh run watch
```

Expected: all fourteen Pulumi-managed repository variables are present; the secret search exits one with no output; the foundation job waits for environment approval and then completes an OIDC-authenticated preview.

- [ ] **Step 7: Validate public health routes after bootstrap**

Run:

```bash
curl --fail --silent https://app.windrun.ai/api/health
curl --fail --silent https://staging.app.windrun.ai/api/health
```

Expected: each response is JSON containing `"ok":true`.

- [ ] **Step 8: Commit**

```bash
git add docs/operations
git commit -m "docs: add Windrun platform operations runbooks"
```

## Final Self-Review Checklist

- [ ] Every design requirement in CI/CD, Secrets, Failure Handling, Testing Strategy, and Teardown maps to a task above.
- [ ] Production, production-edge, staging, preview, staging-edge, and foundation each use the correct isolated identity.
- [ ] `productionEdgeWifProvider`/`productionEdgeDeployServiceAccount` never appear in a staging path.
- [ ] `stagingEdgeWifProvider`/`stagingEdgeDeployServiceAccount` never appear in a production path.
- [ ] No implementation step contains an unresolved value; the final Pulumi login is derived from `pulumi whoami` after claim.
- [ ] All function names and foundation output names are consistent across tasks.
- [ ] The local-only `delivery` stack owns every GitHub environment/policy/variable and Pulumi Cloud OIDC mutation; no `gh` mutation remains.
- [ ] Preview trust uses the two exact main-pinned `job_workflow_ref` values; deploy accepts only `refs/pull/*/merge`, while destroy additionally accepts the exact merged-close `refs/heads/main` ref/caller pair.
- [ ] CI enabling is the final dependency-ordered resource in the post-claim delivery update.
- [ ] Full teardown destroys `delivery` after apps/edges and before foundation.
- [ ] Every mutating Pulumi workflow or script performs or displays a preview first.
