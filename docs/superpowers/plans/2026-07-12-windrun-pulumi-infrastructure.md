# Windrun Pulumi Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Pulumi TypeScript infrastructure for the three-project Windrun Cloud Run platform, including foundation, application, edge, preview, and the delivery-plane resources that enable keyless CI, while defining the contracts consumed by the separate deployment and ordered-teardown plan.

**Architecture:** One Pulumi project in `infra/` dispatches by validated stack name and stack configuration into foundation, local-only delivery, application, edge, or preview builders. Foundation owns GCP/DigitalOcean resources and exports WIF values; post-claim delivery consumes those outputs and owns Pulumi Cloud OIDC plus GitHub environments, deployment policies, and Actions variables. Project creation, project metadata/billing repair, and final project deletion remain local Pulumi operations under an exact `rohan@windrun.ai` guard and are never delegated to CI. Every GCP resource receives an explicit provider, and routine application identities cannot cross the production/staging boundary.

**Tech Stack:** Pulumi TypeScript, `@pulumi/gcp` 9.29.0, `@pulumi/digitalocean` 4.75.0, `@pulumi/docker-build` 0.0.20, `@pulumi/pulumiservice` 1.3.0, `@pulumi/github` 6.14.0, Vitest, pnpm, Google Cloud Run v2, Google Certificate Manager, Cloud DNS, DigitalOcean DNS, GitHub environments/variables, and GitHub OIDC federation resources.

## Global Constraints

- Source design: `docs/superpowers/specs/2026-07-12-windrun-cloudrun-platform-design.md`.
- Google Cloud Organization: `391332700711`.
- Billing account: `018EDA-2A53D0-A39B57`.
- Shared project: `windrun-ai-shared-20260712`.
- Staging/preview project: `windrun-ai-staging-20260712`.
- Production project: `windrun-ai-prod-20260712`.
- Region: `asia-south1`.
- Parent DNS remains `windrun.ai` in DigitalOcean; delegated Cloud DNS zone is `app.windrun.ai.`.
- Production hostname: `app.windrun.ai`.
- Staging hostname: `app.staging.windrun.ai`.
- Preview hostnames: `pr-<number>.app.staging.windrun.ai`; preview stack names must match `^pr-[1-9][0-9]*$`.
- No Shared VPC, runtime network sharing, static service-account keys, default GCP provider, per-preview load balancer, per-preview IP, per-preview DNS record, or per-preview certificate.
- Shell scripts and workflows may invoke Pulumi; they must never mutate cloud resources with `gcloud`, `doctl`, or vendor consoles.
- Project deletion policy is `PREVENT` unless `allowProjectDeletion=true` during acknowledged full teardown.
- No secrets, access tokens, credential JSON, or decrypted Pulumi values may be stack outputs or workflow logs.
- The only Windrun project config keys are `windrun-ai:stackKind`, `windrun-ai:gitCommitSha`, `windrun-ai:pullRequestNumber`, `windrun-ai:allowProjectDeletion`, `windrun-ai:enablePulumiGithubOidc`, `windrun-ai:pulumiOrganization`, and encrypted `windrun-ai:digitalOceanToken`.
- GitHub workflows and high-level preview/deploy/destroy/smoke-test scripts are owned exclusively by `docs/superpowers/plans/2026-07-12-windrun-ci-operations.md`; this plan must not create them.
- The local-only `delivery` stack is applied after the Pulumi account is claimed, uses explicit GitHub and Pulumi Service providers authenticated only by local `GITHUB_TOKEN` and `PULUMI_ACCESS_TOKEN` environment variables, performs no direct vendor-CLI mutations, and is destroyed before foundation.

---

## File Structure

Create the following files; do not move application code as part of this track:

```text
infra/
  Pulumi.yaml
  Pulumi.foundation.yaml
  Pulumi.delivery.yaml
  Pulumi.production-edge.yaml
  Pulumi.production.yaml
  Pulumi.staging-edge.yaml
  Pulumi.staging.yaml
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  TEARDOWN.md
  src/
    index.ts
    config.ts
    constants.ts
    providers.ts
    foundation-outputs.ts
    types.ts
    foundation/
      index.ts
      projects.ts
      services.ts
      registries.ts
      addresses.ts
      identities.ts
      dns.ts
      certificates.ts
      github-wif.ts
    delivery/
      index.ts
      github.ts
      pulumi-oidc.ts
    stacks/
      app.ts
      edge.ts
  scripts/
    bootstrap-foundation-secret.sh
  tests/
    helpers/
      pulumi-mocks.ts
    config.test.ts
    providers.test.ts
    foundation-projects.test.ts
    foundation-dns-certificates.test.ts
    foundation-identity.test.ts
    delivery.test.ts
    app-stack.test.ts
    edge-stack.test.ts
    dispatcher.test.ts
    stack-config.test.ts
    secret-bootstrap.test.ts
    documentation.test.ts
```

Responsibilities are deliberately narrow:

- `config.ts` performs pure stack-name/config validation.
- `providers.ts` is the sole constructor for bootstrap and per-project GCP providers.
- `foundation-outputs.ts` is the sole typed boundary for consumers of the foundation stack.
- Each file under `foundation/` owns one resource family.
- Each file under `delivery/` owns Pulumi Cloud or GitHub delivery-plane resources and never creates GCP/DigitalOcean resources.
- `stacks/app.ts` owns Docker Build plus Cloud Run only.
- `stacks/edge.ts` owns serverless NEGs and global load-balancer resources only.
- `bootstrap-foundation-secret.sh` only transfers the DigitalOcean token from Keychain to encrypted Pulumi config.
- `docs/superpowers/plans/2026-07-12-windrun-ci-operations.md` owns all GitHub workflows and high-level lifecycle scripts.

---

### Task 1: Scaffold the Pulumi Package and Validate Stack Configuration

**Files:**
- Create: `infra/package.json`
- Create: `infra/tsconfig.json`
- Create: `infra/vitest.config.ts`
- Create: `infra/Pulumi.yaml`
- Create: `infra/src/constants.ts`
- Create: `infra/src/types.ts`
- Create: `infra/src/config.ts`
- Test: `infra/tests/config.test.ts`

**Interfaces:**
- Consumes: Pulumi stack name and the exact Windrun config contract: `windrun-ai:stackKind`, `windrun-ai:gitCommitSha`, `windrun-ai:pullRequestNumber`, `windrun-ai:allowProjectDeletion`, `windrun-ai:enablePulumiGithubOidc`, and `windrun-ai:pulumiOrganization`. The encrypted `windrun-ai:digitalOceanToken` is read separately only by foundation.
- Produces:

```ts
export type StackKind =
  | "foundation"
  | "delivery"
  | "production-edge"
  | "production"
  | "staging-edge"
  | "staging"
  | "preview";

export interface StackContext {
  kind: StackKind;
  stackName: string;
  serviceName?: string;
  previewNumber?: number;
  gitCommitSha?: string;
}

export interface RawStackConfig {
  stackKind: StackKind;
  gitCommitSha?: string;
  pullRequestNumber?: number;
  allowProjectDeletion?: boolean;
  enablePulumiGithubOidc?: boolean;
  pulumiOrganization?: string;
}

export function parseStackContext(
  stackName: string,
  config: RawStackConfig,
): StackContext;
```

