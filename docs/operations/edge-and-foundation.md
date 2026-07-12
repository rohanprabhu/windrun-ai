# Privileged edge and foundation operations

[Operations index](README.md) · [CI OIDC](ci-oidc.md) · [Teardown](teardown.md)

Edge and foundation changes are manually dispatched from `main`. They are available only after post-claim delivery has set `PULUMI_CI_ENABLED=true`, and the target GitHub environment must approve both preview-only and apply jobs.

## Preview before deciding to apply

Dispatch the exact preview for each privileged stack:

```bash
gh workflow run manage-edge.yml --ref main -f stack=production-edge -f operation=preview
gh workflow run manage-edge.yml --ref main -f stack=staging-edge -f operation=preview
gh workflow run manage-foundation.yml --ref main -f operation=preview
```

The dispatched job enters the matching `production-edge`, `staging-edge`, or `foundation` environment approval gate before checkout or authentication. Reviewer User ID `136263` is required, administrators cannot bypass the gate, and `preventSelfReview=false`. Approve the job in GitHub, wait for it to complete, and retain its Pulumi preview as the review artifact.

Only after accepting that preview should an operator dispatch the corresponding apply:

```bash
gh workflow run manage-edge.yml --ref main -f stack=production-edge -f operation=apply
gh workflow run manage-edge.yml --ref main -f stack=staging-edge -f operation=apply
gh workflow run manage-foundation.yml --ref main -f operation=apply
```

An apply dispatch requires a new environment approval. The workflow reruns repository contract and quality checks, authenticates with the stack-specific identity, displays a fresh Pulumi preview, and only then runs `pulumi up`. Neither workflow exposes a destroy operation; use the [teardown runbook](teardown.md) for removal.

## Identity and project isolation

| Stack and environment | GCP project | WIF repository variable | Service-account repository variable | Foundation output pair |
| --- | --- | --- | --- | --- |
| `production-edge` | `windrun-ai-prod-20260712` | `GCP_WIF_PROVIDER_PRODUCTION_EDGE` | `GCP_SERVICE_ACCOUNT_PRODUCTION_EDGE` | `productionEdgeWifProvider` / `productionEdgeDeployServiceAccount` |
| `staging-edge` | `windrun-ai-staging-20260712` | `GCP_WIF_PROVIDER_STAGING_EDGE` | `GCP_SERVICE_ACCOUNT_STAGING_EDGE` | `stagingEdgeWifProvider` / `stagingEdgeDeployServiceAccount` |
| `foundation` | `windrun-ai-shared-20260712` | `GCP_WIF_PROVIDER_FOUNDATION` | `GCP_SERVICE_ACCOUNT_FOUNDATION` | `foundationWifProvider` / `foundationDeployServiceAccount` |

The production-edge path never reads `stagingEdgeWifProvider` or `stagingEdgeDeployServiceAccount`; the staging-edge path never reads `productionEdgeWifProvider` or `productionEdgeDeployServiceAccount`. Each edge identity has roles only in its own project. Both direct OIDC policies require `workflow_dispatch`, `refs/heads/main`, the exact `manage-edge.yml@refs/heads/main` caller, and the selected environment claim.

Foundation uses its separate project-local identity and exact `manage-foundation.yml@refs/heads/main` trust. Normal reviewed foundation updates can manage the existing cross-project control resources allowed by its condition-limited roles, but that CI identity has no organization or billing-account role. Initial project creation, project metadata or billing repair, and final project deletion are local-only operations under the exact `rohan@windrun.ai` gcloud and ADC checks.

Each target has its own non-canceling queue: `windrun-production-edge`, `windrun-staging-edge`, or `windrun-foundation`, all with `cancel-in-progress: false`. Never interrupt a Pulumi update to start a newer dispatch.
