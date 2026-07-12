import * as pulumi from "@pulumi/pulumi";
import { isRpcSecret } from "@pulumi/pulumi/runtime/rpc";
import { describe, expect, it } from "vitest";

import {
  createDeliveryStack,
  type DeliveryStackArgs,
} from "../src/delivery";
import type { FoundationOutputs } from "../src/foundation-outputs";
import {
  capturedCalls,
  capturedResources,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

const repository = "windrun-ai";
const repositoryFullName = "rohanprabhu/windrun-ai";
const pulumiOrganization = "windrun-pulumi-user";
const githubToken = "delivery-test-github-token";
const pulumiAccessToken = "delivery-test-pulumi-token";

const environments = [
  "foundation",
  "production",
  "production-edge",
  "staging",
  "staging-edge",
  "preview",
] as const;

const privilegedEnvironments = new Set([
  "foundation",
  "production-edge",
  "staging-edge",
]);

const foundationValues = {
  sharedProjectId: "shared-project",
  stagingProjectId: "staging-project",
  productionProjectId: "production-project",
  stagingRepositoryId: "staging-repository",
  productionRepositoryId: "production-repository",
  stagingRuntimeServiceAccountEmail: "staging-runtime@example.test",
  productionRuntimeServiceAccountEmail: "production-runtime@example.test",
  stagingGlobalIp: "203.0.113.20",
  productionGlobalIp: "203.0.113.10",
  stagingCertificateMapId: "staging-certificate-map",
  productionCertificateMapId: "production-certificate-map",
  stagingCertificateStatus: "ACTIVE",
  productionCertificateStatus: "ACTIVE",
  foundationWifProvider: "wif-foundation",
  foundationDeployServiceAccount: "sa-foundation",
  productionWifProvider: "wif-production",
  productionDeployServiceAccount: "sa-production",
  stagingWifProvider: "wif-staging",
  stagingDeployServiceAccount: "sa-staging",
  previewWifProvider: "wif-preview",
  previewDeployServiceAccount: "sa-preview",
  productionEdgeWifProvider: "wif-production-edge",
  productionEdgeDeployServiceAccount: "sa-production-edge",
  stagingEdgeWifProvider: "wif-staging-edge",
  stagingEdgeDeployServiceAccount: "sa-staging-edge",
} as const;

const foundation = Object.fromEntries(
  Object.entries(foundationValues).map(([name, value]) => [
    name,
    pulumi.output(value),
  ]),
) as FoundationOutputs;

const expectedVariableValues = {
  PULUMI_ORGANIZATION: pulumiOrganization,
  GCP_WIF_PROVIDER_PRODUCTION: foundationValues.productionWifProvider,
  GCP_SERVICE_ACCOUNT_PRODUCTION:
    foundationValues.productionDeployServiceAccount,
  GCP_WIF_PROVIDER_STAGING: foundationValues.stagingWifProvider,
  GCP_SERVICE_ACCOUNT_STAGING:
    foundationValues.stagingDeployServiceAccount,
  GCP_WIF_PROVIDER_PREVIEW: foundationValues.previewWifProvider,
  GCP_SERVICE_ACCOUNT_PREVIEW: foundationValues.previewDeployServiceAccount,
  GCP_WIF_PROVIDER_PRODUCTION_EDGE:
    foundationValues.productionEdgeWifProvider,
  GCP_SERVICE_ACCOUNT_PRODUCTION_EDGE:
    foundationValues.productionEdgeDeployServiceAccount,
  GCP_WIF_PROVIDER_STAGING_EDGE:
    foundationValues.stagingEdgeWifProvider,
  GCP_SERVICE_ACCOUNT_STAGING_EDGE:
    foundationValues.stagingEdgeDeployServiceAccount,
  GCP_WIF_PROVIDER_FOUNDATION: foundationValues.foundationWifProvider,
  GCP_SERVICE_ACCOUNT_FOUNDATION:
    foundationValues.foundationDeployServiceAccount,
} as const;

function deliveryArgs(enablePulumiGithubOidc: boolean): DeliveryStackArgs {
  return {
    pulumiOrganization,
    enablePulumiGithubOidc,
    productionCiEnabled: enablePulumiGithubOidc,
    stagingCiEnabled: enablePulumiGithubOidc,
    foundation,
  };
}

function withCredentialEnvironment<T>(
  credentials: {
    githubToken?: string;
    pulumiAccessToken?: string;
  },
  run: () => T,
): T {
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousPulumiAccessToken = process.env.PULUMI_ACCESS_TOKEN;
  if (credentials.githubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = credentials.githubToken;
  }
  if (credentials.pulumiAccessToken === undefined) {
    delete process.env.PULUMI_ACCESS_TOKEN;
  } else {
    process.env.PULUMI_ACCESS_TOKEN = credentials.pulumiAccessToken;
  }

  try {
    return run();
  } finally {
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
    if (previousPulumiAccessToken === undefined) {
      delete process.env.PULUMI_ACCESS_TOKEN;
    } else {
      process.env.PULUMI_ACCESS_TOKEN = previousPulumiAccessToken;
    }
  }
}

async function createFixture(enablePulumiGithubOidc: boolean) {
  await setWindrunMocks("delivery");
  const outputs = withCredentialEnvironment(
    { githubToken, pulumiAccessToken },
    () => createDeliveryStack(deliveryArgs(enablePulumiGithubOidc)),
  );
  const ciEnabled = await resolveOutput(outputs.ciEnabled);
  return { outputs, ciEnabled };
}

describe("local-only delivery stack", () => {
  it("fails closed at the factory boundary without GITHUB_TOKEN", async () => {
    await setWindrunMocks("delivery");

    expect(() =>
      withCredentialEnvironment({ pulumiAccessToken }, () =>
        createDeliveryStack(deliveryArgs(true)),
      ),
    ).toThrow("GITHUB_TOKEN is required for the delivery stack");
    expect(capturedResources).toEqual([]);
  });

  it("fails closed at the factory boundary without enabled OIDC credentials", async () => {
    await setWindrunMocks("delivery");

    expect(() =>
      withCredentialEnvironment({ githubToken }, () =>
        createDeliveryStack(deliveryArgs(true)),
      ),
    ).toThrow(
      "PULUMI_ACCESS_TOKEN is required when Pulumi GitHub OIDC is enabled",
    );
    expect(capturedResources).toEqual([]);
  });

  it("allows disabled OIDC without PULUMI_ACCESS_TOKEN", async () => {
    await setWindrunMocks("delivery");

    const outputs = withCredentialEnvironment({ githubToken }, () =>
      createDeliveryStack(deliveryArgs(false)),
    );
    expect(await resolveOutput(outputs.ciEnabled)).toBe(false);
    expect(resourcesOfType("pulumi:providers:github")).toHaveLength(1);
    expect(resourcesOfType("pulumi:providers:pulumiservice")).toEqual([]);
  });

  it("restores credential sentinels before a successful factory call returns", async () => {
    await setWindrunMocks("delivery");

    const outputs = withCredentialEnvironment(
      { githubToken, pulumiAccessToken },
      () => {
        const result = createDeliveryStack(deliveryArgs(true));
        expect(process.env.GITHUB_TOKEN).toBe(githubToken);
        expect(process.env.PULUMI_ACCESS_TOKEN).toBe(pulumiAccessToken);
        return result;
      },
    );
    expect(await resolveOutput(outputs.ciEnabled)).toBe(true);
  });

  it("restores credential sentinels when resource construction throws", async () => {
    await setWindrunMocks("delivery");
    const constructionError = "delivery construction sentinel";
    const throwingArgs = {
      get pulumiOrganization(): string {
        throw new Error(constructionError);
      },
      enablePulumiGithubOidc: true,
      foundation,
    } as DeliveryStackArgs;

    withCredentialEnvironment({ githubToken, pulumiAccessToken }, () => {
      expect(() => createDeliveryStack(throwingArgs)).toThrow(
        constructionError,
      );
      expect(process.env.GITHUB_TOKEN).toBe(githubToken);
      expect(process.env.PULUMI_ACCESS_TOKEN).toBe(pulumiAccessToken);
    });
    expect(capturedResources).toEqual([]);
  });

  it("creates exact GitHub environments and custom deployment policies", async () => {
    await createFixture(true);

    const githubProvider = resourcesOfType("pulumi:providers:github");
    expect(githubProvider).toHaveLength(1);
    expect(githubProvider[0].inputs).toEqual({
      owner: "rohanprabhu",
      baseUrl: "https://api.github.com/",
    });

    const environmentResources = resourcesOfType(
      "github:index/repositoryEnvironment:RepositoryEnvironment",
    );
    expect(environmentResources).toHaveLength(6);
    for (const environment of environments) {
      const resource = environmentResources.find(
        (candidate) => candidate.inputs.environment === environment,
      );
      expect(resource?.inputs).toEqual({
        repository,
        environment,
        canAdminsBypass: false,
        preventSelfReview: false,
        deploymentBranchPolicy: {
          protectedBranches: false,
          customBranchPolicies: true,
        },
        ...(privilegedEnvironments.has(environment)
          ? { reviewers: [{ users: [136263] }] }
          : {}),
      });
    }

    const policies = resourcesOfType(
      "github:index/repositoryEnvironmentDeploymentPolicy:RepositoryEnvironmentDeploymentPolicy",
    );
    expect(
      policies
        .map((policy) => [
          policy.inputs.environment,
          policy.inputs.branchPattern,
        ])
        .sort(),
    ).toEqual(
      [
        ["foundation", "main"],
        ["production", "main"],
        ["production-edge", "main"],
        ["staging", "staging"],
        ["staging-edge", "main"],
        ["preview", "refs/pull/*/merge"],
        ["preview", "main"],
      ].sort(),
    );
    for (const policy of policies) {
      expect(policy.inputs.repository).toBe(repository);
      expect(policy.provider).toBe(githubProviderRef());
      expect(policy.dependencies).toContain(
        mockUrn(
          "github:index/repositoryEnvironment:RepositoryEnvironment",
          `${String(policy.inputs.environment)}-environment`,
          "delivery",
        ),
      );
    }
    for (const environment of environmentResources) {
      expect(environment.provider).toBe(githubProviderRef());
    }
  });

  it("publishes only the exact non-secret repository variables and registers the gate last", async () => {
    const { ciEnabled } = await createFixture(true);
    expect(ciEnabled).toBe(true);

    const variables = resourcesOfType(
      "github:index/actionsVariable:ActionsVariable",
    );
    expect(variables).toHaveLength(16);
    const values = Object.fromEntries(
      variables.map((variable) => [
        variable.inputs.variableName,
        variable.inputs.value,
      ]),
    );
    expect(values).toEqual({
      ...expectedVariableValues,
      PULUMI_CI_ENABLED: "true",
      PULUMI_PRODUCTION_ENABLED: "true",
      PULUMI_STAGING_ENABLED: "true",
    });
    expect(JSON.stringify(values)).not.toContain(githubToken);
    expect(JSON.stringify(values)).not.toContain(pulumiAccessToken);
    expect(
      variables.filter((variable) => isRpcSecret(variable.inputs.value)),
    ).toEqual([]);
    for (const variable of variables) {
      expect(variable.inputs.repository).toBe(repository);
      expect(variable.provider).toBe(githubProviderRef());
    }

    const gate = variables.find(
      (variable) => variable.inputs.variableName === "PULUMI_CI_ENABLED",
    );
    expect(gate).toBeDefined();
    expect(capturedResources.at(-1)?.name).toBe(gate?.name);
    const prerequisites = capturedResources.filter(
      (resource) =>
        resource.type ===
          "github:index/repositoryEnvironment:RepositoryEnvironment" ||
        resource.type ===
          "github:index/repositoryEnvironmentDeploymentPolicy:RepositoryEnvironmentDeploymentPolicy" ||
        (resource.type === "github:index/actionsVariable:ActionsVariable" &&
          resource.inputs.variableName !== "PULUMI_CI_ENABLED") ||
        resource.type === "pulumiservice:index:OidcIssuer",
    );
    expect([...(gate?.dependencies ?? [])].sort()).toEqual(
      prerequisites
        .map((resource) => mockUrn(resource.type, resource.name, "delivery"))
        .sort(),
    );
  });

  it("removes disabled-scope OIDC policies and publishes persistent scope gates", async () => {
    await setWindrunMocks("delivery");
    const outputs = withCredentialEnvironment({ githubToken, pulumiAccessToken }, () =>
      createDeliveryStack({
        ...deliveryArgs(true),
        productionCiEnabled: false,
        stagingCiEnabled: true,
      }),
    );
    await resolveOutput(outputs.ciEnabled);

    const variables = Object.fromEntries(
      resourcesOfType("github:index/actionsVariable:ActionsVariable").map(
        (resource) => [
          resource.inputs.variableName,
          resource.inputs.value,
        ],
      ),
    );
    expect(variables.PULUMI_CI_ENABLED).toBe("true");
    expect(variables.PULUMI_PRODUCTION_ENABLED).toBe("false");
    expect(variables.PULUMI_STAGING_ENABLED).toBe("true");

    const issuer = resourcesOfType(
      "pulumiservice:index:OidcIssuer",
    )[0];
    const policies = issuer.inputs.policies as Array<{
      rules: { environment: string };
    }>;
    expect(
      policies.some(
        (policy: { rules: { environment: string } }) =>
          policy.rules.environment === "production" ||
          policy.rules.environment === "production-edge",
      ),
    ).toBe(false);
    expect(
      policies.some(
        (policy: { rules: { environment: string } }) =>
          policy.rules.environment === "staging" ||
          policy.rules.environment === "preview",
      ),
    ).toBe(true);
  });

  it("creates exact immutable Pulumi personal-token trust when enabled", async () => {
    await createFixture(true);

    const providers = resourcesOfType("pulumi:providers:pulumiservice");
    expect(providers).toHaveLength(1);
    expect(providers[0].inputs).toEqual({
      apiUrl: "https://api.pulumi.com",
    });

    const issuers = resourcesOfType("pulumiservice:index:OidcIssuer");
    expect(issuers).toHaveLength(1);
    expect(issuers[0].provider).toBe(pulumiServiceProviderRef());
    expect(issuers[0].inputs).toEqual({
      name: "windrun-github-actions",
      organization: pulumiOrganization,
      url: "https://token.actions.githubusercontent.com",
      maxExpirationSeconds: 3600,
      policies: expectedOidcPolicies(),
    });
    expect(issuers[0].inputs.policies).not.toEqual([]);
    expect(
      (issuers[0].inputs.policies as Array<{
        rules: Record<string, string>;
      }>)
        .filter((policy) => policy.rules.environment === "preview")
        .map((policy) => policy.rules.base_ref),
    ).toEqual(["main", "main", "main"]);

    const issuerPrerequisites = capturedResources.filter(
      (resource) =>
        resource.type ===
          "github:index/repositoryEnvironment:RepositoryEnvironment" ||
        resource.type ===
          "github:index/repositoryEnvironmentDeploymentPolicy:RepositoryEnvironmentDeploymentPolicy",
    );
    expect(issuerPrerequisites).toHaveLength(13);
    expect([...issuers[0].dependencies].sort()).toEqual(
      issuerPrerequisites
        .map((resource) => mockUrn(resource.type, resource.name, "delivery"))
        .sort(),
    );
  });

  it("keeps Pulumi OIDC disabled until the account-claim checkpoint", async () => {
    const { ciEnabled } = await createFixture(false);
    expect(ciEnabled).toBe(false);
    expect(resourcesOfType("pulumi:providers:pulumiservice")).toEqual([]);
    expect(resourcesOfType("pulumiservice:index:OidcIssuer")).toEqual([]);

    const gate = resourcesOfType(
      "github:index/actionsVariable:ActionsVariable",
    ).find(
      (variable) => variable.inputs.variableName === "PULUMI_CI_ENABLED",
    );
    expect(gate?.inputs.value).toBe("false");
    expect(gate?.dependencies).toHaveLength(28);
  });

  it("creates no repository, cloud, workflow, secret, or key resource", async () => {
    await createFixture(true);

    const allowedTypes = new Set([
      "pulumi:providers:github",
      "pulumi:providers:pulumiservice",
      "github:index/repositoryEnvironment:RepositoryEnvironment",
      "github:index/repositoryEnvironmentDeploymentPolicy:RepositoryEnvironmentDeploymentPolicy",
      "github:index/actionsVariable:ActionsVariable",
      "pulumiservice:index:OidcIssuer",
    ]);
    expect(
      capturedResources.filter((resource) => !allowedTypes.has(resource.type)),
    ).toEqual([]);
    expect(capturedCalls).toEqual([]);
    expect(
      capturedResources.filter((resource) =>
        /repository:Repository|workflow|secret|serviceaccount\/key/i.test(
          resource.type,
        ),
      ),
    ).toEqual([]);
  });
});

function githubProviderRef() {
  return `${mockUrn(
    "pulumi:providers:github",
    "github-windrun",
    "delivery",
  )}::github-windrun-id`;
}

function pulumiServiceProviderRef() {
  return `${mockUrn(
    "pulumi:providers:pulumiservice",
    "pulumi-service-windrun",
    "delivery",
  )}::pulumi-service-windrun-id`;
}

function commonOidcRules(environment: (typeof environments)[number]) {
  return {
    aud: `urn:pulumi:org:${pulumiOrganization}`,
    repository_id: "1095528250",
    repository_owner_id: "136263",
    repository: repositoryFullName,
    environment,
    sub: `repo:*:environment:${environment}`,
  };
}

function personalPolicy(
  environment: (typeof environments)[number],
  rules: Record<string, string>,
) {
  return {
    decision: "allow",
    tokenType: "personal",
    userLogin: pulumiOrganization,
    rules: { ...commonOidcRules(environment), ...rules },
  };
}

function expectedOidcPolicies() {
  const workflow = `${repositoryFullName}/.github/workflows/`;
  return [
    personalPolicy("foundation", {
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      workflow_ref: `${workflow}manage-foundation.yml@refs/heads/main`,
    }),
    personalPolicy("production", {
      event_name: "push",
      ref: "refs/heads/main",
      workflow_ref: `${workflow}deploy-production.yml@refs/heads/main`,
    }),
    personalPolicy("production-edge", {
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      workflow_ref: `${workflow}manage-edge.yml@refs/heads/main`,
    }),
    personalPolicy("staging", {
      event_name: "push",
      ref: "refs/heads/staging",
      workflow_ref: `${workflow}deploy-staging.yml@refs/heads/staging`,
    }),
    personalPolicy("staging-edge", {
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      workflow_ref: `${workflow}manage-edge.yml@refs/heads/main`,
    }),
    personalPolicy("preview", {
      event_name: "pull_request",
      base_ref: "main",
      ref: "refs/pull/*/merge",
      workflow_ref: `${workflow}pull-request.yml@refs/pull/*/merge`,
      job_workflow_ref: `${workflow}_preview-deploy.yml@refs/heads/main`,
    }),
    personalPolicy("preview", {
      event_name: "pull_request",
      base_ref: "main",
      ref: "refs/pull/*/merge",
      workflow_ref: `${workflow}pull-request.yml@refs/pull/*/merge`,
      job_workflow_ref: `${workflow}_preview-destroy.yml@refs/heads/main`,
    }),
    personalPolicy("preview", {
      event_name: "pull_request",
      base_ref: "main",
      ref: "refs/heads/main",
      workflow_ref: `${workflow}pull-request.yml@refs/heads/main`,
      job_workflow_ref: `${workflow}_preview-destroy.yml@refs/heads/main`,
    }),
  ];
}