- [ ] **Step 1: Create the package manifest and compiler/test configuration**

Use this installation command so the lockfile captures exact dependency versions:

```bash
pnpm -C infra add --save-exact @pulumi/pulumi @pulumi/gcp@9.29.0 @pulumi/digitalocean@4.75.0 @pulumi/docker-build@0.0.20 @pulumi/pulumiservice@1.3.0 @pulumi/github@6.14.0
pnpm -C infra add --save-dev --save-exact typescript vitest @types/node yaml
```

`infra/package.json` must expose `test`, `typecheck`, and `check` scripts; `check` runs Vitest once followed by TypeScript without emitting files.

`infra/Pulumi.yaml` must declare the shared project contract exactly:

```yaml
name: windrun-ai
runtime:
  name: nodejs
  options:
    packagemanager: pnpm
main: src/index.ts
description: Windrun Cloud Run platform infrastructure
```

- [ ] **Step 2: Write the failing configuration tests**

```ts
import { describe, expect, it } from "vitest";
import { parseStackContext } from "../src/config";

describe("parseStackContext", () => {
  it.each([
    ["foundation", "foundation"],
    ["delivery", "delivery"],
    ["production-edge", "production-edge"],
    ["staging-edge", "staging-edge"],
  ] as const)("accepts static stack %s", (stackName, configuredKind) => {
    expect(parseStackContext(stackName, { stackKind: configuredKind })).toEqual({
      kind: configuredKind,
      stackName,
    });
  });

  it.each(["production", "staging"] as const)(
    "requires deployment metadata for %s",
    (stackName) => {
      expect(
        parseStackContext(stackName, {
          stackKind: stackName,
          gitCommitSha: "0123456789abcdef0123456789abcdef01234567",
        }),
      ).toEqual({
        kind: stackName,
        stackName,
        gitCommitSha: "0123456789abcdef0123456789abcdef01234567",
      });
    },
  );

  it("normalizes pr-42 into a preview service", () => {
    expect(
      parseStackContext("pr-42", {
        stackKind: "preview",
        gitCommitSha: "0123456789abcdef0123456789abcdef01234567",
        pullRequestNumber: 42,
      }),
    ).toEqual({
      kind: "preview",
      stackName: "pr-42",
      serviceName: "pr-42",
      previewNumber: 42,
      gitCommitSha: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it.each(["pr-0", "pr-01", "pr-main", "preview", "production2"])(
    "rejects invalid stack name %s",
    (stackName) => {
      expect(() =>
        parseStackContext(stackName, {
          stackKind: "preview",
          gitCommitSha: "0".repeat(40),
          pullRequestNumber: 42,
        }),
      ).toThrow();
    },
  );

  it("rejects a configured kind that disagrees with the stack name", () => {
    expect(() =>
      parseStackContext("production", {
        stackKind: "staging",
        gitCommitSha: "0".repeat(40),
      }),
    ).toThrow("stackKind staging does not match stack production");
  });

  it("requires a lowercase 40-character commit SHA for application stacks", () => {
    expect(() =>
      parseStackContext("production", {
        stackKind: "production",
        gitCommitSha: "abc",
      }),
    ).toThrow("gitCommitSha must be a lowercase 40-character Git SHA");
  });

  it("requires pullRequestNumber to match the preview stack", () => {
    expect(() =>
      parseStackContext("pr-42", {
        stackKind: "preview",
        gitCommitSha: "0".repeat(40),
        pullRequestNumber: 41,
      }),
    ).toThrow("pullRequestNumber 41 does not match stack pr-42");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/config.test.ts`

Expected: FAIL because `infra/src/config.ts` is missing.

- [ ] **Step 4: Implement minimal pure validation**

Define constants for project IDs, organization, billing account, region, hostnames, fixed service names, GitHub repository ID `1095528250`, owner ID `136263`, and repository `rohanprabhu/windrun-ai`. Static application stacks require `gitCommitSha`; foundation/edge stacks reject it; preview stacks require both `gitCommitSha` and a `pullRequestNumber` matching their name. Foundation accepts only `allowProjectDeletion` in addition to its kind and encrypted DigitalOcean token. Delivery accepts only `enablePulumiGithubOidc` and `pulumiOrganization` in addition to its kind; all other stack kinds reject those delivery-only keys.

- [ ] **Step 5: Run test and typecheck**

Run: `pnpm -C infra check`

Expected: exit 0, all configuration tests pass, and TypeScript emits no errors.

- [ ] **Step 6: Commit**

```bash
git add infra/package.json infra/tsconfig.json infra/vitest.config.ts infra/Pulumi.yaml infra/src/constants.ts infra/src/types.ts infra/src/config.ts infra/tests/config.test.ts pnpm-lock.yaml
git commit -m "feat(infra): scaffold Pulumi stack configuration"
```

---

### Task 2: Build Pulumi Mocks and Enforce Explicit Providers

**Files:**
- Create: `infra/tests/helpers/pulumi-mocks.ts`
- Create: `infra/src/providers.ts`
- Test: `infra/tests/providers.test.ts`

**Interfaces:**
- Consumes: project ID outputs from the foundation project factory.
- Produces:

```ts
export interface ProjectProviders {
  shared: gcp.Provider;
  staging: gcp.Provider;
  production: gcp.Provider;
}

export function createBootstrapProvider(): gcp.Provider;

export function createProjectProviders(projectIds: {
  shared: pulumi.Input<string>;
  staging: pulumi.Input<string>;
  production: pulumi.Input<string>;
}): ProjectProviders;
```

- [ ] **Step 1: Write the mock harness**

Capture resource type, logical name, inputs, provider URN, and dependency URNs. Return deterministic values:

```ts
export const MOCK_NAME_SERVERS = [
  "ns-cloud-a1.googledomains.com.",
  "ns-cloud-a2.googledomains.com.",
  "ns-cloud-a3.googledomains.com.",
  "ns-cloud-a4.googledomains.com.",
] as const;

export const MOCK_PRODUCTION_IP = "203.0.113.10";
export const MOCK_STAGING_IP = "203.0.113.20";
```

Mock DNS authorizations must return a single `dnsResourceRecords` CNAME, Docker images must return `ref` and `digest`, and Cloud Run services must return a URI and revision.

- [ ] **Step 2: Write failing provider tests**

Assert that the bootstrap provider has no project, child providers use the exact project IDs and `asia-south1`, and every GCP resource other than the three project resources has a provider URN.

- [ ] **Step 3: Run the focused test**

Run: `pnpm -C infra test --run tests/providers.test.ts`

Expected: FAIL because `createBootstrapProvider` and `createProjectProviders` are missing.

- [ ] **Step 4: Implement providers**

The bootstrap provider is explicit but omits `project`; it is used only for organization, billing, and project creation resources. Child providers set their project explicitly and accept project IDs as Pulumi inputs, creating a dependency on the project resources.

