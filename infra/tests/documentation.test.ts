import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const infraDirectory = resolve(__dirname, "..");
const documents = ["README.md", "TEARDOWN.md"] as const;

const configKeys = [
  "windrun-ai:stackKind",
  "windrun-ai:gitCommitSha",
  "windrun-ai:pullRequestNumber",
  "windrun-ai:allowProjectDeletion",
  "windrun-ai:enablePulumiGithubOidc",
  "windrun-ai:pulumiOrganization",
] as const;

const stackKinds = [
  "foundation",
  "delivery",
  "production-edge",
  "production",
  "staging-edge",
  "staging",
  "preview",
] as const;

const foundationOutputs = [
  "sharedProjectId",
  "stagingProjectId",
  "productionProjectId",
  "stagingRepositoryId",
  "productionRepositoryId",
  "stagingRuntimeServiceAccountEmail",
  "productionRuntimeServiceAccountEmail",
  "stagingGlobalIp",
  "productionGlobalIp",
  "apexNameServers",
  "stagingCertificateMapId",
  "productionCertificateMapId",
  "stagingCertificateStatus",
  "productionCertificateStatus",
  "foundationWifProvider",
  "foundationDeployServiceAccount",
  "productionWifProvider",
  "productionDeployServiceAccount",
  "stagingWifProvider",
  "stagingDeployServiceAccount",
  "previewWifProvider",
  "previewDeployServiceAccount",
  "productionEdgeWifProvider",
  "productionEdgeDeployServiceAccount",
  "stagingEdgeWifProvider",
  "stagingEdgeDeployServiceAccount",
] as const;

const repositoryVariables = [
  "PULUMI_CI_ENABLED",
  "PULUMI_ORGANIZATION",
  "GCP_WIF_PROVIDER_PRODUCTION",
  "GCP_SERVICE_ACCOUNT_PRODUCTION",
  "GCP_WIF_PROVIDER_STAGING",
  "GCP_SERVICE_ACCOUNT_STAGING",
  "GCP_WIF_PROVIDER_PREVIEW",
  "GCP_SERVICE_ACCOUNT_PREVIEW",
  "GCP_WIF_PROVIDER_PRODUCTION_EDGE",
  "GCP_SERVICE_ACCOUNT_PRODUCTION_EDGE",
  "GCP_WIF_PROVIDER_STAGING_EDGE",
  "GCP_SERVICE_ACCOUNT_STAGING_EDGE",
  "GCP_WIF_PROVIDER_FOUNDATION",
  "GCP_SERVICE_ACCOUNT_FOUNDATION",
] as const;

function readDocument(fileName: (typeof documents)[number]) {
  const path = resolve(infraDirectory, fileName);
  expect(existsSync(path), `${fileName} must exist`).toBe(true);
  return readFileSync(path, "utf8");
}

function expectInOrder(document: string, values: readonly string[]) {
  let previousIndex = -1;
  for (const value of values) {
    const index = document.indexOf(value, previousIndex + 1);
    expect(index, `expected ${value} after offset ${previousIndex}`).toBeGreaterThan(
      previousIndex,
    );
    previousIndex = index;
  }
}

