# Windrun platform operations

Use this page as the operator entry point for the Windrun Cloud Run platform. Run commands from the repository root. Cloud resources and the delivery plane are changed only through Pulumi; the operation wrappers and workflows add identity, ordering, preview, and approval gates around those updates.

## Runbooks

| Runbook | Use it for |
| --- | --- |
| [Bootstrap](bootstrap.md) | The pre-claim cloud bootstrap, mandatory Pulumi account-claim checkpoint, and post-claim delivery enablement. |
| [Preview environments](preview-environments.md) | Pull-request event mapping, fork isolation, trusted reusable workflows, hostnames, queues, smoke checks, comments, and cleanup. |
| [Edge and foundation](edge-and-foundation.md) | Manually dispatched, approval-gated edge and foundation previews or applies. |
| [CI OIDC](ci-oidc.md) | The human account-claim handoff, secretless CI credentials, delivery ownership, and final CI gate. |
| [Teardown](teardown.md) | Environment-only removal, acknowledged full-platform destruction, refusal gates, and recovery. |

## Operation classes

The four operator categories are Automatic, Manual / approved, Local-only, and Destructive. A single operation can belong to more than one category.

| Operation | Class | Trigger and effect |
| --- | --- | --- |
| Production application deploy | Automatic | A push to `main` runs quality checks, previews `production`, applies it, and smoke-tests `https://app.windrun.ai/api/health`. |
| Staging application deploy | Automatic | A push to `staging` runs quality checks, previews `staging`, applies it, and smoke-tests `https://staging.app.windrun.ai/api/health`. |
| Pull-request preview deploy | Automatic for same-repository PRs | `opened`, `reopened`, and `synchronize` events targeting `main` run quality checks and then preview/apply `pr-<number>`. Fork PRs run only the uncredentialed quality job. |
| Pull-request preview cleanup | Automatic and destructive for same-repository PRs | A `closed` event targeting `main` destroys and removes `pr-<number>`. The per-PR non-canceling queue prevents cleanup from interrupting an in-progress update. |
| Edge or foundation change | Manual / approved | A `workflow_dispatch` from `main` targets `production-edge`, `staging-edge`, or `foundation`. Both preview-only and apply jobs require the target GitHub environment approval. There is no workflow destroy option. |
| Phase-one bootstrap | Local-only | `bootstrap-platform.mjs` previews, or previews and applies, the five pre-claim stacks under the exact local Google identity guard. |
| Pulumi account claim and delivery enablement | Manual / approved and local-only | The owner claims the account, re-authenticates, and runs `enable-ci-after-claim.mjs`; this previews and applies `delivery` locally. |
| Environment teardown | Local-only and destructive with `--apply` | `destroy-environment.mjs` removes staging previews plus staging, or production, and then the matching edge stack. Without `--apply`, it prints the plan only. |
| Full-platform teardown | Local-only and destructive | `destroy-platform.mjs --destroy-projects` disables CI, removes all stacks in dependency order, crosses the reviewed project-deletion boundary, and destroys foundation. |

`delivery` is local-only and is the sole owner of every GitHub environment, deployment policy, repository Actions variable, and Pulumi Cloud OIDC delivery-plane mutation. The local scripts may use `gh auth status` and `gh auth token` to read the exact active account and token, but no `gh` command mutates delivery configuration.

## Static validation

Use Node.js 22 and the repository-pinned pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm ci:quality
pnpm test:ci
pnpm ci:validate-contract
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
rg -n -g '!*.test.mjs' 'pull_request_target|cancel-in-progress: true|gcloud .*create|gcloud .*delete|doctl|gh api|gh variable set' .github scripts
```

Acceptance requires every test and build to pass, actionlint to be silent, and the final executable-source search to exit 1 with no output. That search targets unsafe workflow triggers, canceling mutation queues, vendor-CLI mutations, and direct GitHub API/variable mutation. It deliberately does not prohibit the two local `gh auth` reads or the exact `gcloud auth` identity reads documented in the [teardown runbook](teardown.md). The `*.test.mjs` exclusion is intentional because negative assertions and prohibition prose contain the forbidden text while testing its absence from executable workflows and operation sources.

## Pending acceptance

The following checks have **not** been run by static validation. They remain pending acceptance until the Pulumi account is claimed, the Pulumi CLI is logged in to the claimed managed account, and both bootstrap phases have completed.

### Secretless repository configuration

```bash
gh variable list
gh secret list | rg 'PULUMI_ACCESS_TOKEN|GOOGLE_CREDENTIALS|GCP_SA_KEY'
gh workflow run manage-foundation.yml --ref main -f operation=preview
gh run watch
```

Acceptance requires all fourteen Pulumi-managed repository variables, no matching long-lived secret (the secret search exits 1 with no output), and a foundation job that waits for environment approval and then completes an OIDC-authenticated preview.

### Public health routes

```bash
curl --fail --silent https://app.windrun.ai/api/health
curl --fail --silent https://staging.app.windrun.ai/api/health
```

After bootstrap, each response must be JSON containing `"ok":true`.