- [ ] **Step 5: Re-run the focused test**

Expected: PASS; no resource can fall back to ambient `gcloud` configuration.

- [ ] **Step 6: Commit**

```bash
git add infra/src/providers.ts infra/tests/helpers/pulumi-mocks.ts infra/tests/providers.test.ts
git commit -m "test(infra): enforce explicit GCP providers"
```

---

### Task 3: Create the Project Factory and Required APIs

**Files:**
- Create: `infra/src/foundation/projects.ts`
- Create: `infra/src/foundation/services.ts`
- Test: `infra/tests/foundation-projects.test.ts`

**Interfaces:**
- Consumes: bootstrap provider and `allowProjectDeletion`.
- Produces:

```ts
export interface ProjectBundle {
  project: gcp.organizations.Project;
  provider: gcp.Provider;
  services: Record<string, gcp.projects.Service>;
}

export function createProjectBundle(args: {
  logicalName: "shared" | "staging" | "production";
  projectId: string;
  bootstrapProvider: gcp.Provider;
  allowProjectDeletion: boolean;
  services: readonly string[];
}): ProjectBundle;
```

Required API sets:

```ts
export const SHARED_APIS = [
  "cloudbilling.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "dns.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "serviceusage.googleapis.com",
  "sts.googleapis.com",
] as const;

export const WORKLOAD_APIS = [
  "artifactregistry.googleapis.com",
  "certificatemanager.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "compute.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "run.googleapis.com",
  "serviceusage.googleapis.com",
  "sts.googleapis.com",
] as const;
```

- [ ] **Step 1: Write failing project/API tests**

Assert exactly three `gcp.organizations.Project` resources, exact IDs/org/billing, `autoCreateNetwork:false`, `PREVENT` when false, `DELETE` when true, only the declared APIs, `disableOnDestroy:false`, and provider/project ownership.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/foundation-projects.test.ts`

Expected: FAIL because the project factory is missing.

- [ ] **Step 3: Implement project and API resources**

Use `folderId` nowhere; each project is attached directly to organization `391332700711`. API resources explicitly depend on their project and use the corresponding child provider. Leave APIs enabled on resource destroy so disabling an API cannot precede dependent-resource deletion; final project deletion removes the project boundary.

- [ ] **Step 4: Run focused tests**

Expected: PASS for both deletion-policy modes.

- [ ] **Step 5: Commit**

```bash
git add infra/src/foundation/projects.ts infra/src/foundation/services.ts infra/tests/foundation-projects.test.ts
git commit -m "feat(infra): create isolated GCP project factory"
```

---

### Task 4: Add Registries, Reserved IPs, and Runtime Identities

**Files:**
- Create: `infra/src/foundation/registries.ts`
- Create: `infra/src/foundation/addresses.ts`
- Create: `infra/src/foundation/identities.ts`
- Modify: `infra/tests/foundation-projects.test.ts`

**Interfaces:**
- Consumes: staging/production bundles and enabled API resources.
- Produces:

```ts
export interface FoundationCoreResources {
  productionRepository: gcp.artifactregistry.Repository;
  stagingRepository: gcp.artifactregistry.Repository;
  productionAddress: gcp.compute.GlobalAddress;
  stagingAddress: gcp.compute.GlobalAddress;
  productionRuntimeServiceAccount: gcp.serviceaccount.Account;
  stagingRuntimeServiceAccount: gcp.serviceaccount.Account;
}
```

- [ ] **Step 1: Extend the failing tests**

Require Docker repositories with repository ID `windrun` in each workload project and `asia-south1`; two external global IPv4 addresses; runtime accounts `production-runtime` and `staging-runtime`; and no project roles assigned to runtime accounts.

- [ ] **Step 2: Run the focused test**

Expected: FAIL because repositories, addresses, and runtime accounts are absent.

- [ ] **Step 3: Implement minimal resources with explicit API dependencies**

Registry resources depend on Artifact Registry API. Addresses depend on Compute API. Service accounts depend on IAM API. Do not add runtime permissions because this application has no database, secret, bucket, or other runtime dependency.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm -C infra check`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add infra/src/foundation/registries.ts infra/src/foundation/addresses.ts infra/src/foundation/identities.ts infra/tests/foundation-projects.test.ts
git commit -m "feat(infra): add registries addresses and runtime identities"
```

---

### Task 5: Manage Shared DNS, DigitalOcean Delegation, and Certificates

**Files:**
- Create: `infra/src/foundation/dns.ts`
- Create: `infra/src/foundation/certificates.ts`
- Test: `infra/tests/foundation-dns-certificates.test.ts`

**Interfaces:**
- Consumes: explicit shared/staging/production providers, DigitalOcean secret provider, reserved IPs, and enabled APIs.
- Produces:

```ts
export interface DnsCertificateResources {
  zone: gcp.dns.ManagedZone;
  productionCertificate: gcp.certificatemanager.Certificate;
  stagingCertificate: gcp.certificatemanager.Certificate;
  productionCertificateMap: gcp.certificatemanager.CertificateMap;
  stagingCertificateMap: gcp.certificatemanager.CertificateMap;
}

export function validateInheritedCaa(
  records: ReadonlyArray<{ type: string; value: string; tag?: string }>,
): void;
```

- [ ] **Step 1: Write failing DNS/certificate tests**

Assert:

- One public Cloud DNS managed zone with `dnsName:"app.windrun.ai."` in shared.
- Four `digitalocean.DnsRecord` resources with `domain:"windrun.ai"`, `type:"NS"`, `name:"app"`, TTL 1800, and values from the zone's four assigned name servers.
- `app.windrun.ai.` A points to production IP.
- `app.staging.windrun.ai.` and `*.app.staging.windrun.ai.` A point to staging IP.
- Production/staging DNS authorizations use `PER_PROJECT_RECORD`, `global`, their own providers, and parent domains `app.windrun.ai` and `app.staging.windrun.ai`.
- Validation CNAME name/type/data is copied verbatim into shared DNS.
- Production certificate covers `app.windrun.ai`.
- Staging certificate covers both `app.staging.windrun.ai` and `*.app.staging.windrun.ai` using one authorization.
- Production has one certificate-map entry; staging has apex and wildcard entries.
- Certificates depend on validation records; map entries depend on certificates.
- Restrictive CAA records lacking `pki.goog` cause a preview-time exception.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/foundation-dns-certificates.test.ts`

Expected: FAIL because DNS/certificate modules are missing.

- [ ] **Step 3: Implement DigitalOcean and Cloud DNS resources**

Construct an explicit DigitalOcean provider using `new pulumi.Config().requireSecret("digitalOceanToken")`. Create four NS resources by indexing the managed-zone `nameServers` output. Query DigitalOcean's `windrun.ai` records and call `validateInheritedCaa` before creating certificates.

- [ ] **Step 4: Implement certificate ordering**

The creation graph must be:

```text
DNS authorization -> shared-zone validation CNAME -> certificate -> map entry
```

Use `dependsOn` on each certificate for its validation CNAME. Passing authorization output values into the record creates the preceding dependency. Destruction then reverses the graph and preserves renewal records until certificates are gone.

