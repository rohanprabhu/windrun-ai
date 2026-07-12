# Pull-request preview environments

[Operations index](README.md) · [CI OIDC](ci-oidc.md) · [Teardown](teardown.md)

Preview environments are automatic only for pull requests from `rohanprabhu/windrun-ai` into `main`. Pull-request code is never used as the credentialed Pulumi program.

## Event and branch mapping

| Event on a PR targeting `main` | Quality | Credentialed action |
| --- | --- | --- |
| `opened` | Run from the PR merge SHA | Deploy `pr-<number>` after quality succeeds. |
| `reopened` | Run from the PR merge SHA | Deploy `pr-<number>` after quality succeeds. |
| `synchronize` | Run from the new PR merge SHA | Update `pr-<number>` after quality succeeds. |
| `closed` | Skipped | Destroy and remove `pr-<number>`. |

`pull-request.yml` is a thin caller with repository-level `contents: read`. It contains the uncredentialed quality steps and delegates to only `_preview-deploy.yml@main` or `_preview-destroy.yml@main`. No secrets are inherited, neither reusable workflow declares a secret input, and the caller has no credentialed steps.

Both caller jobs require `PULUMI_CI_ENABLED == 'true'` and a same-repository gate: the head repository ID must equal the event repository ID and the head full name must equal `rohanprabhu/windrun-ai`. Each reusable job revalidates the event type/action, `main` base repository and branch, head repository, PR number, event SHA, and deterministic URL before authentication. A fork PR therefore runs uncredentialed quality for open/update events, receives no credentials, and cannot deploy, destroy, or write a preview comment. The workflows do not use `pull_request_target`.

## Stack, service, and hostname

For PR number `<number>`, all names are deterministic:

```text
Pulumi stack: <LOGIN>/windrun-ai/pr-<number>
Cloud Run service: pr-<number>
URL: https://pr-<number>.staging.app.windrun.ai
Health URL: https://pr-<number>.staging.app.windrun.ai/api/health
```

The staging wildcard DNS record, certificate, URL map, backend, and serverless NEG URL mask already exist in `staging-edge`. Creating or removing a preview changes only its `pr-<number>` application stack; it does not update edge or DNS resources.

## Trusted deploy path

The credentialed deploy job checks out `refs/heads/main` into `platform` and the event's immutable merge SHA into `source`, both with persisted checkout credentials disabled. Setup, authentication, Pulumi, smoke, and comment code run only from `platform`; `source` is supplied only as `WINDRUN_APP_SOURCE`, the Docker build context.

The job displays `pulumi preview` before `pulumi up` and sets only the exact preview stack kind, PR number, and merge SHA. It then runs:

```bash
node platform/scripts/ci/smoke-test.mjs "https://pr-<number>.staging.app.windrun.ai/api/health" --attempts 30 --delay-ms 10000
```

The smoke check allows at most 30 attempts separated by 10 seconds. Network failures and HTTP `404`, `429`, `500`, `502`, `503`, and `504` are retryable. Success requires HTTP 200 with JSON whose `ok` field is exactly `true`; malformed JSON, a false health value, or another status stops immediately.

Deploy and destroy share the concurrency group `windrun-preview-<number>` (implemented as `windrun-preview-${{ inputs.pr-number }}`) with `cancel-in-progress: false`. A close waits behind an in-progress update instead of canceling a Pulumi mutation. Synchronize events are queued rather than coalesced, so an earlier accepted commit can finish before a later queued update.

## One marker comment

The helper owns one GitHub Actions bot comment containing:

```text
<!-- windrun-preview -->
```

It follows pagination, updates only a marker comment authored by `github-actions[bot]`, and creates one if none exists. The deploy comment runs even after a failed apply or smoke check and reports `ready` or `failed` with the run URL. Successful close-time cleanup changes the same comment to `destroyed` and removes the live preview link. If cleanup itself fails, the destroy workflow fails before its comment step, so the earlier comment can remain unchanged; use the workflow result as the source of truth.

## Close-time destroy and remove

The close job checks out only trusted `refs/heads/main`, authenticates with the preview identity, and targets the exact fully qualified `pr-<number>` stack. If the helper cannot find that exact qualified or short stack name, it reports `PREVIEW STACK ABSENT` and succeeds without a destroy. Otherwise it runs the equivalent of:

```text
pulumi destroy --yes --remove --stack <LOGIN>/windrun-ai/pr-<number>
```

`--remove` deletes the empty Pulumi stack after its resources are destroyed.

## Exact OIDC trust

Only `_preview-deploy.yml@main` and `_preview-destroy.yml@main` contain credentialed steps. Pulumi Cloud and the preview GCP Workload Identity provider both pin the reusable jobs through these exact `job_workflow_ref` claims:

```text
rohanprabhu/windrun-ai/.github/workflows/_preview-deploy.yml@refs/heads/main
rohanprabhu/windrun-ai/.github/workflows/_preview-destroy.yml@refs/heads/main
```

Deploy trust accepts only `refs/pull/*/merge` with caller `rohanprabhu/windrun-ai/.github/workflows/pull-request.yml@refs/pull/*/merge`. Destroy trust accepts that PR ref/caller pair and, only for GitHub's merged-close event shape, the exact `refs/heads/main` ref with caller `rohanprabhu/windrun-ai/.github/workflows/pull-request.yml@refs/heads/main`. Both also require the exact repository name, immutable repository ID `1095528250`, owner ID `136263`, `environment=preview`, `event_name=pull_request`, and `base_ref=main`. A wildcard reusable-workflow ref is never trusted.
