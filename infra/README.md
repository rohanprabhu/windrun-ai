# Windrun infrastructure contract

This directory is the Pulumi TypeScript implementation for the Windrun Cloud Run platform. It owns the cloud-resource graph, typed stack dispatch, static stack configuration, the authoritative Cloud DNS zone for `windrun.ai.`, and the local-only delivery plane. It does not own executable CI or lifecycle orchestration.

`docs/superpowers/plans/2026-07-12-windrun-ci-operations.md` owns `.github/workflows` and executable preview, deploy, destroy, and smoke-test scripts. These infrastructure documents do not create or own those files and authorize no `gh` or mutating `gcloud` command. Cloud and delivery-plane mutations must go through Pulumi; the operations track supplies the guarded commands and exact read-only identity checks.

## Stack and configuration contract

The only Windrun project config keys are:

| Key | Consumer |
| --- | --- |
| `windrun-ai:stackKind` | Every stack; must match the stack name. |
| `windrun-ai:gitCommitSha` | `production`, `staging`, and `preview`; a lowercase 40-character Git SHA. |
| `windrun-ai:pullRequestNumber` | `preview`; must match its `pr-<number>` stack name. |
| `windrun-ai:allowProjectDeletion` | `foundation`; false during normal operation and true only during acknowledged full teardown. |
| `windrun-ai:enablePulumiGithubOidc` | `delivery`; false before account claim and true at the post-claim checkpoint. |
| `windrun-ai:pulumiOrganization` | `delivery`; set to the canonical Pulumi login returned by `pulumi whoami` after claim. |

The seven stack kinds are:

| Kind | Responsibility and dependency |
| --- | --- |
| `foundation` | Creates the three projects and shared DNS, certificates, registries, runtime identities, and six deployment identities. |
| `delivery` | Locally manages GitHub environments/policies/variables and Pulumi Cloud OIDC after account claim. It consumes `foundation` outputs. |
| `production` | Builds and deploys the fixed production Cloud Run service. It consumes `foundation` outputs. |
| `production-edge` | Creates production load-balancing resources for the already-deployed production service. |
| `staging` | Builds and deploys the fixed staging Cloud Run service. It consumes `foundation` outputs. |
| `staging-edge` | Creates staging load-balancing resources for the already-deployed staging service. |
| `preview` | Builds a `pr-<number>` Cloud Run service in staging without per-preview edge resources. |

`foundation`, `delivery`, `production`, `production-edge`, `staging`, and `staging-edge` have committed static stack files. Preview configuration is created dynamically and is never committed.

## Foundation outputs

Every consumer uses a typed `StackReference`. The exact foundation output names are:

```text
sharedProjectId
stagingProjectId
productionProjectId
stagingRepositoryId
productionRepositoryId
stagingRuntimeServiceAccountEmail
productionRuntimeServiceAccountEmail
stagingGlobalIp
productionGlobalIp
apexNameServers
stagingCertificateMapId
productionCertificateMapId
stagingCertificateStatus
productionCertificateStatus
foundationWifProvider
foundationDeployServiceAccount
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
```

Missing, empty, or renamed outputs are contract violations. The last 12 values are six distinct WIF-provider/deploy-service-account pairs; delivery publishes them as non-secret repository variables.

## Two-phase bootstrap

### Phase 1: GCP resources before account claim

The first foundation update is local-only. The operations wrapper requests a short-lived token with `gcloud auth print-access-token --account=rohan@windrun.ai`, verifies that token resolves to exactly `rohan@windrun.ai`, and passes `GOOGLE_OAUTH_ACCESS_TOKEN` plus a stack-derived `GOOGLE_CLOUD_PROJECT` only to the Pulumi child process. The active/default gcloud account, default project, and Application Default Credentials are not trusted. `rohan@windrun.ai` must have the required organization project-lifecycle and billing permissions. The bootstrap GCP provider intentionally has no project; per-project providers are created only after the project outputs exist.

Explicit `rohan@windrun.ai` token auth allows this pre-claim order:

```text
foundation -> production -> production-edge -> staging -> staging-edge
```

Supply `windrun-ai:gitCommitSha` to the two application stacks. `production` must precede `production-edge`, and `staging` must precede `staging-edge`, because each edge stack names a Cloud Run service rather than consuming an application-stack output. Phase 1 ends without selecting or creating `delivery`.