- [ ] **Step 5: Run focused tests**

Expected: exit 0 with exact provider and dependency assertions passing.

- [ ] **Step 6: Commit**

```bash
git add infra/src/foundation/dns.ts infra/src/foundation/certificates.ts infra/tests/foundation-dns-certificates.test.ts
git commit -m "feat(infra): manage DNS delegation and certificates"
```

---

### Task 6: Create GCP Workload Identity Federation

**Files:**
- Create: `infra/src/foundation/github-wif.ts`
- Modify: `infra/src/foundation/identities.ts`
- Test: `infra/tests/foundation-identity.test.ts`

**Interfaces:**
- Consumes: project bundles, runtime accounts, and repositories.
- Produces:

```ts
export type DeploymentIdentityKind =
  | "foundation"
  | "production"
  | "production-edge"
  | "staging"
  | "staging-edge"
  | "preview";

export interface FederatedIdentity {
  serviceAccount: gcp.serviceaccount.Account;
  pool: gcp.iam.WorkloadIdentityPool;
  provider: gcp.iam.WorkloadIdentityPoolProvider;
}
```

Use this exact common attribute mapping. Mapping the numeric repository ID as the Google subject keeps the value immutable, short, and independent of GitHub's legacy versus post-2026-07-15 immutable `sub` formats:

```ts
export const GITHUB_ATTRIBUTE_MAPPING = {
  "google.subject": "assertion.repository_id",
  "attribute.repository": "assertion.repository",
  "attribute.repository_id": "assertion.repository_id",
  "attribute.repository_owner_id": "assertion.repository_owner_id",
  "attribute.ref": "assertion.ref",
  "attribute.event_name": "assertion.event_name",
  "attribute.workflow_ref": "assertion.workflow_ref",
  "attribute.environment": "assertion.environment",
} as const;
```

Only the preview provider extends that mapping with `"attribute.job_workflow_ref": "assertion.job_workflow_ref"`; GitHub does not promise `job_workflow_ref` for direct, non-reusable jobs.

Every provider condition includes:

```text
assertion.repository_id == '1095528250' &&
assertion.repository_owner_id == '136263' &&
assertion.repository == 'rohanprabhu/windrun-ai'
```

Additional restrictions:

- Production: environment `production`, `push`, `refs/heads/main`, and exact `deploy-production.yml` workflow ref.
- Staging: environment `staging`, `push`, `refs/heads/staging`, and exact `deploy-staging.yml` workflow ref.
- Preview: environment `preview`, `pull_request`, base branch `main`, the exact `pull-request.yml` caller, and either exact `_preview-deploy.yml` or `_preview-destroy.yml` `job_workflow_ref` pinned to `refs/heads/main`. Deploy accepts only `refs/pull/*/merge`; destroy also accepts the exact `refs/heads/main` ref/caller pair because GitHub changes `ref` and `workflow_ref` to the base branch when a pull request closes by merging.
- Production edge: environment `production-edge`, `workflow_dispatch`, `refs/heads/main`, and exact `manage-edge.yml` workflow ref.
- Staging edge: environment `staging-edge`, `workflow_dispatch`, `refs/heads/main`, and exact `manage-edge.yml` workflow ref.
- Foundation: environment `foundation`, `workflow_dispatch`, `refs/heads/main`, and exact `manage-foundation.yml` workflow ref.

- [ ] **Step 1: Write failing identity tests**

Assert six separate pools/providers/service accounts, numeric `google.subject`, immutable repository/owner checks, environment/branch/event/workflow checks, preview-only `job_workflow_ref` mapping, `roles/iam.workloadIdentityUser`, and no service-account key resources. Principal-set members must use the pool-owning project's numeric project number, never its string project ID.

Assert permission boundaries:

- App identities: project `roles/run.admin`, repository `roles/artifactregistry.writer`, runtime account `roles/iam.serviceAccountUser`.
- Preview identity: the same three permissions only in the isolated staging project. Do not add a `resource.name` condition: Cloud Run administrative permissions do not support that IAM attribute, so a `pr-*` condition would deny creation/update rather than constrain it. The trusted main-branch Pulumi program and validated `pr-<number>` stack contract enforce the service name.
- Edge identities: `roles/compute.loadBalancerAdmin` and `roles/certificatemanager.viewer` in only their environment project.
- Foundation identity: only the project-local administrative roles required for normal Service Usage, IAM/WIF, DNS, Artifact Registry, Certificate Manager, and Compute-address updates. Its `roles/resourcemanager.projectIamAdmin` binding must use `api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(...)` with the exact ten project roles managed by this program, excluding Project IAM Admin itself, Owner, Editor, and every unrelated role. This prevents foundation CI from turning its policy-management permission into unrestricted project ownership; changes to the limiting binding are local-only. It receives no organization role and no billing-account role; project creation/deletion, project metadata changes, and billing drift repair are local-only Pulumi escalation points under verified `rohan@windrun.ai` credentials.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/foundation-identity.test.ts`

Expected: FAIL because federation resources do not exist.

- [ ] **Step 3: Implement GCP federation and IAM**

Use issuer `https://token.actions.githubusercontent.com`. Each service account receives a principal-set binding scoped to its own pool and repository ID using `principalSet://iam.googleapis.com/projects/<numeric-project-number>/locations/global/workloadIdentityPools/<pool-id>/attribute.repository_id/1095528250`. Do not grant staging identities in production or production identities in staging, and do not use GitHub `assertion.*` expressions in project/service-account IAM conditions; those claims exist only in the WIF provider CEL context. Create no organization or billing IAM resource. The local operations track must verify exact ADC ownership before initial creation, any project/billing repair, and final teardown.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm -C infra check`

Expected: exit 0; tests prove no cross-project IAM and no key resources.

- [ ] **Step 5: Commit**

```bash
git add infra/src/foundation/github-wif.ts infra/src/foundation/identities.ts infra/tests/foundation-identity.test.ts
git commit -m "feat(infra): add keyless deployment identities"
```

---

### Task 7: Implement Production, Staging, and Preview Application Stacks

**Files:**
- Create: `infra/src/stacks/app.ts`
- Test: `infra/tests/app-stack.test.ts`

**Interfaces:**
- Consumes: typed foundation project/repository/runtime-account outputs, explicit workload provider, service name, and Git SHA.
- Produces:

```ts
export interface AppStackArgs {
  kind: "production" | "staging" | "preview";
  projectId: pulumi.Input<string>;
  provider: gcp.Provider;
  repositoryId: pulumi.Input<string>;
  runtimeServiceAccountEmail: pulumi.Input<string>;
  serviceName: string;
  gitCommitSha: string;
  sourceRoot?: string;
}

export interface AppStackOutputs {
  publicUrl: pulumi.Output<string>;
  projectId: pulumi.Output<string>;
  serviceName: pulumi.Output<string>;
  imageDigest: pulumi.Output<string>;
}

export function createAppStack(args: AppStackArgs): AppStackOutputs;
```

- [ ] **Step 1: Write failing application-stack tests**

Assert:

