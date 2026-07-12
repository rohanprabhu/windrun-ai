# Windrun platform teardown

Use these operations only from a trusted local checkout. The scripts use Pulumi as the sole mutation boundary: they run no mutating `gcloud`, `doctl`, or `gh` subcommands.

## Environment-only teardown

Preview an environment plan without changing resources:

```bash
node scripts/ops/destroy-environment.mjs --environment staging
node scripts/ops/destroy-environment.mjs --environment production
```

Apply the corresponding environment teardown only after reviewing the plan:

```bash
node scripts/ops/destroy-environment.mjs --environment staging --apply
node scripts/ops/destroy-environment.mjs --environment production --apply
```

Staging removes numeric previews before the static environment. These commands never touch `delivery` or `foundation`.

## Acknowledged full teardown

The sole full-destroy invocation is:

```bash
node scripts/ops/destroy-platform.mjs --destroy-projects
```

The `--destroy-projects` flag explicitly acknowledges deletion of all three GCP projects. Without it, the script exits with refusal status 2 before making any process call.

The dependency order is fixed:

1. all numeric `pr-*` stacks, sorted numerically
2. `staging`
3. `production`
4. `staging-edge`
5. `production-edge`
6. `delivery`
7. `foundation`

The script inventories only fully qualified Pulumi stack names and rejects either `updateInProgress: true` or a malformed `updateInProgress` value. It verifies the preview, application, and edge stacks are absent or empty after their destroys, repeats that gate after the delivery-disable update and before delivery destroy, repeats it immediately before the foundation transition, and checks it again after foundation destroy. Any malformed, pending, corrupt, duplicate, protected, or otherwise unexpected state stops the operation.

## Delivery and credential boundary

If `delivery` exists, the script runs the repository contract and quality checks before changing it. It then sets `windrun-ai:enablePulumiGithubOidc=false`, previews and applies that update so `PULUMI_CI_ENABLED` is false, and only then destroys `delivery`.

The local Pulumi and GitHub tokens are supplied only through the delivery child-process environment. Provider output is buffered and exact-token redacted, token properties are cleared after use, and neither token is placed in arguments, Pulumi config, logs, state, or commits. Delivery must be absent or empty before foundation can change.

## Google identity and project deletion transition

Before the first destructive Pulumi command, again immediately before the foundation transition, and again before any recovery update, both the active gcloud account and Application Default Credentials must resolve to exactly `rohan@windrun.ai`. The only gcloud commands the lifecycle permits are these two read-only checks:

```bash
gcloud auth list --filter=status:ACTIVE --format=value(account)
gcloud auth application-default print-access-token
```

The ADC token is used only with Google's OpenID userinfo endpoint and is never printed. There is no mutating gcloud exception.

After the second identity check, the script verifies the normal foundation checkpoint: every surviving non-root resource is protected and the exact shared, staging, and production projects each have `deletionPolicy: PREVENT`. It then sets `windrun-ai:allowProjectDeletion=true` and runs a JSON diff preview.

That preview must contain the exact current resource set and only these changes:

- every surviving non-root resource changes from protected to `protect:false`;
- the three exact GCP projects change only from `deletionPolicy: PREVENT` to `deletionPolicy: DELETE`;
- there are no creates, deletes, replacements, imports, pending operations, integrity errors, or unrelated input changes.

Only after the preview passes and is displayed does the script run foundation `up`. It exports state again and requires every survivor to be unprotected plus exactly three project resources with `deletionPolicy: DELETE`. Foundation destruction is refused if any earlier stack, including `delivery`, still has a non-root resource.

## Recovery boundary

If a failure may have occurred after the deletion transition began but before foundation is fully destroyed, the script re-verifies both Google identities, resets `windrun-ai:allowProjectDeletion=false`, previews recovery, and applies foundation again. It then requires every surviving resource to be protected and all three project policies restored to `PREVENT` before returning the original failure. If even recovery state is unexpected, the script fails closed and reports the recovery failure as well.

Success is reported only after a final fully qualified inventory proves all earlier stacks remain absent or empty and the `foundation` stack is absent after `destroy --remove`. After that successful foundation destroy, all three projects enter `DELETE_REQUESTED`. Google provides a 30-day recovery window, but the project IDs are permanently unavailable for reuse by a different project.
