import { beforeEach, describe, expect, it } from "vitest";

import {
  GITHUB_OWNER_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  PROJECT_IDS,
} from "../src/constants";
import { createFoundationCoreResources } from "../src/foundation/core";
import {
  GITHUB_ATTRIBUTE_MAPPING,
  createGitHubDeploymentIdentities,
  type DeploymentIdentityKind,
} from "../src/foundation/github-wif";
import {
  createProjectBundle,
  type ProjectBundle,
} from "../src/foundation/projects";
import {
  SHARED_APIS,
  WORKLOAD_APIS,
} from "../src/foundation/services";
import { createBootstrapProvider } from "../src/providers";
import {
  gcpResourcesWithoutExplicitProvider,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

const identityProject = {
  foundation: "shared",
  production: "production",
  "production-edge": "production",
  staging: "staging",
  "staging-edge": "staging",
  preview: "staging",
} as const satisfies Record<
  DeploymentIdentityKind,
  keyof typeof PROJECT_IDS
>;

const projectNumbers = {
  shared: "100000000001",
  staging: "100000000002",
  production: "100000000003",
} as const;

const workflowPrefix = `${GITHUB_REPOSITORY}/.github/workflows/`;
const previewRefPattern = "^refs/pull/[1-9][0-9]*/merge$";
const previewCallerPattern =
  `^${GITHUB_REPOSITORY}/[.]github/workflows/` +
  "pull-request[.]yml@refs/pull/[1-9][0-9]*/merge$";

function baseCondition(
  environment: DeploymentIdentityKind,
  eventName: "push" | "pull_request" | "workflow_dispatch",
) {
  return [
    `assertion.repository_id == '${GITHUB_REPOSITORY_ID}'`,
    `assertion.repository_owner_id == '${GITHUB_OWNER_ID}'`,
    `assertion.repository == '${GITHUB_REPOSITORY}'`,
    `assertion.environment == '${environment}'`,
    `assertion.event_name == '${eventName}'`,
  ].join(" && ");
}

function directCondition(args: {
  environment: DeploymentIdentityKind;
  eventName: "push" | "workflow_dispatch";
  ref: "main" | "staging";
  workflow: string;
}) {
  return (
    `${baseCondition(args.environment, args.eventName)} && ` +
    `assertion.ref == 'refs/heads/${args.ref}' && ` +
    `assertion.workflow_ref == '${workflowPrefix}${args.workflow}@refs/heads/${args.ref}'`
  );
}

const previewDeployCondition = [
  `assertion.job_workflow_ref == '${workflowPrefix}_preview-deploy.yml@refs/heads/main'`,
  `assertion.ref.matches('${previewRefPattern}')`,
  `assertion.workflow_ref.matches('${previewCallerPattern}')`,
].join(" && ");
const previewDestroyCondition = [
  `assertion.job_workflow_ref == '${workflowPrefix}_preview-destroy.yml@refs/heads/main'`,
  `((assertion.ref.matches('${previewRefPattern}') && assertion.workflow_ref.matches('${previewCallerPattern}')) || ` +
    `(assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${workflowPrefix}pull-request.yml@refs/heads/main'))`,
].join(" && ");

const expectedConditions = {
  foundation: directCondition({
    environment: "foundation",
    eventName: "workflow_dispatch",
    ref: "main",
    workflow: "manage-foundation.yml",
  }),
  production: directCondition({
    environment: "production",
    eventName: "push",
    ref: "main",
    workflow: "deploy-production.yml",
  }),
  "production-edge": directCondition({
    environment: "production-edge",
    eventName: "workflow_dispatch",
    ref: "main",
    workflow: "manage-edge.yml",
  }),
  staging: directCondition({
    environment: "staging",
    eventName: "push",
    ref: "staging",
    workflow: "deploy-staging.yml",
  }),
  "staging-edge": directCondition({
    environment: "staging-edge",
    eventName: "workflow_dispatch",
    ref: "main",
    workflow: "manage-edge.yml",
  }),
  preview:
    `${baseCondition("preview", "pull_request")} && ` +
    `assertion.base_ref == 'main' && ` +
    `((${previewDeployCondition}) || (${previewDestroyCondition}))`,
} as const satisfies Record<DeploymentIdentityKind, string>;

const expectedFoundationProjectIamCondition = {
  title: "foundation_managed_roles_only",
  description:
    "Limits foundation CI to the exact project roles managed by this Pulumi stack",
  expression:
    "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([" +
    "'roles/artifactregistry.admin', " +
    "'roles/certificatemanager.owner', " +
    "'roles/certificatemanager.viewer', " +
    "'roles/compute.loadBalancerAdmin', " +
    "'roles/compute.publicIpAdmin', " +
    "'roles/dns.admin', " +
    "'roles/iam.serviceAccountAdmin', " +
    "'roles/iam.workloadIdentityPoolAdmin', " +
    "'roles/run.admin', " +
    "'roles/serviceusage.serviceUsageAdmin'])",
} as const;

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

async function createFixture() {
  const bootstrapProvider = createBootstrapProvider();
  const shared = createProjectBundle({
    logicalName: "shared",
    projectId: PROJECT_IDS.shared,
    bootstrapProvider,
    allowProjectDeletion: false,
    services: SHARED_APIS,
  });
  const staging = createProjectBundle({
    logicalName: "staging",
    projectId: PROJECT_IDS.staging,
    bootstrapProvider,
    allowProjectDeletion: false,
    services: WORKLOAD_APIS,
  });
  const production = createProjectBundle({
    logicalName: "production",
    projectId: PROJECT_IDS.production,
    bootstrapProvider,
    allowProjectDeletion: false,
    services: WORKLOAD_APIS,
  });
  await settleBundles([shared, staging, production]);

  const core = createFoundationCoreResources({ staging, production });
  await Promise.all([
    resolveOutput(core.productionRepository.urn),
    resolveOutput(core.stagingRepository.urn),
    resolveOutput(core.productionRuntimeServiceAccount.urn),
    resolveOutput(core.stagingRuntimeServiceAccount.urn),
  ]);

  const deployment = createGitHubDeploymentIdentities({
    shared,
    staging,
    production,
    productionRepository: core.productionRepository,
    stagingRepository: core.stagingRepository,
    productionRuntimeServiceAccount:
      core.productionRuntimeServiceAccount,
    stagingRuntimeServiceAccount: core.stagingRuntimeServiceAccount,
  });
  await Promise.all([
    ...Object.values(deployment.identities).flatMap((identity) => [
      resolveOutput(identity.serviceAccount.urn),
      resolveOutput(identity.pool.urn),
      resolveOutput(identity.provider.urn),
    ]),
    ...deployment.grants.map((grant) => resolveOutput(grant.urn)),
  ]);

  return deployment;
}

beforeEach(async () => {
  await setWindrunMocks("foundation-identity-test");
});

describe("GitHub Workload Identity Federation", () => {
  it("creates one immutable trust root per deployment boundary", async () => {
    await createFixture();

    const pools = resourcesOfType(
      "gcp:iam/workloadIdentityPool:WorkloadIdentityPool",
    );
    const providers = resourcesOfType(
      "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider",
    );
    const deploymentAccounts = resourcesOfType(
      "gcp:serviceaccount/account:Account",
    ).filter((resource) => resource.inputs.accountId !== "production-runtime" &&
      resource.inputs.accountId !== "staging-runtime");

    expect(pools).toHaveLength(6);
    expect(providers).toHaveLength(6);
    expect(deploymentAccounts).toHaveLength(6);

    for (const kind of Object.keys(identityProject) as DeploymentIdentityKind[]) {
      const logicalProject = identityProject[kind];
      const projectId = PROJECT_IDS[logicalProject];
      const pool = pools.find(
        (resource) => resource.name === `${kind}-github-pool`,
      );
      const provider = providers.find(
        (resource) => resource.name === `${kind}-github-provider`,
      );
      const account = deploymentAccounts.find(
        (resource) => resource.name === `${kind}-deploy`,
      );

      expect(pool?.inputs).toMatchObject({
        project: projectId,
        workloadIdentityPoolId: `github-${kind}`,
        mode: "FEDERATION_ONLY",
        disabled: false,
        deletionPolicy: "DELETE",
      });
      expect(provider?.inputs).toMatchObject({
        project: projectId,
        workloadIdentityPoolId: `github-${kind}`,
        workloadIdentityPoolProviderId: "github",
        disabled: false,
        deletionPolicy: "DELETE",
        oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
      });
      expect(provider?.inputs.oidc).toEqual({
        issuerUri: "https://token.actions.githubusercontent.com",
      });
      expect(account?.inputs).toMatchObject({
        project: projectId,
        accountId: `${kind}-deploy`,
      });
      expect(pool?.dependencies).toContain(
        mockUrn(
          "gcp:projects/service:Service",
          `${logicalProject}-iam-api`,
          "foundation-identity-test",
        ),
      );
      expect(provider?.dependencies).toContain(
        mockUrn(
          "gcp:iam/workloadIdentityPool:WorkloadIdentityPool",
          `${kind}-github-pool`,
          "foundation-identity-test",
        ),
      );
      expect(account?.dependencies).toContain(
        mockUrn(
          "gcp:projects/service:Service",
          `${logicalProject}-iam-api`,
          "foundation-identity-test",
        ),
      );

      const mapping = provider?.inputs.attributeMapping as Record<
        string,
        string
      >;
      if (kind === "preview") {
        expect(mapping).toEqual({
          ...GITHUB_ATTRIBUTE_MAPPING,
          "attribute.job_workflow_ref": "assertion.job_workflow_ref",
        });
      } else {
        expect(mapping).toEqual(GITHUB_ATTRIBUTE_MAPPING);
      }

      const condition = String(provider?.inputs.attributeCondition);
      expect(condition).toContain(
        `assertion.repository_id == '${GITHUB_REPOSITORY_ID}'`,
      );
      expect(condition).toContain(
        `assertion.repository_owner_id == '${GITHUB_OWNER_ID}'`,
      );
      expect(condition).toContain(
        `assertion.repository == '${GITHUB_REPOSITORY}'`,
      );
    }
  });

  it("accepts only the exact event, environment, branch, and workflow", async () => {
    await createFixture();

    const providers = resourcesOfType(
      "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider",
    );
    const conditionFor = (kind: DeploymentIdentityKind) =>
      String(
        providers.find(
          (resource) => resource.name === `${kind}-github-provider`,
        )?.inputs.attributeCondition,
      );

    for (const kind of Object.keys(expectedConditions) as DeploymentIdentityKind[]) {
      expect(conditionFor(kind)).toBe(expectedConditions[kind]);
    }
  });

  it("uses numeric pool principals and never creates service-account keys", async () => {
    await createFixture();

    const workloadIdentityBindings = resourcesOfType(
      "gcp:serviceaccount/iAMMember:IAMMember",
    ).filter(
      (resource) =>
        resource.inputs.role === "roles/iam.workloadIdentityUser",
    );
    expect(workloadIdentityBindings).toHaveLength(6);
    expect(
      resourcesOfType("gcp:serviceaccount/iAMMember:IAMMember"),
    ).toHaveLength(9);

    for (const kind of Object.keys(identityProject) as DeploymentIdentityKind[]) {
      const logicalProject = identityProject[kind];
      const binding = workloadIdentityBindings.find(
        (resource) => resource.name === `${kind}-github-wif-user`,
      );
      expect(binding?.inputs.member).toBe(
        `principalSet://iam.googleapis.com/projects/${projectNumbers[logicalProject]}/locations/global/workloadIdentityPools/github-${kind}/attribute.repository_id/${GITHUB_REPOSITORY_ID}`,
      );
      expect(String(binding?.inputs.member)).not.toContain(
        PROJECT_IDS[logicalProject],
      );
      expect(binding?.inputs).not.toHaveProperty("condition");
      expect(binding?.dependencies).toEqual(
        expect.arrayContaining([
          mockUrn(
            "gcp:serviceaccount/account:Account",
            `${kind}-deploy`,
            "foundation-identity-test",
          ),
          mockUrn(
            "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider",
            `${kind}-github-provider`,
            "foundation-identity-test",
          ),
        ]),
      );
    }

    expect(resourcesOfType("gcp:serviceaccount/key:Key")).toEqual([]);
  });

  it("keeps application and edge permissions inside their environment", async () => {
    await createFixture();

    const projectMembers = resourcesOfType(
      "gcp:projects/iAMMember:IAMMember",
    );
    expect(projectMembers).toHaveLength(26);
    const foundationMember =
      `serviceAccount:foundation-deploy@${PROJECT_IDS.shared}.iam.gserviceaccount.com`;
    expect(
      projectMembers
        .filter((resource) => resource.inputs.member !== foundationMember)
        .map((resource) => ({
          name: resource.name,
          member: resource.inputs.member,
          project: resource.inputs.project,
          role: resource.inputs.role,
          condition: resource.inputs.condition ?? null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      {
        name: "preview-cloud-run-admin",
        member: `serviceAccount:preview-deploy@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
        project: PROJECT_IDS.staging,
        role: "roles/run.admin",
        condition: null,
      },
      {
        name: "production-cloud-run-admin",
        member: `serviceAccount:production-deploy@${PROJECT_IDS.production}.iam.gserviceaccount.com`,
        project: PROJECT_IDS.production,
        role: "roles/run.admin",
        condition: null,
      },
      {
        name: "production-edge-certificate-viewer",
        member: `serviceAccount:production-edge-deploy@${PROJECT_IDS.production}.iam.gserviceaccount.com`,
        project: PROJECT_IDS.production,
        role: "roles/certificatemanager.viewer",
        condition: null,
      },
      {
        name: "production-edge-load-balancer-admin",
        member: `serviceAccount:production-edge-deploy@${PROJECT_IDS.production}.iam.gserviceaccount.com`,
        project: PROJECT_IDS.production,
        role: "roles/compute.loadBalancerAdmin",
        condition: null,
      },
      {
        name: "staging-cloud-run-admin",
        member: `serviceAccount:staging-deploy@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
        project: PROJECT_IDS.staging,
        role: "roles/run.admin",
        condition: null,
      },
      {
        name: "staging-edge-certificate-viewer",
        member: `serviceAccount:staging-edge-deploy@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
        project: PROJECT_IDS.staging,
        role: "roles/certificatemanager.viewer",
        condition: null,
      },
      {
        name: "staging-edge-load-balancer-admin",
        member: `serviceAccount:staging-edge-deploy@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
        project: PROJECT_IDS.staging,
        role: "roles/compute.loadBalancerAdmin",
        condition: null,
      },
    ]);
    for (const [kind, projectId] of [
      ["production", PROJECT_IDS.production],
      ["staging", PROJECT_IDS.staging],
      ["preview", PROJECT_IDS.staging],
    ] as const) {
      const runGrant = projectMembers.find(
        (resource) => resource.name === `${kind}-cloud-run-admin`,
      );
      expect(runGrant?.inputs).toMatchObject({
        project: projectId,
        role: "roles/run.admin",
        member: `serviceAccount:${kind}-deploy@${projectId}.iam.gserviceaccount.com`,
      });
      expect(runGrant?.inputs).not.toHaveProperty("condition");
    }

    const repositoryMembers = resourcesOfType(
      "gcp:artifactregistry/repositoryIamMember:RepositoryIamMember",
    );
    expect(repositoryMembers).toHaveLength(3);
    for (const [kind, projectId] of [
      ["production", PROJECT_IDS.production],
      ["staging", PROJECT_IDS.staging],
      ["preview", PROJECT_IDS.staging],
    ] as const) {
      const grant = repositoryMembers.find(
        (resource) => resource.name === `${kind}-artifact-writer`,
      );
      expect(grant?.inputs).toMatchObject({
        project: projectId,
        location: "asia-south1",
        repository: "windrun",
        role: "roles/artifactregistry.writer",
        member: `serviceAccount:${kind}-deploy@${projectId}.iam.gserviceaccount.com`,
      });
    }

    const runtimeMembers = resourcesOfType(
      "gcp:serviceaccount/iAMMember:IAMMember",
    ).filter(
      (resource) =>
        resource.inputs.role === "roles/iam.serviceAccountUser",
    );
    expect(runtimeMembers).toHaveLength(3);
    for (const [kind, projectId, runtime] of [
      ["production", PROJECT_IDS.production, "production-runtime"],
      ["staging", PROJECT_IDS.staging, "staging-runtime"],
      ["preview", PROJECT_IDS.staging, "staging-runtime"],
    ] as const) {
      const grant = runtimeMembers.find(
        (resource) => resource.name === `${kind}-runtime-user`,
      );
      expect(grant?.inputs).toMatchObject({
        serviceAccountId: `projects/${projectId}/serviceAccounts/${runtime}@${projectId}.iam.gserviceaccount.com`,
        role: "roles/iam.serviceAccountUser",
        member: `serviceAccount:${kind}-deploy@${projectId}.iam.gserviceaccount.com`,
      });
    }

    for (const [kind, projectId] of [
      ["production-edge", PROJECT_IDS.production],
      ["staging-edge", PROJECT_IDS.staging],
    ] as const) {
      const grants = projectMembers.filter(
        (resource) =>
          resource.inputs.member ===
          `serviceAccount:${kind}-deploy@${projectId}.iam.gserviceaccount.com`,
      );
      expect(grants.map((resource) => resource.inputs.role).sort()).toEqual([
        "roles/certificatemanager.viewer",
        "roles/compute.loadBalancerAdmin",
      ]);
      expect(grants.map((resource) => resource.inputs.project)).toEqual([
        projectId,
        projectId,
      ]);
    }
  });

  it("grants foundation only the project-local administration needed for normal updates", async () => {
    await createFixture();

    const foundationMember =
      `serviceAccount:foundation-deploy@${PROJECT_IDS.shared}.iam.gserviceaccount.com`;
    const foundationProjectMembers = resourcesOfType(
      "gcp:projects/iAMMember:IAMMember",
    ).filter((resource) => resource.inputs.member === foundationMember);
    const commonRoles = [
      "roles/iam.serviceAccountAdmin",
      "roles/iam.workloadIdentityPoolAdmin",
      "roles/resourcemanager.projectIamAdmin",
      "roles/serviceusage.serviceUsageAdmin",
    ];
    const expectedRoles = {
      [PROJECT_IDS.shared]: [...commonRoles, "roles/dns.admin"],
      [PROJECT_IDS.staging]: [
        ...commonRoles,
        "roles/artifactregistry.admin",
        "roles/certificatemanager.owner",
        "roles/compute.publicIpAdmin",
      ],
      [PROJECT_IDS.production]: [
        ...commonRoles,
        "roles/artifactregistry.admin",
        "roles/certificatemanager.owner",
        "roles/compute.publicIpAdmin",
      ],
    };
    for (const [projectId, roles] of Object.entries(expectedRoles)) {
      expect(
        foundationProjectMembers
          .filter((resource) => resource.inputs.project === projectId)
          .map((resource) => resource.inputs.role)
          .sort(),
      ).toEqual(roles.sort());
    }
    expect(foundationProjectMembers).toHaveLength(19);
    const projectIamAdminGrants = foundationProjectMembers.filter(
      (resource) =>
        resource.inputs.role === "roles/resourcemanager.projectIamAdmin",
    );
    expect(projectIamAdminGrants).toHaveLength(3);
    for (const grant of projectIamAdminGrants) {
      expect(grant.inputs.condition).toEqual(
        expectedFoundationProjectIamCondition,
      );
      expect(String(grant.inputs.condition)).not.toContain("roles/owner");
      expect(String(grant.inputs.condition)).not.toContain(
        "roles/resourcemanager.projectIamAdmin",
      );
    }
    expect(
      foundationProjectMembers.filter(
        (resource) =>
          resource.inputs.role !== "roles/resourcemanager.projectIamAdmin" &&
          resource.inputs.condition !== undefined,
      ),
    ).toEqual([]);

    const forbiddenRoles = new Set([
      "roles/owner",
      "roles/editor",
      "roles/iam.serviceAccountKeyAdmin",
      "roles/run.admin",
      "roles/compute.admin",
    ]);
    expect(
      foundationProjectMembers.filter((resource) =>
        forbiddenRoles.has(String(resource.inputs.role)),
      ),
    ).toEqual([]);
    expect(gcpResourcesWithoutExplicitProvider()).toEqual([]);
  });

  it("never grants project lifecycle or billing access to CI", async () => {
    await createFixture();

    expect(resourcesOfType("gcp:organizations/iAMMember:IAMMember")).toEqual(
      [],
    );
    expect(
      resourcesOfType("gcp:billing/accountIamMember:AccountIamMember"),
    ).toEqual([]);
    for (const type of [
      "gcp:projects/iAMMember:IAMMember",
      "gcp:serviceaccount/iAMMember:IAMMember",
      "gcp:artifactregistry/repositoryIamMember:RepositoryIamMember",
    ]) {
      for (const resource of resourcesOfType(type)) {
        expect(JSON.stringify(resource.inputs.condition ?? null)).not.toContain(
          "assertion.",
        );
      }
    }
  });
});