- Fixed services are exactly `production` and `staging`; `pr-42` remains `pr-42`.
- Preview uses only the staging project/provider/repository/runtime account.
- Docker context defaults to repository root `..` from `infra/`, so the build can access the root `pnpm-lock.yaml`; Dockerfile defaults to `../windrun-ai/Dockerfile`. An explicit absolute `sourceRoot` selects an application-only checkout for previews while the Pulumi program continues to run from trusted `main` code.
- Docker Build has `push:true`, a tag containing service name plus full SHA, and produces the digest-qualified reference consumed by Cloud Run.
- Docker Build sets `buildOnPreview:false`, `platforms:[linux/amd64]`, and `retainOnDelete:true`; retained tags are governed by the Pulumi-managed repository cleanup policy so destroy never depends on an expired registry token.
- Cloud Run v2 ingress is `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`.
- Cloud Run v2 `gcp.cloudrunv2.Service.invokerIamDisabled` is `true` for Google-managed public invocation without a separate public IAM grant.
- Cloud Run v2 sets `deletionProtection:false` so preview and environment teardown can succeed.
- Container port is 8080.
- Runtime metadata contains exactly `APP_ENVIRONMENT`, `GCP_PROJECT_ID`, `GOOGLE_CLOUD_REGION`, `GIT_COMMIT_SHA`, `PULUMI_STACK`, and `NEXT_PUBLIC_CANONICAL_HOST`.
- No application/preview stack creates any Cloud Run IAM binding, member, or policy resource.
- No application/preview stack contains DNS, address, certificate, NEG, backend, URL map, proxy, or forwarding-rule resources.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/app-stack.test.ts`

Expected: FAIL because `createAppStack` is missing.

- [ ] **Step 3: Implement immutable image build and Cloud Run**

Call `gcp.organizations.getClientConfigOutput({ provider })`; wrap its access token with `pulumi.secret`; authenticate Docker Build to `${REGION}-docker.pkg.dev` with username `oauth2accesstoken`; use build context `sourceRoot ?? ".."` and Dockerfile `${sourceRoot}/windrun-ai/Dockerfile` or the default `../windrun-ai/Dockerfile`; set `push:true`, `buildOnPreview:false`, and `platforms:[dockerBuild.Platform.Linux_amd64]`; pass `image.ref` to Cloud Run. Set `retainOnDelete:true` on the image because Docker Build delete would otherwise reuse an expired OAuth token; Artifact Registry cleanup policies own eventual tag removal. Require an absolute `sourceRoot` for previews, reject it for static stacks, validate exact fixed/`pr-N` service names, and accept the root only as a local execution input—never Pulumi config, a build arg, runtime metadata, or a stack output. Set `APP_ENVIRONMENT` to `production`, `staging`, or `preview`; `PULUMI_STACK` to the actual Pulumi stack name; and `NEXT_PUBLIC_CANONICAL_HOST` to `app.windrun.ai`, `app.staging.windrun.ai`, or `${serviceName}.app.staging.windrun.ai` respectively. On the `gcp.cloudrunv2.Service`, set ingress to `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, `invokerIamDisabled:true`, and `deletionProtection:false`; do not create separate Cloud Run IAM resources. A failed build must prevent service registration.

- [ ] **Step 4: Run focused tests and typecheck**

Expected: exit 0; app stacks contain only Docker Build and Cloud Run service resources, every service has `invokerIamDisabled: true`, and no Cloud Run IAM or edge resource family is present.

- [ ] **Step 5: Commit**

```bash
git add infra/src/stacks/app.ts infra/tests/app-stack.test.ts
git commit -m "feat(infra): add immutable Cloud Run application stacks"
```

---

### Task 8: Implement Production and Staging Edge Stacks

**Files:**
- Create: `infra/src/stacks/edge.ts`
- Test: `infra/tests/edge-stack.test.ts`

**Interfaces:**
- Consumes: typed foundation IP/certificate-map/project outputs and explicit environment provider.
- Produces:

```ts
export interface EdgeStackArgs {
  kind: "production-edge" | "staging-edge";
  projectId: pulumi.Input<string>;
  provider: gcp.Provider;
  globalAddress: pulumi.Input<string>;
  certificateMapId: pulumi.Input<string>;
  certificateStatus: pulumi.Input<string>;
}

export function createEdgeStack(args: EdgeStackArgs): {
  publicUrl: pulumi.Output<string>;
  globalIp: pulumi.Output<string>;
  certificateStatus: pulumi.Output<string>;
};
```

- [ ] **Step 1: Write failing edge tests**

Production assertions:

- One `gcp.compute.RegionNetworkEndpointGroup` in `asia-south1`, `networkEndpointType:"SERVERLESS"`, `cloudRun.service:"production"`.
- One backend and one HTTPS URL map.
- A separate redirect URL map with HTTPS redirect.
- HTTP/HTTPS proxies and global forwarding rules on ports 80 and 443.
- `EXTERNAL_MANAGED` and Premium tier.

Staging assertions:

- Primary NEG uses `cloudRun.service:"staging"`.
- Preview NEG uses exact `cloudRun.urlMask:"<service>.app.staging.windrun.ai"`.
- Host `app.staging.windrun.ai` routes to primary backend.
- Host `*.app.staging.windrun.ai` routes to preview backend.
- No Compute Engine health checks.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/edge-stack.test.ts`

Expected: FAIL because `createEdgeStack` is missing.

- [ ] **Step 3: Implement edge resources**

Use foundation-owned IPs and certificate maps without attempting to update them. Edge stacks refer to the fixed service names and do not use app-stack outputs; initial ordering guarantees those services exist before their NEGs.

- [ ] **Step 4: Run focused tests**

Expected: PASS; the preview NEG is the only resource with a URL mask.

- [ ] **Step 5: Commit**

```bash
git add infra/src/stacks/edge.ts infra/tests/edge-stack.test.ts
git commit -m "feat(infra): add stable Cloud Run edge stacks"
```

---

### Task 9: Add Typed Foundation Outputs and Stack Dispatch

**Files:**
- Create: `infra/src/foundation-outputs.ts`
- Create: `infra/src/foundation/index.ts`
- Create: `infra/src/index.ts`
- Test: `infra/tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: validated stack context and foundation resources/outputs.
- Produces:

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

- [ ] **Step 1: Write failing dispatcher tests**

