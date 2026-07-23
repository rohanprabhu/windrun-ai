# Staging DNS Zone Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move staging and preview hostnames from the old `staging.app.windrun.ai` shape to the cleaner `app.staging.windrun.ai` hierarchy while keeping DNS ownership centralized in the shared/foundation GCP project.

**Architecture:** The shared foundation stack should continue to own public DNS delegation from DigitalOcean to Cloud DNS. Production remains `app.windrun.ai`; staging moves under a separately delegated `staging.windrun.ai.` Cloud DNS zone, with staging at `app.staging.windrun.ai` and previews at `pr-N.app.staging.windrun.ai`.

**Tech Stack:** Pulumi TypeScript, Google Cloud DNS, Google Certificate Manager, Google Cloud Load Balancing, Cloud Run, GitHub Actions, Vitest.

## Global Constraints

- Use the existing isolated worktree at `/Users/rohan/projects/windrun-ai/.worktrees/windrun-cloudrun-platform`.
- Do not use Composio.
- Use GCP identity `rohan@windrun.ai` for any applied cloud changes.
- Keep production at `app.windrun.ai`.
- Keep staging resources in the staging GCP project and DNS control in the shared/foundation project.

---

### Task 1: Update hostname and DNS constants

**Files:**
- Modify: `infra/src/constants.ts`
- Modify: `infra/src/foundation/dns.ts`

**Interfaces:**
- Consumes: existing `HOSTNAMES` object.
- Produces: `HOSTNAMES.productionZone`, `HOSTNAMES.stagingZone`, `HOSTNAMES.staging`, and `HOSTNAMES.previewSuffix`.

- [ ] **Step 1: Change constants**

Set:

```ts
production: "app.windrun.ai",
staging: "app.staging.windrun.ai",
previewSuffix: "app.staging.windrun.ai",
productionZone: "app.windrun.ai.",
stagingZone: "staging.windrun.ai.",
parentZone: "windrun.ai",
```

- [ ] **Step 2: Split DNS resources**

Create one Cloud DNS managed zone for `app.windrun.ai.` and one for `staging.windrun.ai.`. Delegate `app` and `staging` from the DigitalOcean parent zone.

- [ ] **Step 3: Run tests**

Run: `pnpm --dir infra test`

Expected: DNS tests fail until expected records are updated in Task 2.

### Task 2: Update cert/DNS tests and app/edge tests

**Files:**
- Modify: `infra/tests/foundation-dns-certificates.test.ts`
- Modify: `infra/tests/app-stack.test.ts`
- Modify: `infra/tests/edge-stack.test.ts`
- Modify: `infra/tests/helpers/pulumi-mocks.ts`

**Interfaces:**
- Consumes: new hostname constants from Task 1.
- Produces: passing tests that assert two delegated zones and the new staging hierarchy.

- [ ] **Step 1: Update expected zones**

Expect two zones: `app.windrun.ai.` and `staging.windrun.ai.`.

- [ ] **Step 2: Update expected records**

Expect:

```text
app.windrun.ai.
app.staging.windrun.ai.
*.app.staging.windrun.ai.
```

- [ ] **Step 3: Update certificate authorization expectations**

Expect production validation under `app.windrun.ai.` and staging validation under `staging.windrun.ai.`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --dir infra test infra/tests/foundation-dns-certificates.test.ts infra/tests/app-stack.test.ts infra/tests/edge-stack.test.ts
```

Expected: PASS.

### Task 3: Update workflows and app tests

**Files:**
- Modify: `.github/workflows/deploy-staging.yml`
- Modify: `.github/workflows/pull-request.yml`
- Modify: `.github/workflows/_preview-deploy.yml`
- Modify: `.github/workflows/_preview-destroy.yml`
- Modify: `scripts/ci/workflows.test.mjs`
- Modify: `scripts/ci/upsert-preview-comment.test.mjs`
- Modify: `scripts/smoke-container.sh`
- Modify: `windrun-ai/tests/deployment.test.ts`
- Modify: `windrun-ai/tests/launch-console.test.tsx`

**Interfaces:**
- Consumes: `app.staging.windrun.ai` and `pr-N.app.staging.windrun.ai`.
- Produces: CI and app tests aligned to the new canonical hosts.

- [ ] **Step 1: Replace old staging host strings**

Replace every old `staging.app.windrun.ai` occurrence with `app.staging.windrun.ai`.

- [ ] **Step 2: Run repo tests/checks**

Run:

```bash
pnpm --dir infra check
pnpm test
```

Expected: PASS.

### Task 4: Preview and apply Pulumi stacks

**Files:**
- No source edits.

**Interfaces:**
- Consumes: migrated source code from Tasks 1-3.
- Produces: applied DNS/cert/edge changes in GCP and DigitalOcean.

- [ ] **Step 1: Confirm identities**

Run:

```bash
gcloud auth list --filter=status:ACTIVE --format='value(account)'
pulumi whoami
```

Expected: `rohan@windrun.ai` and `rohan-windrun-ai`.

- [ ] **Step 2: Preview foundation**

Run:

```bash
pulumi preview --stack rohan-windrun-ai/foundation --diff
```

Expected: DNS zone and record changes only; no project deletion.

- [ ] **Step 3: Apply foundation**

Run:

```bash
pulumi up --stack rohan-windrun-ai/foundation --yes
```

Expected: delegated staging DNS zone and records created.

- [ ] **Step 4: Apply staging app and edge**

Run:

```bash
pulumi up --stack rohan-windrun-ai/staging --yes
pulumi up --stack rohan-windrun-ai/staging-edge --yes
```

Expected: Cloud Run env and LB host/cert map entries use `app.staging.windrun.ai`.

- [ ] **Step 5: Verify HTTPS**

Run:

```bash
node scripts/ci/smoke-test.mjs https://app.staging.windrun.ai/api/health --attempts 30 --delay-ms 10000
```

Expected: healthy JSON response.
