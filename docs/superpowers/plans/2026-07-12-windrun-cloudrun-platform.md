# Windrun Cloud Run Platform Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver, deploy, and verify the Windrun Next.js application on isolated production and staging Google Cloud projects, with shared DNS/control resources, stable per-environment load balancers, dynamic pull-request previews, and Pulumi as the only infrastructure mutator.

**Architecture:** The detailed work is split into three non-overlapping plans. The application plan owns Next.js and its container. The infrastructure plan owns Pulumi programs, stack configuration, Google Cloud, DigitalOcean DNS, Pulumi Cloud OIDC, and GitHub configuration resources. The CI/operations plan owns repository workflows, pure helper code, and wrappers that invoke Pulumi. The approved design specification is the authority for cross-track behavior.

**Tech Stack:** Next.js 16.2.10, React 19.2.7, Node.js 22 LTS, pnpm 11.7.0, Pulumi TypeScript, Google Cloud Run v2, global external managed HTTPS load balancing, Cloud DNS, Certificate Manager, DigitalOcean DNS, GitHub Actions OIDC, and Google Workload Identity Federation.

## Global Constraints

- Source design: `docs/superpowers/specs/2026-07-12-windrun-cloudrun-platform-design.md`.
- Detailed plans:
  - `docs/superpowers/plans/2026-07-12-windrun-application-container.md`
  - `docs/superpowers/plans/2026-07-12-windrun-pulumi-infrastructure.md`
  - `docs/superpowers/plans/2026-07-12-windrun-ci-operations.md`
- The only accepted Google human identity is `rohan@windrun.ai`.
- The only accepted GitHub owner/repository is `rohanprabhu/windrun-ai`, repository ID `1095528250`, owner ID `136263`.
- No Composio account, organization, credential, state backend, or resource may be read for reuse or written.
- GCP projects are exactly `windrun-ai-shared-20260712`, `windrun-ai-staging-20260712`, and `windrun-ai-prod-20260712` under organization `391332700711` and billing account `018EDA-2A53D0-A39B57`.
- Production and staging have separate projects, Artifact Registry repositories, runtime identities, deploy identities, certificates, IP addresses, and load balancers.
- The staging load balancer supports the fixed `staging` service and same-project preview services through URL mask `<service>.staging.app.windrun.ai` without per-preview edge changes.
- Every GCP resource uses an explicit project-scoped provider; default GCP providers are disabled in every stack.
- Pulumi is the sole mutator for GCP, DigitalOcean DNS, Pulumi Cloud OIDC, GitHub deployment environments, deployment policies, and Actions variables.
- Shell/Node helpers may validate state and invoke Pulumi. They may not mutate infrastructure through `gcloud`, `doctl`, `gh api`, `gh variable`, or vendor consoles.
- The DigitalOcean token is never printed and is deleted from its temporary Keychain item only after encrypted Pulumi configuration is verified.
- No static GCP service-account key, Pulumi access token, or GitHub token is committed or installed as a CI secret.
- Project deletion remains `PREVENT` until the acknowledged full-platform teardown path sets `allowProjectDeletion=true`.

## Shared Contract

Pulumi project name: `windrun-ai`.

Stack names and kinds:

```text
foundation       -> foundation
delivery         -> delivery
production       -> production
production-edge  -> production-edge
staging          -> staging
staging-edge     -> staging-edge
pr-N             -> preview
```

Config keys:

```text
windrun-ai:stackKind
windrun-ai:gitCommitSha
windrun-ai:pullRequestNumber
windrun-ai:allowProjectDeletion
windrun-ai:enablePulumiGithubOidc
windrun-ai:pulumiOrganization
windrun-ai:digitalOceanToken
pulumi:disable-default-providers
```

Foundation identity outputs:

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

Application outputs are `publicUrl`, `projectId`, `serviceName`, and `imageDigest`. Edge outputs are `publicUrl`, `globalIp`, and `certificateStatus`.

Runtime metadata is injected only when Cloud Run starts:

```text
APP_ENVIRONMENT
GCP_PROJECT_ID
GOOGLE_CLOUD_REGION
GIT_COMMIT_SHA
PULUMI_STACK
NEXT_PUBLIC_CANONICAL_HOST
```

Cloud Run supplies `K_SERVICE` and `K_REVISION`.

## Execution Order

### Task 1: Establish an isolated implementation branch

- [ ] Commit the approved specification and all three detailed plans on `main`.
- [ ] Create or enter an ignored worktree on branch `codex/windrun-cloudrun-platform`.
- [ ] Install the existing repository dependencies and run the starter baseline checks.
- [ ] Record the branch base commit in the subagent-driven-development progress ledger.

### Task 2: Build and verify the application/container track

- [ ] Execute all tasks in `2026-07-12-windrun-application-container.md` in order using red-green-refactor cycles.
- [ ] Review every task diff for spec compliance and code quality before continuing.
- [ ] Finish with application tests, lint, typecheck, production build, standalone-path check, image build, and local container smoke test passing.

### Task 3: Build and verify the Pulumi infrastructure track