Run the Pulumi program under mocks for foundation, production, production-edge, staging, staging-edge, and `pr-1`. Assert each contains only allowed resource families and exports public URL, project ID, service name, image digest, global IP, or certificate state where applicable. Application and preview stacks may register Docker Build plus `gcp.cloudrunv2.Service`, must set `invokerIamDisabled: true`, and must not register Cloud Run IAM binding/member/policy resources. Assert every foundation custom resource is recorded with `protect:true` while `allowProjectDeletion=false`, and with `protect:false` only when that explicit teardown flag is true.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/dispatcher.test.ts`

Expected: FAIL because the dispatcher and typed output boundary are missing.

- [ ] **Step 3: Implement typed StackReference access**

Use the same organization/project automatically:

```ts
const foundation = new pulumi.StackReference(
  `${pulumi.getOrganization()}/${pulumi.getProject()}/foundation`,
);
```

Centralize all required-output access in `foundation-outputs.ts`; it must fail closed on missing, empty, or non-string values, and stack builders must not use ad hoc output strings.

- [ ] **Step 4: Implement stack dispatch and exports**

Foundation reads `allowProjectDeletion` and the encrypted DigitalOcean token. Before constructing any foundation resource, register a stack resource transform that sets `protect: !allowProjectDeletion` on every custom and component resource; this makes a normal destroy fail without deleting children. The acknowledged teardown must first set the flag and apply a full `pulumi up` to persist both unprotection and project `deletionPolicy: DELETE`. Delivery reads `enablePulumiGithubOidc` and `pulumiOrganization`. App stacks require `gitCommitSha`. Preview stacks additionally require `pullRequestNumber`, which must match the `pr-<number>` stack name. Export no tokens, credentials, or secret outputs.

- [ ] **Step 5: Run the full infrastructure suite**

Run: `pnpm -C infra check`

Expected: exit 0; all stack kinds pass under Pulumi mocks.

- [ ] **Step 6: Commit**

```bash
git add infra/src/foundation-outputs.ts infra/src/foundation/index.ts infra/src/index.ts infra/tests/dispatcher.test.ts
git commit -m "feat(infra): dispatch typed Pulumi stack kinds"
```

---

### Task 10: Add the Local-Only Delivery Stack

**Files:**
- Create: `infra/src/delivery/index.ts`
- Create: `infra/src/delivery/github.ts`
- Create: `infra/src/delivery/pulumi-oidc.ts`
- Modify: `infra/src/index.ts`
- Modify: `infra/src/foundation-outputs.ts`
- Test: `infra/tests/delivery.test.ts`
- Modify: `infra/tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `pulumiOrganization`, `enablePulumiGithubOidc`, local `GITHUB_TOKEN` and `PULUMI_ACCESS_TOKEN` environment variables, and all typed WIF/service-account outputs from foundation.
- Produces GitHub environments, deployment policies, repository Actions variables, and the Pulumi Cloud GitHub OIDC issuer. It creates no GCP or DigitalOcean resources.

```ts
export interface DeliveryStackArgs {
  pulumiOrganization: string;
  enablePulumiGithubOidc: boolean;
  foundation: FoundationOutputs;
}

export interface DeliveryStackOutputs {
  ciEnabled: pulumi.Output<boolean>;
}

export function createDeliveryStack(
  args: DeliveryStackArgs,
): DeliveryStackOutputs;
```

The delivery stack owns exactly these repository Actions variables:

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

- [ ] **Step 1: Write failing delivery tests**

Assert that delivery:

- Uses an explicit `github.Provider` with owner `rohanprabhu` and token sourced only from `GITHUB_TOKEN`.
- When OIDC is enabled, uses an explicit `pulumiservice.Provider` with its access token sourced only from `PULUMI_ACCESS_TOKEN`; when OIDC is disabled, it creates neither the provider nor issuer.
- Uses repository `windrun-ai` and never creates or updates the repository itself.
- Creates `github.RepositoryEnvironment` resources for `foundation`, `production`, `production-edge`, `staging`, `staging-edge`, and `preview`.
- Creates exact `github.RepositoryEnvironmentDeploymentPolicy` branch patterns: foundation `main`, production `main`, production-edge `main`, staging `staging`, staging-edge `main`, plus preview `refs/pull/*/merge` and `main`. The second preview policy exists only so a merged PR close event can run the exact trusted destroy workflow; both cloud trust policies still require `pull_request` plus the exact caller and destroy reusable workflow.
- Configures reviewer user ID `136263` on privileged `foundation`, `production-edge`, and `staging-edge` environments, with `preventSelfReview: false` and `canAdminsBypass: false`.
- Creates the fourteen `github.ActionsVariable` resources listed above; `PULUMI_ORGANIZATION` comes from config, and `PULUMI_CI_ENABLED` reflects `enablePulumiGithubOidc`.
- Registers `PULUMI_CI_ENABLED` last with explicit dependencies on the optional OIDC issuer and every environment, deployment policy, and other Actions variable prerequisite.
- Preserves distinct `PRODUCTION_EDGE_*` and `STAGING_EDGE_*` values.
- Creates `pulumiservice.OidcIssuer` only when enabled, using `pulumiOrganization` and GitHub issuer `https://token.actions.githubusercontent.com`.
- Creates no GCP, DigitalOcean, workflow, secret, or service-account-key resources.
- Foundation itself contains no organization/billing IAM, `pulumiservice`, or `github` resources.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/delivery.test.ts`

Expected: FAIL because the delivery modules do not exist.

- [ ] **Step 3: Implement explicit providers and GitHub resources**

Read `GITHUB_TOKEN` from `process.env` and throw `GITHUB_TOKEN is required for the delivery stack` when absent. When `enablePulumiGithubOidc=true`, also require `PULUMI_ACCESS_TOKEN` in `process.env`. Keep both tokens only in the child-process environment: the explicit GitHub provider sets only owner and `https://api.github.com/`, and the explicit Pulumi Service provider sets only `https://api.pulumi.com`, allowing each plugin to read its standard environment variable without persisting a token input in state. When disabled, create neither the Pulumi Service provider nor issuer. Do not put either token in Pulumi config, provider inputs, outputs, Actions variables, resource names, commits, or logs; do not invoke `gh`.

- [ ] **Step 4: Implement environments, policies, and variables**

Set every environment to custom deployment policies using the exact branch patterns from Step 1, including both preview policies. Add reviewer user ID `136263` only to `foundation`, `production-edge`, and `staging-edge`, with `preventSelfReview: false` and `canAdminsBypass: false`. Populate all twelve `GCP_*` WIF/service-account variables only from the correspondingly typed foundation outputs, and set `PULUMI_ORGANIZATION` from config. Create those thirteen non-gate variables before `PULUMI_CI_ENABLED`.

- [ ] **Step 5: Implement Pulumi Cloud OIDC and dispatch**

When `enablePulumiGithubOidc=false`, omit `pulumiservice.OidcIssuer` and set the final gate variable to `false`. When true, create the issuer through the explicit provider with maximum expiration 3600 seconds and personal-token allow policies scoped to `pulumiOrganization`, immutable repository ID `1095528250`, owner ID `136263`, repository `rohanprabhu/windrun-ai`, audience, and trusted subjects. Register `PULUMI_CI_ENABLED` last, set it to the lowercase string form of `enablePulumiGithubOidc`, and give it explicit `dependsOn` edges to the issuer when present plus all six environments, seven deployment policies, and thirteen preceding variables. Add the `delivery` branch to `src/index.ts`; it must load foundation outputs before registering delivery resources.

- [ ] **Step 6: Run focused and dispatcher tests**

```bash
pnpm -C infra test --run tests/delivery.test.ts tests/dispatcher.test.ts
pnpm -C infra typecheck
```

