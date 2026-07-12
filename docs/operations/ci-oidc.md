# Enable secretless CI after the Pulumi account claim

[Operations index](README.md) · [Bootstrap](bootstrap.md) · [Preview trust](preview-environments.md#exact-oidc-trust) · [Privileged operations](edge-and-foundation.md)

This is a human checkpoint. Claiming the temporary Pulumi account transfers the existing stacks and ESC state to the owner, invalidates the ephemeral agent credential, and restores durable write access. Complete it before the local-only `delivery` stack is created. Do not ask an agent or unattended job to claim, log in, or run this checkpoint.

## Re-authenticate and enable delivery

After completing the claim with `rohan@windrun.ai` as the ownership email, run these commands yourself from the repository root:

```bash
pulumi logout
pulumi login
pulumi whoami --json
node scripts/ops/enable-ci-after-claim.mjs --confirm-claimed-by rohan@windrun.ai
```

The ownership email is not assumed to be the canonical Pulumi login. The enablement command derives that login only from `pulumi whoami --json`, requires the exact managed backend `https://api.pulumi.com`, and uses the raw login for the fully qualified foundation and delivery stack names.

The command also requires the active `gh` account to be `rohanprabhu`. Its only GitHub CLI subprocesses are the exact read-only credential checks:

```bash
gh auth status --hostname github.com
gh auth token --hostname github.com
```

It never uses `gh` to mutate a repository, environment, policy, variable, workflow, or secret. These authorized `gh auth` reads are intentionally outside the prohibited mutation patterns `gh api` and `gh variable set`.
Operationally, it invokes `gh auth status` and `gh auth token` only; the exact production invocations always include `--hostname github.com` as shown above.

## Credential boundary

The claimed Pulumi token is read from the current local credentials entry for `https://api.pulumi.com`. The GitHub token is read from the verified local `gh` account. Neither token is printed, added to command arguments, exported into the parent shell, written to stack configuration, or stored as a GitHub Actions secret.

Both values exist only in the child-process environment for the one `pulumi preview` and one `pulumi up` of `delivery`: the Pulumi token is supplied as `PULUMI_ACCESS_TOKEN` to the explicit Pulumi Service provider, and the GitHub token is supplied as `GITHUB_TOKEN` to the explicit GitHub provider. Provider stdout and stderr are buffered and scrubbed of both exact credential values before they reach the terminal. The token variables and shared provider environment are cleared in a `finally` path, and the credentials are never stored in Pulumi config or state.

Every GitHub and Pulumi Cloud configuration mutation is performed by that `pulumi preview` and `pulumi up` of `delivery`. The command performs no direct cloud or GitHub mutation outside Pulumi. `delivery` is local-only and the sole owner of GitHub environments, deployment policies, repository Actions variables, and the Pulumi Cloud OIDC issuer.

## Fail-closed prerequisites

Before delivery initialization, the command verifies that all twelve typed foundation identity outputs are non-empty:

```text
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

It then selects or initializes `<LOGIN>/windrun-ai/delivery` and sets only:

```text
windrun-ai:stackKind=delivery
windrun-ai:pulumiOrganization=<LOGIN from pulumi whoami>
windrun-ai:enablePulumiGithubOidc=true
```

`pnpm ci:validate-contract` and `pnpm ci:quality` must both pass before preview. Any identity, backend, credential, foundation-output, quality, preview, or apply failure stops the sequence. Child output is not incorporated into enablement errors, so token-shaped values cannot be echoed through an exception.

On success, Pulumi creates the six GitHub environments, seven deployment policies, Pulumi OIDC issuer, `PULUMI_ORGANIZATION`, twelve GCP identity variables, and final `PULUMI_CI_ENABLED=true` gate. The fourteen non-secret repository variables are:

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

The gate depends on the issuer, all environments and policies, and the other thirteen variables, so it is registered last. The exact live secretless check remains [pending acceptance](README.md#secretless-repository-configuration) until the account claim and bootstrap are complete.
