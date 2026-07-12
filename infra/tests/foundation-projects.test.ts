import { beforeEach, describe, expect, it } from "vitest";

import { BILLING_ACCOUNT, ORGANIZATION_ID, PROJECT_IDS } from "../src/constants";
import { createFoundationCoreResources } from "../src/foundation/core";
import { createProjectBundle, type ProjectBundle } from "../src/foundation/projects";
import { SHARED_APIS, WORKLOAD_APIS } from "../src/foundation/services";
import { createBootstrapProvider } from "../src/providers";
import {
  capturedResources,
  gcpResourcesWithoutExplicitProvider,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

async function createFoundationProjects(allowProjectDeletion: boolean) {
  const bootstrapProvider = createBootstrapProvider();
  const shared = createProjectBundle({
    logicalName: "shared",
    projectId: PROJECT_IDS.shared,
    bootstrapProvider,
    allowProjectDeletion,
    services: SHARED_APIS,
  });
  const staging = createProjectBundle({
    logicalName: "staging",
    projectId: PROJECT_IDS.staging,
    bootstrapProvider,
    allowProjectDeletion,
    services: WORKLOAD_APIS,
  });
  const production = createProjectBundle({
    logicalName: "production",
    projectId: PROJECT_IDS.production,
    bootstrapProvider,
    allowProjectDeletion,
    services: WORKLOAD_APIS,
  });

  await settleBundles([shared, staging, production]);
  return { shared, staging, production };
}

async function settleBundles(bundles: ProjectBundle[]) {
  await Promise.all(
    bundles.flatMap((bundle) => [
      resolveOutput(bundle.project.urn),
      resolveOutput(bundle.provider.urn),
      ...Object.values(bundle.services).map((service) =>
        resolveOutput(service.urn),
      ),
    ]),
  );
}

beforeEach(async () => {
  await setWindrunMocks("foundation-projects-test");
});

describe("isolated GCP project factory", () => {
  it("creates exactly three protected projects and only their declared APIs", async () => {
    await createFoundationProjects(false);

    const projects = resourcesOfType("gcp:organizations/project:Project");
    expect(projects).toHaveLength(3);

    for (const [logicalName, projectId] of Object.entries(PROJECT_IDS)) {
      const project = projects.find(
        (resource) => resource.name === `${logicalName}-project`,
      );
      expect(project?.inputs).toMatchObject({
        projectId,
        orgId: ORGANIZATION_ID,
        billingAccount: BILLING_ACCOUNT,
        autoCreateNetwork: false,
        deletionPolicy: "PREVENT",
      });
      expect(project?.inputs).not.toHaveProperty("folderId");
      expect(project?.provider).toContain(
        mockUrn(
          "pulumi:providers:gcp",
          "gcp-bootstrap",
          "foundation-projects-test",
        ),
      );
    }

    const services = resourcesOfType("gcp:projects/service:Service");
    expect(services).toHaveLength(
      SHARED_APIS.length + WORKLOAD_APIS.length * 2,
    );

    for (const [logicalName, expectedApis] of [
      ["shared", SHARED_APIS],
      ["staging", WORKLOAD_APIS],
      ["production", WORKLOAD_APIS],
    ] as const) {
      const projectId = PROJECT_IDS[logicalName];
      const projectServices = services.filter(
        (resource) => resource.inputs.project === projectId,
      );

      expect(projectServices.map((resource) => resource.inputs.service).sort()).toEqual(
        [...expectedApis].sort(),
      );
      for (const service of projectServices) {
        expect(service.inputs.disableOnDestroy).toBe(false);
        expect(service.provider).toContain(
          mockUrn(
            "pulumi:providers:gcp",
            `gcp-${logicalName}`,
            "foundation-projects-test",
          ),
        );
        expect(service.dependencies).toContain(
          mockUrn(
            "gcp:organizations/project:Project",
            `${logicalName}-project`,
            "foundation-projects-test",
          ),
        );
      }
    }

    expect(gcpResourcesWithoutExplicitProvider()).toEqual([]);
  });

  it("opts into project deletion only for acknowledged teardown", async () => {
    await createFoundationProjects(true);

    expect(
      resourcesOfType("gcp:organizations/project:Project").map(
        (resource) => resource.inputs.deletionPolicy,
      ),
    ).toEqual(["DELETE", "DELETE", "DELETE"]);
  });

  it("does not register any undeclared GCP resource family", async () => {
    await createFoundationProjects(false);

    const allowedTypes = new Set([
      "pulumi:providers:gcp",
      "gcp:organizations/project:Project",
      "gcp:projects/service:Service",
    ]);
    expect(
      capturedResources.filter((resource) => !allowedTypes.has(resource.type)),
    ).toEqual([]);
  });

  it("adds isolated registries, IPs, and permissionless runtime identities", async () => {
    const { staging, production } = await createFoundationProjects(false);
    const core = createFoundationCoreResources({ staging, production });

    await Promise.all([
      resolveOutput(core.productionRepository.urn),
      resolveOutput(core.stagingRepository.urn),
      resolveOutput(core.productionAddress.urn),
      resolveOutput(core.stagingAddress.urn),
      resolveOutput(core.productionRuntimeServiceAccount.urn),
      resolveOutput(core.stagingRuntimeServiceAccount.urn),
    ]);

    const repositories = resourcesOfType(
      "gcp:artifactregistry/repository:Repository",
    );
    expect(repositories).toHaveLength(2);
    for (const [logicalName, projectId] of [
      ["production", PROJECT_IDS.production],
      ["staging", PROJECT_IDS.staging],
    ] as const) {
      const repository = repositories.find(
        (resource) => resource.name === `${logicalName}-repository`,
      );
      expect(repository?.inputs).toMatchObject({
        project: projectId,
        location: "asia-south1",
        repositoryId: "windrun",
        format: "DOCKER",
        mode: "STANDARD_REPOSITORY",
        dockerConfig: { immutableTags: false },
        cleanupPolicyDryRun: false,
      });
      const expectedStaticPolicies = [
        {
          id: `delete-old-${logicalName}`,
          action: "DELETE",
          condition: {
            tagState: "ANY",
            packageNamePrefixes: [logicalName],
            olderThan: "90d",
          },
        },
        {
          id: `keep-recent-${logicalName}`,
          action: "KEEP",
          mostRecentVersions: {
            packageNamePrefixes: [logicalName],
            keepCount: 10,
          },
        },
      ];
      expect(repository?.inputs.cleanupPolicies).toEqual(
        logicalName === "staging"
          ? [
              {
                id: "delete-old-previews",
                action: "DELETE",
                condition: {
                  tagState: "ANY",
                  packageNamePrefixes: ["pr-"],
                  olderThan: "30d",
                },
              },
              ...expectedStaticPolicies,
            ]
          : expectedStaticPolicies,
      );
      expect(repository?.dependencies).toContain(
        mockUrn(
          "gcp:projects/service:Service",
          `${logicalName}-artifactregistry-api`,
          "foundation-projects-test",
        ),
      );
    }

    const addresses = resourcesOfType("gcp:compute/globalAddress:GlobalAddress");
    expect(addresses).toHaveLength(2);
    for (const logicalName of ["production", "staging"] as const) {
      const address = addresses.find(
        (resource) => resource.name === `${logicalName}-address`,
      );
      expect(address?.inputs).toMatchObject({
        project: PROJECT_IDS[logicalName],
        addressType: "EXTERNAL",
        ipVersion: "IPV4",
      });
      expect(address?.dependencies).toContain(
        mockUrn(
          "gcp:projects/service:Service",
          `${logicalName}-compute-api`,
          "foundation-projects-test",
        ),
      );
    }

    const runtimeAccounts = resourcesOfType(
      "gcp:serviceaccount/account:Account",
    );
    expect(runtimeAccounts).toHaveLength(2);
    expect(
      runtimeAccounts.map((resource) => resource.inputs.accountId).sort(),
    ).toEqual(["production-runtime", "staging-runtime"]);
    for (const account of runtimeAccounts) {
      const logicalName = account.name.startsWith("production")
        ? "production"
        : "staging";
      expect(account.inputs.project).toBe(PROJECT_IDS[logicalName]);
      expect(account.dependencies).toContain(
        mockUrn(
          "gcp:projects/service:Service",
          `${logicalName}-iam-api`,
          "foundation-projects-test",
        ),
      );
    }

    expect(
      capturedResources.filter(
        (resource) =>
          resource.type.includes("IAM") ||
          resource.type.includes("iAM") ||
          resource.type.includes("iam"),
      ),
    ).toEqual([]);
    expect(gcpResourcesWithoutExplicitProvider()).toEqual([]);
  });
});