Expected: both commands exit 0; delivery contains no GCP/DigitalOcean resources, while foundation contains no organization/billing IAM or GitHub/Pulumi Service resources.

- [ ] **Step 7: Commit**

```bash
git add infra/src/delivery infra/src/index.ts infra/src/foundation-outputs.ts infra/tests/delivery.test.ts infra/tests/dispatcher.test.ts
git commit -m "feat(infra): add local Pulumi delivery stack"
```

---

### Task 11: Add Static Pulumi Stack Configuration

**Files:**
- Create: `infra/Pulumi.foundation.yaml`
- Create: `infra/Pulumi.delivery.yaml`
- Create: `infra/Pulumi.production-edge.yaml`
- Create: `infra/Pulumi.production.yaml`
- Create: `infra/Pulumi.staging-edge.yaml`
- Create: `infra/Pulumi.staging.yaml`
- Test: `infra/tests/stack-config.test.ts`

**Interfaces:**
- Consumes: the exact Windrun config contract from Task 1.
- Produces: safe committed defaults for static stacks; preview and per-deployment values remain dynamic inputs owned by the CI/operations plan.

- [ ] **Step 1: Write failing stack-config tests**

Parse every static YAML and assert:

- `pulumi:disable-default-providers` contains `gcp`.
- `windrun-ai:stackKind` exactly matches the filename.
- Foundation contains `windrun-ai:allowProjectDeletion: false` and does not contain delivery-only config.
- Delivery contains `windrun-ai:enablePulumiGithubOidc: false`; `windrun-ai:pulumiOrganization` is added locally post-claim and is not committed with an invented value.
- Static application configs omit `windrun-ai:gitCommitSha`.
- Static configs omit `windrun-ai:pullRequestNumber`.
- No committed `Pulumi.pr-*.yaml` exists.
- No project config key exists outside the seven-key contract in Global Constraints.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/stack-config.test.ts`

Expected: FAIL because the static stack files do not exist.

- [ ] **Step 3: Create exact YAML defaults**

Foundation begins with:

```yaml
config:
  pulumi:disable-default-providers:
    - gcp
  windrun-ai:stackKind: foundation
  windrun-ai:allowProjectDeletion: false
```

Delivery begins with:

```yaml
config:
  pulumi:disable-default-providers:
    - gcp
  windrun-ai:stackKind: delivery
  windrun-ai:enablePulumiGithubOidc: false
```

Each remaining static stack contains only its matching `windrun-ai:stackKind` plus the provider-disable setting.

- [ ] **Step 4: Run the focused test**

Expected: exit 0 with no unrecognized config key.

- [ ] **Step 5: Commit**

```bash
git add infra/Pulumi.*.yaml infra/tests/stack-config.test.ts
git commit -m "feat(infra): add static Pulumi stack contracts"
```

---

### Task 12: Add the Foundation Secret-Bootstrap Script

**Files:**
- Create: `infra/scripts/bootstrap-foundation-secret.sh`
- Test: `infra/tests/secret-bootstrap.test.ts`

**Interfaces:**
- Consumes: Keychain item account `windrun-ai`, service `com.windrun.pulumi.digitalocean`.
- Produces: encrypted `windrun-ai:digitalOceanToken` in foundation stack config and removes the temporary Keychain item.

- [ ] **Step 1: Write the failing script test**

Assert `set -euo pipefail`, both exact `security` commands with `-a windrun-ai`, `pulumi config set --secret windrun-ai:digitalOceanToken`, exact-path non-empty `secure` ciphertext validation before deletion, `unset TOKEN`, and absence of token-printing commands, `gcloud`, `doctl`, and `gh`. Exercise the validator with valid encrypted YAML plus plaintext, empty, whitespace-only, stale, commented, and malformed fixtures; it must emit no output.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/secret-bootstrap.test.ts`

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement the exact non-logging transfer**

```bash
#!/usr/bin/env bash
set -euo pipefail

validate_encrypted_config() {
  node - "$1" <<'NODE'
const { readFileSync } = require("node:fs");

let document;
try {
  const { parse } = require("yaml");
  document = parse(readFileSync(process.argv[2], "utf8"));
} catch {
  process.exit(1);
}

const ciphertext =
  document?.config?.["windrun-ai:digitalOceanToken"]?.secure;
process.exit(
  typeof ciphertext === "string" && ciphertext.trim().length > 0 ? 0 : 1,
);
NODE
}

cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--validate-config" ]]; then
  [[ $# -eq 2 ]]
  validate_encrypted_config "$2"
  exit
fi

TOKEN="$(security find-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean -w)"
pulumi config set --stack foundation --secret windrun-ai:digitalOceanToken "$TOKEN"
validate_encrypted_config Pulumi.foundation.yaml
security delete-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean
unset TOKEN
```

- [ ] **Step 4: Run test and shellcheck**

```bash
pnpm -C infra test --run tests/secret-bootstrap.test.ts
shellcheck infra/scripts/bootstrap-foundation-secret.sh
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add infra/scripts/bootstrap-foundation-secret.sh infra/tests/secret-bootstrap.test.ts
git commit -m "feat(infra): add encrypted DigitalOcean secret bootstrap"
```

---

### Task 13: Document the Infrastructure Contract and CI/Operations Handoff

**Files:**
- Create: `infra/README.md`
- Create: `infra/TEARDOWN.md`
- Test: `infra/tests/documentation.test.ts`

**Interfaces:**
- Consumes: completed Pulumi stacks, static config, and secret-bootstrap contract.
- Produces: infrastructure bootstrap/dependency documentation and an explicit handoff to `docs/superpowers/plans/2026-07-12-windrun-ci-operations.md` for workflows and lifecycle scripts.

- [ ] **Step 1: Write failing documentation tests**