### Phase 2: delivery after account claim

Complete the Pulumi account claim using `rohan@windrun.ai` as the ownership email, discard the invalidated ephemeral credential, and re-authenticate Pulumi. `rohan@windrun.ai` is the claim email, not the Pulumi login; the login remains unknown until re-authentication. `windrun-ai:pulumiOrganization` comes only from `pulumi whoami`. Initialize `delivery` locally with that exact result, then set `windrun-ai:enablePulumiGithubOidc=true`.

Export `GITHUB_TOKEN` and `PULUMI_ACCESS_TOKEN` into the local shell from their secure post-claim credential sources. Never print, commit, or place either value in Pulumi config. Apply `delivery` locally through the operations wrapper; it continues to mint and verify the explicit `rohan@windrun.ai` Google token instead of using ADC.

The dispatcher validates `GITHUB_TOKEN`; it also validates `PULUMI_ACCESS_TOKEN` when OIDC is enabled. The GitHub provider plugin consumes `GITHUB_TOKEN` from the Pulumi child-process environment. The Pulumi Service provider plugin consumes `PULUMI_ACCESS_TOKEN` from that environment. Explicit provider resources persist only non-secret configuration: GitHub owner `rohanprabhu` with official endpoint `https://api.github.com/`, and the Pulumi Service official endpoint `https://api.pulumi.com`. Tokens are not provider inputs or Pulumi state. No token is an output, resource name, Actions variable, log value, or committed value. Delivery invokes no `gh` command.

Preview CI remains disabled until delivery creates every issuer, environment, policy, and variable prerequisite and registers `PULUMI_CI_ENABLED=true` last.

## Delivery-owned policy

Delivery creates these six GitHub environments and custom branch policies:

```text
foundation: main
production: main
production-edge: main
staging: staging
staging-edge: main
preview: refs/pull/*/merge and main
```

All six environments use custom branch policies. The privileged `foundation`, `production-edge`, and `staging-edge` environments require reviewer ID 136263, and administrators cannot bypass their protection. `preventSelfReview` is false. The other environments have no configured reviewer. Pulumi Cloud policies additionally pin repository/owner IDs, environment, event, ref, workflow, and—where preview credentials are issued—the main-pinned reusable workflow.

Delivery writes exactly these non-secret repository variables:

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

The six variable pairs map one-to-one to the identity outputs:

| Environment | WIF output | Service-account output |
| --- | --- | --- |
| `foundation` | `foundationWifProvider` | `foundationDeployServiceAccount` |
| `production` | `productionWifProvider` | `productionDeployServiceAccount` |
| `production-edge` | `productionEdgeWifProvider` | `productionEdgeDeployServiceAccount` |
| `staging` | `stagingWifProvider` | `stagingDeployServiceAccount` |
| `staging-edge` | `stagingEdgeWifProvider` | `stagingEdgeDeployServiceAccount` |
| `preview` | `previewWifProvider` | `previewDeployServiceAccount` |

Delivery is local-only and can be recreated from foundation outputs after account claim. Pulumi Individual uses personal OIDC policies; requiring organization-scoped CI tokens instead makes a Pulumi Team organization a prerequisite.

## Teardown boundary

Independent Pulumi stacks do not acquire destroy ordering from `StackReference`. The mandatory cross-stack invariant is:

```text
all preview/application/edge stacks empty
-> delivery destroyed
-> explicit rohan@windrun.ai Google token and stack project injected into Pulumi
-> windrun-ai:allowProjectDeletion=true previewed and applied locally
-> foundation state verified unprotected with deletionPolicy: DELETE
-> foundation destroyed locally as rohan@windrun.ai
```

Within the foundation destroy graph, Cloud DNS record sets are deleted before the apex zone, validation CNAMEs are deleted after certificates, and projects are scheduled last. The delivery stack must be gone before the foundation transition because it consumes foundation outputs and owns the CI gate.

See `infra/TEARDOWN.md` for the invariant in operational-review form. The executable teardown, refusal gates, identity checks, and recovery path belong to `docs/superpowers/plans/2026-07-12-windrun-ci-operations.md`.

After successful foundation destruction, all three GCP projects enter `DELETE_REQUESTED` with a 30-day recovery window. Even if a project is recovered during that window, deleted project IDs can never be reused for a new project.

## Local verification

From the repository root, the infrastructure track is verified with `pnpm -C infra check`.
