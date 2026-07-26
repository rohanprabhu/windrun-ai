# Bootstrap the Windrun platform

[Operations index](README.md) · [CI account-claim checkpoint](ci-oidc.md) · [Teardown](teardown.md)

Bootstrap is deliberately split into a local pre-claim cloud phase, a mandatory human account-claim checkpoint, and a local post-claim delivery phase. Run every command from the repository root.

## Before phase one

Use Node.js 22, the repository-pinned pnpm, the Pulumi managed backend `https://api.pulumi.com`, and a trusted local checkout. The operations wrapper must be able to run `gcloud auth print-access-token --account=rohan@windrun.ai`; it verifies that token and injects it plus the stack-derived Google project into Pulumi, instead of trusting the active gcloud account, default project, or ADC. The foundation update manages the authoritative Cloud DNS zone for `windrun.ai.` and exports `apexNameServers` for the one-time manual registrar nameserver change.

Install and verify the workspace:

```bash
pnpm install --frozen-lockfile
pnpm ci:quality
```

The bootstrap wrapper repeats `pnpm ci:validate-contract` and `pnpm ci:quality` after the exact Google identity check and before it selects any stack.

## Phase one: cloud stacks before claim

First display the five Pulumi resource previews without applying cloud changes:

```bash
node scripts/ops/bootstrap-platform.mjs
```

This invocation may select or initialize the fully qualified stacks and set their non-secret stack configuration, but it does not run `pulumi up`. Review every displayed preview. To apply, run:

```bash
node scripts/ops/bootstrap-platform.mjs --apply
```

The apply form processes one stack at a time and always displays that stack's preview before its `pulumi up`. The order is fixed:

```text
foundation -> production -> production-edge -> staging -> staging-edge
```

`production` and `staging` receive the current `git rev-parse HEAD` value as `windrun-ai:gitCommitSha`. The primary services precede their edge stacks because each serverless NEG names the fixed Cloud Run service (`production` or `staging`); applying an edge first can fail because that named service does not yet exist.

Successful phase-one execution ends with:

```text
BOOTSTRAP PHASE 1 COMPLETE; CLAIM ACCOUNT BEFORE DELIVERY
```

No phase-one path selects or creates `delivery`.

## Mandatory account-claim checkpoint

Stop after phase one. A human must claim the temporary Pulumi account using `rohan@windrun.ai` as the ownership email, then re-authenticate the Pulumi CLI. Claiming transfers the existing stacks and ESC state, invalidates the ephemeral agent credential, and restores durable owner access. The ownership email does not predict the canonical Pulumi login; that login is derived only from `pulumi whoami --json` after re-authentication.

Do not run delivery before the claim. The `delivery` update needs the durable claimed-account credential to create a Pulumi Cloud OIDC issuer and the repository delivery configuration. Running it with the pre-claim ephemeral credential would bind the delivery plane to a credential that the claim invalidates.

Follow the exact re-authentication and credential boundary in [CI OIDC](ci-oidc.md).

## Phase two: delivery after claim

After the human checkpoint and successful re-authentication, run the only accepted enablement command:

```bash
node scripts/ops/enable-ci-after-claim.mjs --confirm-claimed-by rohan@windrun.ai
```

The wrapper validates the managed Pulumi backend, exact active GitHub account `rohanprabhu`, twelve non-empty foundation identity outputs, and both repository checks. It selects or initializes `<LOGIN>/windrun-ai/delivery`, displays one delivery preview, applies it once, and registers `PULUMI_CI_ENABLED=true` only after the issuer, six environments, seven deployment policies, and the other thirteen repository variables exist.

Successful phase two ends with `DELIVERY ENABLED; BOOTSTRAP COMPLETE`. The live repository and public-route checks remain [pending acceptance](README.md#pending-acceptance) until this phase has actually completed.
