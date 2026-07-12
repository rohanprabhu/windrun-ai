# Windrun infrastructure teardown contract

This document defines dependency and safety invariants, not an executable destroy procedure. `docs/superpowers/plans/2026-07-12-windrun-ci-operations.md` owns `.github/workflows` and executable preview, deploy, destroy, and smoke-test scripts. These infrastructure documents do not create or own those files and authorize no `gh`, mutating `gcloud`, or `doctl` command. Use the operations-track implementation for refusal gates, dry runs, confirmations, and exact read-only identity checks.

## Non-negotiable cross-stack order

`StackReference` reads outputs but does not order the destruction of independent stacks. A full teardown must establish this sequence:

```text
all preview/application/edge stacks empty
-> delivery destroyed
-> exact active gcloud + ADC identity verified as rohan@windrun.ai
-> windrun-ai:allowProjectDeletion=true previewed and applied locally
-> foundation state verified unprotected with deletionPolicy: DELETE
-> foundation destroyed locally as rohan@windrun.ai
```

The first condition covers every numeric `pr-<number>` preview and the `production`, `production-edge`, `staging`, and `staging-edge` stacks. Verify that each is absent or contains no non-root resource before touching delivery. Delivery is destroyed locally with its secure provider credential environment available, then verified absent or empty before foundation can cross the deletion boundary.

Project creation, metadata and billing drift repair, and final deletion are local-only Pulumi operations. Immediately before the foundation transition, both the active gcloud account and Application Default Credentials must resolve to exactly `rohan@windrun.ai`. The foundation CI identity has neither organization nor billing-account permission and cannot perform this escalation.

Normal foundation state has protection enabled and project `deletionPolicy: PREVENT`. Only after delivery is gone may an explicitly acknowledged full teardown set `windrun-ai:allowProjectDeletion=true`. Review the local preview, apply it locally, and inspect persisted foundation state to prove every surviving resource is unprotected and each project has `deletionPolicy: DELETE`. Only then may foundation be destroyed locally.

If the transition applies but a later operation fails while foundation resources survive, the operations path must restore `windrun-ai:allowProjectDeletion=false`, apply foundation locally, and verify protection plus `deletionPolicy: PREVENT` before exiting.

Within foundation, dependency reversal must preserve these rules: DigitalOcean delegation is deleted before Cloud DNS, validation CNAMEs are deleted after certificates, and projects are scheduled last.

## Project deletion semantics

Successful foundation destruction schedules all three projects for deletion. They enter `DELETE_REQUESTED` with a 30-day recovery window; this is not immediate erasure. Recovery may restore a scheduled project during that window, but deleted project IDs can never be reused to create a different project. The permanent non-reuse rule applies to the shared, staging, and production IDs.

## Delivery checkpoint and teardown credentials

The original bootstrap is two-phase. Local ADC and encrypted DigitalOcean secret bootstrap permit the initial GCP order:

```text
foundation -> production -> production-edge -> staging -> staging-edge
```

Delivery does not exist before Pulumi account claim. After claim and Pulumi re-authentication, initialize it locally, set `windrun-ai:pulumiOrganization` to `pulumi whoami`, set `windrun-ai:enablePulumiGithubOidc=true`, and export `GITHUB_TOKEN` plus `PULUMI_ACCESS_TOKEN` from secure post-claim credential sources without printing or committing them. Apply `delivery` locally; it registers `PULUMI_CI_ENABLED=true` only after its issuer, environment, policy, and variable prerequisites exist.

The dispatcher validates `GITHUB_TOKEN` and, when OIDC is enabled, `PULUMI_ACCESS_TOKEN`. The GitHub provider plugin consumes `GITHUB_TOKEN` from the Pulumi child-process environment. The Pulumi Service provider plugin consumes `PULUMI_ACCESS_TOKEN` from that environment. Explicit provider resources contain only the official endpoints—`https://api.github.com/` and `https://api.pulumi.com`—so the credentials are not provider inputs or Pulumi state. Never move either token into config, outputs, Actions variables, logs, resource names, or commits. Delivery invokes no `gh` command. The same secure local environment must be available when destroying delivery so Pulumi can remove what it created.

Delivery owns six environments with these branch patterns:

```text
foundation: main
production: main
production-edge: main
staging: staging
staging-edge: main
preview: refs/pull/*/merge and main
```

The privileged `foundation`, `production-edge`, and `staging-edge` environments require reviewer ID 136263, and administrators cannot bypass. `preventSelfReview` is false. The production, staging, and preview environments have no configured reviewer. Delivery owns six distinct WIF/service-account pairs and these exact non-secret variables:

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

## Reference contract for teardown review

The only seven Windrun config keys are:

```text
windrun-ai:stackKind
windrun-ai:gitCommitSha
windrun-ai:pullRequestNumber
windrun-ai:allowProjectDeletion
windrun-ai:enablePulumiGithubOidc
windrun-ai:pulumiOrganization
windrun-ai:digitalOceanToken
```

The only seven stack kinds are `foundation`, `delivery`, `production-edge`, `production`, `staging-edge`, `staging`, and `preview`. The six static GCP/delivery stack files are committed; `preview` uses a dynamic `pr-<number>` name and config.

Foundation exposes these exact outputs:

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

The six identity pairs are `foundationWifProvider`/`foundationDeployServiceAccount`, `productionWifProvider`/`productionDeployServiceAccount`, `productionEdgeWifProvider`/`productionEdgeDeployServiceAccount`, `stagingWifProvider`/`stagingDeployServiceAccount`, `stagingEdgeWifProvider`/`stagingEdgeDeployServiceAccount`, and `previewWifProvider`/`previewDeployServiceAccount`. Delivery can be recreated from these outputs after account claim; foundation cannot be deleted while delivery still consumes them.

## Review evidence

Before authorizing the destructive foundation step, the operator must retain reviewable evidence that every earlier stack is empty, delivery is gone, both Google identities are exact, the protection/deletion-policy preview was accepted, and persisted foundation state matches the preview. Infrastructure verification remains `pnpm -C infra check` plus `shellcheck infra/scripts/bootstrap-foundation-secret.sh`; executable lifecycle behavior remains in the CI/operations track.