- [ ] Execute all tasks in `2026-07-12-windrun-pulumi-infrastructure.md` in order using Pulumi mocks before live previews.
- [ ] Prove explicit provider assignment, project isolation, IAM boundaries, DNS/certificate ordering, URL-mask routing, immutable image flow, GitHub resource ownership, and guarded deletion in tests.
- [ ] Run the full infrastructure test/typecheck suite and static script-policy checks.

### Task 4: Build and verify the CI/operations track

- [ ] Execute all tasks in `2026-07-12-windrun-ci-operations.md` in order.
- [ ] Keep credentialed preview work in reusable workflows pinned to `main`; same-repository callers only, never `pull_request_target`.
- [ ] Confirm every update queues without cancellation and performs quality checks plus preview before `up`.
- [ ] Confirm operations helpers perform no direct provider mutation and use Pulumi for every state change.
- [ ] Run helper tests, workflow contract tests, `actionlint`, and the prohibited-pattern scan.

### Task 5: Run the whole-branch quality gate

- [ ] Run dependency integrity, formatting, lint, typecheck, all unit/component/mock tests, Next production build, and CI contract validation.
- [ ] Build and smoke-test the container locally.
- [ ] Generate a whole-branch review package and complete final spec/code review.
- [ ] Fix every Critical or Important finding and repeat affected verification.

### Task 6: Revalidate live identities before mutation

- [ ] Verify the active gcloud configuration and ADC both belong to `rohan@windrun.ai`.
- [ ] Verify Pulumi is logged into only the clean Windrun agent/claimed account and is not a Composio organization.
- [ ] Verify GitHub is `rohanprabhu` with admin access to repository `1095528250`.
- [ ] Verify the DigitalOcean token can read `windrun.ai` and remains available only through Keychain/encrypted Pulumi configuration.
- [ ] Abort live mutation on any identity mismatch.

### Task 7: Bootstrap and deploy the isolated Google Cloud platform

- [ ] Initialize fixed Pulumi stacks with default GCP providers disabled.
- [ ] Move the DigitalOcean token into encrypted foundation config and verify encryption before deleting the Keychain item.
- [ ] Preview and apply `foundation` locally with the exact Windrun ADC identity.
- [ ] Preview and apply in order: `production`, `production-edge`, `staging`, `staging-edge`.
- [ ] Wait for DNS delegation and certificate readiness with bounded polling.
- [ ] Verify production/staging URLs, HTTP-to-HTTPS redirects, health/status APIs, load-balancer IPs, and blocked direct Cloud Run ingress.

### Task 8: Complete the Pulumi claim checkpoint and delivery stack

- [ ] Ask the user to claim the Pulumi account with `rohan@windrun.ai` only after all autonomous pre-claim work is complete.
- [ ] Re-authenticate, derive the transferred Pulumi login, and confirm existing stacks are visible.
- [ ] Preview and apply `delivery` locally; it creates the Pulumi OIDC issuer plus GitHub environments, branch policies, and Actions variables through Pulumi.
- [ ] Verify no long-lived Pulumi/GCP/GitHub CI secret exists and keyless workflow previews authenticate successfully.

### Task 9: Prove the dynamic preview lifecycle

- [ ] Preview/apply `pr-1` in the staging project and verify `https://pr-1.staging.app.windrun.ai` through the unchanged staging load balancer.
- [ ] Confirm the staging-edge stack has no diff when the preview appears.
- [ ] Destroy/remove `pr-1`, confirm the preview route stops serving, and confirm staging remains healthy.
- [ ] Exercise an actual same-repository pull request when repository workflow rollout is available.

### Task 10: Hand off a reproducible operating state

- [ ] Record stack outputs and acceptance results without secrets.
- [ ] Confirm the checked-in runbooks cover new fixed environments, previews, privileged edge/foundation changes, delivery configuration, and ordered teardown.
- [ ] Push the implementation branch and open a reviewed pull request if repository state and user authorization permit.
- [ ] Report any remaining human-only checkpoint precisely; do not claim CI completion before the claim/delivery step is actually complete.

## Live Acceptance Matrix

| Target | Required result |
| --- | --- |
| `https://app.windrun.ai` | Production page and `/api/health` return through production LB |
| `https://staging.app.windrun.ai` | Staging page and health return through staging LB |
| `https://pr-1.staging.app.windrun.ai` | Preview resolves through wildcard DNS/certificate and URL-mask NEG |
| Production `run.app` URL | Cannot bypass the load balancer ingress policy |
| Staging `run.app` URL | Cannot bypass the load balancer ingress policy |
| Staging edge preview after `pr-1` | No resource change |
| Fork pull request | Quality only; no OIDC credential or deploy job |
| Same-repository pull request | Non-canceling preview update and deterministic URL comment |
| Preview close | Preview stack destroyed/removed without edge mutation |
| Full teardown dry run | Refuses without `--destroy-projects` and prints exact order |

## Final Verification Commands

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:ci
pnpm ci:validate-contract
shellcheck scripts/*.sh infra/scripts/*.sh
actionlint
```

Commands that are unavailable locally must be installed or run through the pinned tool invocation documented in the detailed plans; their checks may not be silently skipped.