describe.each(documents)("infra/%s", (fileName) => {
  it("records the complete typed infrastructure contract", () => {
    const document = readDocument(fileName);

    for (const key of configKeys) expect(document).toContain(key);
    for (const kind of stackKinds) expect(document).toContain(kind);
    for (const output of foundationOutputs) expect(document).toContain(output);
  });

  it("records both bootstrap phases and the delivery checkpoint", () => {
    const document = readDocument(fileName);

    expect(document).toContain(
      "foundation -> production -> production-edge -> staging -> staging-edge",
    );
    expect(document).toContain("pulumi whoami");
    expect(document).toContain("windrun-ai:pulumiOrganization");
    expect(document).toContain(
      "`rohan@windrun.ai` is the claim email, not the Pulumi login",
    );
    expect(document).toContain(
      "`windrun-ai:pulumiOrganization` comes only from `pulumi whoami`",
    );
    expect(document).not.toContain(
      "Claim the Pulumi account as `rohan@windrun.ai`",
    );
    expect(document).not.toMatch(
      /Pulumi (?:login|username) (?:is|equals) `rohan@windrun\.ai`/iu,
    );
    expect(document).toContain("windrun-ai:enablePulumiGithubOidc=true");
    expect(document).toContain("GITHUB_TOKEN");
    expect(document).toContain("PULUMI_ACCESS_TOKEN");
    expect(document).toContain("PULUMI_CI_ENABLED=true");
    expect(document).toContain("delivery");
  });

  it("records delivery environments, policies, variables, and credential flow", () => {
    const document = readDocument(fileName);

    for (const variable of repositoryVariables) expect(document).toContain(variable);
    expect(document).toContain("foundation: main");
    expect(document).toContain("production: main");
    expect(document).toContain("production-edge: main");
    expect(document).toContain("staging: staging");
    expect(document).toContain("staging-edge: main");
    expect(document).toContain("preview: refs/pull/*/merge and main");
    expect(document).toContain("reviewer ID 136263");
    expect(document).toContain("administrators cannot bypass");
    expect(document).toContain("https://api.github.com/");
    expect(document).toContain("https://api.pulumi.com");
    expect(document).toContain("persist only non-secret configuration");
    expect(document).toContain("GitHub owner `rohanprabhu`");
    expect(document).not.toContain(
      "contain only the official endpoints",
    );
    expect(document).toContain(
      "GitHub provider plugin consumes `GITHUB_TOKEN`",
    );
    expect(document).toContain(
      "Pulumi Service provider plugin consumes `PULUMI_ACCESS_TOKEN`",
    );
    expect(document).toContain("child-process environment");
    expect(document).toContain("not provider inputs or Pulumi state");
  });

  it("records the destructive boundary and permanent project lifecycle", () => {
    const document = readDocument(fileName);

    expectInOrder(document, [
      "all preview/application/edge stacks empty",
      "delivery destroyed",
      "foundation destroyed locally as rohan@windrun.ai",
    ]);
    expect(document).toContain("windrun-ai:allowProjectDeletion=true");
    expect(document).toContain("deletionPolicy: DELETE");
    expect(document).toContain("DELETE_REQUESTED");
    expect(document).toContain("30-day recovery window");
    expect(document).toContain("project IDs can never be reused");
    expect(document).toContain(
      "Cloud DNS record sets are deleted before the apex zone",
    );
    expect(document).toContain(
      "validation CNAMEs are deleted after certificates",
    );
    expect(document).toContain("projects are scheduled last");
  });

  it("hands executable automation to the CI/operations track", () => {
    const document = readDocument(fileName);

    expect(document).toContain(
      "docs/superpowers/plans/2026-07-12-windrun-ci-operations.md",
    );
    expect(document).toContain(
      "owns `.github/workflows` and executable preview, deploy, destroy, and smoke-test scripts",
    );
    expect(document).toContain(
      "authorize no `gh` or mutating `gcloud` command",
    );
    expect(document).toContain("Delivery invokes no `gh` command");
    expect(document).not.toMatch(
      /\b(?:this infrastructure (?:directory|track|documentation)|infrastructure|infra) (?:owns?|creates?|implements?|maintains?) [^\n]*`\.github\/workflows`/iu,
    );
    expect(document).not.toMatch(
      /\b(?:this infrastructure (?:directory|track|documentation)|infrastructure|infra) (?:owns?|creates?|implements?|maintains?) [^\n]*(?:preview|deploy|destroy|smoke-test) scripts?/iu,
    );

    const executableCloudCliMutations = document
      .split("\n")
      .filter((line) => /^\s*(?:\$\s*)?(?:gh|gcloud)\s+/u.test(line));
    expect(executableCloudCliMutations).toEqual([]);
  });
});