Assert both documents contain the seven-key config contract, all seven stack kinds, exact foundation output names, initial GCP order, post-claim delivery checkpoint, delivery-before-foundation teardown rule, `DELETE_REQUESTED`, 30-day recovery, permanent project-ID non-reuse, and the CI/operations plan path. Assert they do not claim ownership of `.github/workflows`, preview/deploy/destroy/smoke-test scripts, `gh`, `gcloud`, or `doctl` mutations.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C infra test --run tests/documentation.test.ts`

Expected: FAIL because `infra/README.md` and `infra/TEARDOWN.md` do not exist.

- [ ] **Step 3: Document bootstrap phases**

Document that local ADC and the DigitalOcean secret bootstrap permit the GCP sequence to run before account claim:

```text
foundation -> production -> production-edge -> staging -> staging-edge
```

After claim and Pulumi re-authentication, initialize delivery locally, set `windrun-ai:pulumiOrganization` to `pulumi whoami`, and set `windrun-ai:enablePulumiGithubOidc=true`. Export `GITHUB_TOKEN` and `PULUMI_ACCESS_TOKEN` into the local shell from their secure post-claim credential sources without printing or committing either value, then apply `delivery`. Preview CI remains disabled until delivery registers `PULUMI_CI_ENABLED=true` after all issuer, environment, policy, and variable prerequisites.

- [ ] **Step 4: Document delivery ownership**

List the six GitHub environments, exact branch patterns, privileged reviewer rules, `PULUMI_CI_ENABLED`, Pulumi variables, and six distinct WIF/service-account pairs. State that delivery uses `GITHUB_TOKEN` only through the explicit GitHub provider and `PULUMI_ACCESS_TOKEN` only through the explicit Pulumi Service provider, performs no `gh` mutation, is local-only, never prints or commits either token, and may be recreated from foundation outputs after account claim.

- [ ] **Step 5: Document teardown contracts and handoff**

The CI/operations plan owns executable preview/application/edge teardown. Infrastructure documentation owns only these invariants:

```text
all preview/application/edge stacks empty
-> delivery destroyed
-> exact active gcloud + ADC identity verified as rohan@windrun.ai
-> foundation allowProjectDeletion changed to true, previewed, and applied locally
-> foundation state verified unprotected with project deletionPolicy DELETE
-> foundation destroyed locally as rohan@windrun.ai
```

Within foundation, DigitalOcean delegation is deleted before Cloud DNS, validation CNAMEs are deleted after certificates, and projects are scheduled last.

- [ ] **Step 6: Run all infrastructure-track verification**

```bash
pnpm -C infra check
shellcheck infra/scripts/bootstrap-foundation-secret.sh
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add infra/README.md infra/TEARDOWN.md infra/tests/documentation.test.ts
git commit -m "docs(infra): define delivery and operations handoff"
```

---

## Chicken-and-Egg Ordering and Hard Blockers

1. **Initial project bootstrap:** The shared project and foundation WIF identity do not exist yet. The first foundation update must run locally using Application Default Credentials for exactly `rohan@windrun.ai`, with organization project-creation/deletion and billing permissions. The explicit bootstrap provider must omit `project`; per-project providers are created only after project outputs exist.

2. **Project lifecycle boundary:** The foundation CI identity receives no organization or billing-account role. Initial project creation, project metadata changes, billing drift repair, and final project deletion are Pulumi-only local operations that must refuse to start unless both active gcloud identity and ADC resolve to exactly `rohan@windrun.ai`. Normal foundation refresh/update remains CI-capable through project-local roles; a real post-bootstrap preview validates that boundary before CI is enabled.

3. **DigitalOcean delegation:** The DigitalOcean token must move from macOS Keychain into encrypted foundation stack configuration before the first foundation update. Delegation records cannot be constructed until Cloud DNS returns its assigned name servers. The Keychain item is deleted only after the encrypted stack config entry exists.

4. **Pulumi account claim:** `pulumiservice.OidcIssuer` cannot be finalized before the unclaimed Pulumi account is claimed and the operator re-authenticates. Initial GCP deployment may proceed through foundation and the static application/edge stacks without delivery. After claim, the operator configures `windrun-ai:pulumiOrganization`, sets `windrun-ai:enablePulumiGithubOidc=true`, and applies the local-only delivery stack. Claiming invalidates the ephemeral credential.

5. **Pulumi Individual token type:** Pulumi Individual accounts support personal OIDC tokens, not organization tokens. The claimed Pulumi username is not present in the design, so issuer policy and workflow authentication cannot be finalized until claim. If organization-scoped CI tokens are required, creating/upgrading to a Pulumi Team organization is a hard prerequisite.

6. **Preview code isolation:** GitHub's base `repository_id` claim does not itself prove that a pull request's head repository is the same repository, and Cloud Run does not support service-name `resource.name` conditions for administrative permissions. The caller must enforce `github.event.pull_request.head.repo.id == github.event.repository.id`; the credentialed job must use a main-pinned reusable workflow on a fresh runner, execute Pulumi only from a separate trusted `main` checkout, and supply PR code only as Docker build context. The trusted Pulumi program validates `pr-<number>`. This infrastructure plan owns the matching WIF condition and GitHub environment deployment policy.

7. **Certificate provisioning:** Authorization exists before its validation CNAME; the CNAME exists before certificate provisioning; the certificate exists before map entries. Tests must inspect Pulumi dependency URNs so destroy reverses this order and keeps renewal records until certificates are deleted.

8. **Edge bootstrap:** Edge stacks reference fixed Cloud Run service names rather than app-stack outputs. Deploy `production` before `production-edge` and `staging` before `staging-edge`; otherwise serverless NEG creation can fail because the named service is absent.

9. **Cross-stack teardown:** `StackReference` transfers outputs but does not automatically destroy independent stacks in dependency order. The CI/operations plan owns guarded orchestration in this mandatory order: preview/application/edge stacks, delivery locally as `rohan@windrun.ai`, then foundation locally as `rohan@windrun.ai`.

10. **Project deletion boundary:** Project resources remain `PREVENT` during normal operation. The CI/operations plan's full-platform teardown may set `windrun-ai:allowProjectDeletion=true` only after delivery is destroyed, a foundation preview is reviewed locally, and the operator explicitly acknowledges permanent deletion. Deleted projects enter `DELETE_REQUESTED` for 30 days and their IDs can never be reused.

11. **External tool prerequisites:** Infrastructure implementation and verification require Docker Buildx, pnpm/Corepack, Pulumi CLI, macOS `security`, and `shellcheck`; applying delivery with OIDC enabled additionally requires `GITHUB_TOKEN` and `PULUMI_ACCESS_TOKEN` in the local environment plus Application Default Credentials for exactly `rohan@windrun.ai`. Missing tooling blocks the affected task and does not authorize bypassing tests or using alternate cloud mutation tools.

---

## Final Self-Review Checklist

- [ ] Every infrastructure requirement in the design's Project Isolation, Stack Ownership, Routing, DNS/Certificates, Container/Image Flow, Secrets, Testing, and Teardown sections maps to a task above; workflow and lifecycle orchestration requirements map to `docs/superpowers/plans/2026-07-12-windrun-ci-operations.md`.
- [ ] Every GCP resource observed by Pulumi mocks has an explicit provider.
- [ ] No task introduces `gcloud`, `doctl`, static access tokens, service-account keys, per-preview edge resources, Shared VPC, or cross-environment IAM.
- [ ] Every application/preview `gcp.cloudrunv2.Service` keeps `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, sets `invokerIamDisabled: true`, and has no separate Cloud Run IAM binding/member/policy resource.
- [ ] Provider versions are exactly `@pulumi/gcp` 9.29.0, `@pulumi/digitalocean` 4.75.0, `@pulumi/docker-build` 0.0.20, `@pulumi/pulumiservice` 1.3.0, and `@pulumi/github` 6.14.0.
- [ ] All function names and types used by later tasks match their producing interfaces.
- [ ] No implementation step contains an unresolved placeholder; runtime-specific values come from validated Pulumi config, Git, Pulumi identity, or resource outputs.
- [ ] This plan creates no `.github/workflows` files and no high-level preview/deploy/destroy/smoke-test scripts.
- [ ] The only Windrun config keys are the exact seven-key contract, and the twelve identity outputs use the exact names required by delivery.
- [ ] The final verification commands are `pnpm -C infra check` and `shellcheck infra/scripts/bootstrap-foundation-secret.sh`.
