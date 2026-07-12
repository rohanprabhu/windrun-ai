import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import {
  GITHUB_OWNER_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  REGION,
} from "../constants";
import {
  createDeploymentServiceAccount,
  type DeploymentServiceAccountKind,
} from "./identities";
import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export type DeploymentIdentityKind = DeploymentServiceAccountKind;

export interface FederatedIdentity {
  serviceAccount: gcp.serviceaccount.Account;
  pool: gcp.iam.WorkloadIdentityPool;
  provider: gcp.iam.WorkloadIdentityPoolProvider;
}

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

const GITHUB_WORKFLOW_PREFIX =
  `${GITHUB_REPOSITORY}/.github/workflows/` as const;
const PREVIEW_REF_PATTERN = "^refs/pull/[1-9][0-9]*/merge$";
const PREVIEW_CALLER_PATTERN =
  `^${GITHUB_REPOSITORY}/[.]github/workflows/` +
  "pull-request[.]yml@refs/pull/[1-9][0-9]*/merge$";
const PREVIEW_CALLER_MAIN =
  `${GITHUB_WORKFLOW_PREFIX}pull-request.yml@refs/heads/main` as const;
const PREVIEW_DEPLOY_WORKFLOW =
  `${GITHUB_WORKFLOW_PREFIX}_preview-deploy.yml@refs/heads/main` as const;
const PREVIEW_DESTROY_WORKFLOW =
  `${GITHUB_WORKFLOW_PREFIX}_preview-destroy.yml@refs/heads/main` as const;

interface TrustPolicy {
  environment: DeploymentIdentityKind;
  eventName: "push" | "pull_request" | "workflow_dispatch";
  ref?: string;
  workflowRef?: string;
}

const TRUST_POLICIES = {
  foundation: {
    environment: "foundation",
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    workflowRef: `${GITHUB_WORKFLOW_PREFIX}manage-foundation.yml@refs/heads/main`,
  },
  production: {
    environment: "production",
    eventName: "push",
    ref: "refs/heads/main",
    workflowRef: `${GITHUB_WORKFLOW_PREFIX}deploy-production.yml@refs/heads/main`,
  },
  "production-edge": {
    environment: "production-edge",
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    workflowRef: `${GITHUB_WORKFLOW_PREFIX}manage-edge.yml@refs/heads/main`,
  },
  staging: {
    environment: "staging",
    eventName: "push",
    ref: "refs/heads/staging",
    workflowRef: `${GITHUB_WORKFLOW_PREFIX}deploy-staging.yml@refs/heads/staging`,
  },
  "staging-edge": {
    environment: "staging-edge",
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    workflowRef: `${GITHUB_WORKFLOW_PREFIX}manage-edge.yml@refs/heads/main`,
  },
  preview: {
    environment: "preview",
    eventName: "pull_request",
  },
} as const satisfies Record<DeploymentIdentityKind, TrustPolicy>;

function previewWorkflowCondition() {
  const deploy = [
    `assertion.job_workflow_ref == '${PREVIEW_DEPLOY_WORKFLOW}'`,
    `assertion.ref.matches('${PREVIEW_REF_PATTERN}')`,
    `assertion.workflow_ref.matches('${PREVIEW_CALLER_PATTERN}')`,
  ].join(" && ");
  const destroy = [
    `assertion.job_workflow_ref == '${PREVIEW_DESTROY_WORKFLOW}'`,
    `((assertion.ref.matches('${PREVIEW_REF_PATTERN}') && assertion.workflow_ref.matches('${PREVIEW_CALLER_PATTERN}')) || ` +
      `(assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '${PREVIEW_CALLER_MAIN}'))`,
  ].join(" && ");

  return `((${deploy}) || (${destroy}))`;
}

function githubAttributeCondition(kind: DeploymentIdentityKind) {
  const policy: TrustPolicy = TRUST_POLICIES[kind];
  const clauses = [
    `assertion.repository_id == '${GITHUB_REPOSITORY_ID}'`,
    `assertion.repository_owner_id == '${GITHUB_OWNER_ID}'`,
    `assertion.repository == '${GITHUB_REPOSITORY}'`,
    `assertion.environment == '${policy.environment}'`,
    `assertion.event_name == '${policy.eventName}'`,
  ];

  if (kind === "preview") {
    clauses.push("assertion.base_ref == 'main'");
    clauses.push(previewWorkflowCondition());
    return clauses.join(" && ");
  }

  if (policy.ref) {
    clauses.push(`assertion.ref == '${policy.ref}'`);
  }
  if (policy.workflowRef) {
    clauses.push(`assertion.workflow_ref == '${policy.workflowRef}'`);
  }
  return clauses.join(" && ");
}

function createFederatedIdentity(
  kind: DeploymentIdentityKind,
  bundle: ProjectBundle,
) {
  const iamApi = requireProjectService(bundle.services, "iam.googleapis.com");
  const serviceAccount = createDeploymentServiceAccount(kind, bundle);
  const pool = new gcp.iam.WorkloadIdentityPool(
    `${kind}-github-pool`,
    {
      project: bundle.project.projectId,
      workloadIdentityPoolId: `github-${kind}`,
      mode: "FEDERATION_ONLY",
      displayName: `Windrun ${kind} GitHub`,
      description: `GitHub Actions trust boundary for Windrun ${kind}`,
      disabled: false,
      deletionPolicy: "DELETE",
    },
    { provider: bundle.provider, dependsOn: [iamApi] },
  );
  const provider = new gcp.iam.WorkloadIdentityPoolProvider(
    `${kind}-github-provider`,
    {
      project: bundle.project.projectId,
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: "github",
      displayName: `Windrun ${kind} GitHub`,
      description: `Restricted GitHub OIDC provider for Windrun ${kind}`,
      disabled: false,
      deletionPolicy: "DELETE",
      attributeMapping:
        kind === "preview"
          ? {
              ...GITHUB_ATTRIBUTE_MAPPING,
              "attribute.job_workflow_ref": "assertion.job_workflow_ref",
            }
          : GITHUB_ATTRIBUTE_MAPPING,
      attributeCondition: githubAttributeCondition(kind),
      oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
    },
    { provider: bundle.provider, dependsOn: [pool, iamApi] },
  );
  const workloadIdentityUser = new gcp.serviceaccount.IAMMember(
    `${kind}-github-wif-user`,
    {
      serviceAccountId: serviceAccount.name,
      role: "roles/iam.workloadIdentityUser",
      member: pulumi.interpolate`principalSet://iam.googleapis.com/projects/${bundle.project.number}/locations/global/workloadIdentityPools/${pool.workloadIdentityPoolId}/attribute.repository_id/${GITHUB_REPOSITORY_ID}`,
    },
    {
      provider: bundle.provider,
      dependsOn: [serviceAccount, provider],
    },
  );

  return {
    identity: { serviceAccount, pool, provider } satisfies FederatedIdentity,
    workloadIdentityUser,
  };
}

function projectGrant(args: {
  name: string;
  bundle: ProjectBundle;
  role: string;
  member: pulumi.Input<string>;
  condition?: gcp.projects.IAMMemberArgs["condition"];
}) {
  return new gcp.projects.IAMMember(
    args.name,
    {
      project: args.bundle.project.projectId,
      role: args.role,
      member: args.member,
      condition: args.condition,
    },
    {
      provider: args.bundle.provider,
      dependsOn: [
        requireProjectService(
          args.bundle.services,
          "cloudresourcemanager.googleapis.com",
        ),
      ],
    },
  );
}

function createApplicationGrants(args: {
  kind: "production" | "staging" | "preview";
  identity: FederatedIdentity;
  bundle: ProjectBundle;
  repository: gcp.artifactregistry.Repository;
  runtimeServiceAccount: gcp.serviceaccount.Account;
}) {
  const runAdmin = projectGrant({
    name: `${args.kind}-cloud-run-admin`,
    bundle: args.bundle,
    role: "roles/run.admin",
    member: args.identity.serviceAccount.member,
  });
  const artifactWriter = new gcp.artifactregistry.RepositoryIamMember(
    `${args.kind}-artifact-writer`,
    {
      project: args.bundle.project.projectId,
      location: REGION,
      repository: args.repository.repositoryId,
      role: "roles/artifactregistry.writer",
      member: args.identity.serviceAccount.member,
    },
    {
      provider: args.bundle.provider,
      dependsOn: [args.identity.serviceAccount, args.repository],
    },
  );
  const runtimeUser = new gcp.serviceaccount.IAMMember(
    `${args.kind}-runtime-user`,
    {
      serviceAccountId: args.runtimeServiceAccount.name,
      role: "roles/iam.serviceAccountUser",
      member: args.identity.serviceAccount.member,
    },
    {
      provider: args.bundle.provider,
      dependsOn: [
        args.identity.serviceAccount,
        args.runtimeServiceAccount,
      ],
    },
  );

  return [runAdmin, artifactWriter, runtimeUser] as const;
}

function createEdgeGrants(args: {
  kind: "production-edge" | "staging-edge";
  identity: FederatedIdentity;
  bundle: ProjectBundle;
}) {
  return [
    projectGrant({
      name: `${args.kind}-load-balancer-admin`,
      bundle: args.bundle,
      role: "roles/compute.loadBalancerAdmin",
      member: args.identity.serviceAccount.member,
    }),
    projectGrant({
      name: `${args.kind}-certificate-viewer`,
      bundle: args.bundle,
      role: "roles/certificatemanager.viewer",
      member: args.identity.serviceAccount.member,
    }),
  ] as const;
}

const FOUNDATION_COMMON_PROJECT_ROLES = [
  "roles/serviceusage.serviceUsageAdmin",
  "roles/iam.workloadIdentityPoolAdmin",
  "roles/iam.serviceAccountAdmin",
  "roles/resourcemanager.projectIamAdmin",
] as const;

const FOUNDATION_MANAGED_PROJECT_ROLES = [
  "roles/artifactregistry.admin",
  "roles/certificatemanager.owner",
  "roles/certificatemanager.viewer",
  "roles/compute.loadBalancerAdmin",
  "roles/compute.publicIpAdmin",
  "roles/dns.admin",
  "roles/iam.serviceAccountAdmin",
  "roles/iam.workloadIdentityPoolAdmin",
  "roles/run.admin",
  "roles/serviceusage.serviceUsageAdmin",
] as const;

export const FOUNDATION_PROJECT_IAM_CONDITION = {
  title: "foundation_managed_roles_only",
  description:
    "Limits foundation CI to the exact project roles managed by this Pulumi stack",
  expression:
    "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([" +
    FOUNDATION_MANAGED_PROJECT_ROLES.map((role) => `'${role}'`).join(", ") +
    "])",
} as const;

function roleName(role: string) {
  return role.slice("roles/".length).replace(/[^a-zA-Z0-9]+/g, "-");
}

function createFoundationProjectGrants(args: {
  identity: FederatedIdentity;
  shared: ProjectBundle;
  staging: ProjectBundle;
  production: ProjectBundle;
}) {
  const roleMatrix = [
    [
      "shared",
      args.shared,
      [...FOUNDATION_COMMON_PROJECT_ROLES, "roles/dns.admin"],
    ],
    [
      "staging",
      args.staging,
      [
        ...FOUNDATION_COMMON_PROJECT_ROLES,
        "roles/artifactregistry.admin",
        "roles/certificatemanager.owner",
        "roles/compute.publicIpAdmin",
      ],
    ],
    [
      "production",
      args.production,
      [
        ...FOUNDATION_COMMON_PROJECT_ROLES,
        "roles/artifactregistry.admin",
        "roles/certificatemanager.owner",
        "roles/compute.publicIpAdmin",
      ],
    ],
  ] as const;

  return roleMatrix.flatMap(([logicalProject, bundle, roles]) =>
    roles.map((role) =>
      projectGrant({
        name: `foundation-${logicalProject}-${roleName(role)}`,
        bundle,
        role,
        member: args.identity.serviceAccount.member,
        condition:
          role === "roles/resourcemanager.projectIamAdmin"
            ? FOUNDATION_PROJECT_IAM_CONDITION
            : undefined,
      }),
    ),
  );
}

export interface GitHubDeploymentIdentityResources {
  identities: Record<DeploymentIdentityKind, FederatedIdentity>;
  grants: pulumi.CustomResource[];
}

export function createGitHubDeploymentIdentities(args: {
  shared: ProjectBundle;
  staging: ProjectBundle;
  production: ProjectBundle;
  productionRepository: gcp.artifactregistry.Repository;
  stagingRepository: gcp.artifactregistry.Repository;
  productionRuntimeServiceAccount: gcp.serviceaccount.Account;
  stagingRuntimeServiceAccount: gcp.serviceaccount.Account;
}): GitHubDeploymentIdentityResources {
  const bundles = {
    foundation: args.shared,
    production: args.production,
    "production-edge": args.production,
    staging: args.staging,
    "staging-edge": args.staging,
    preview: args.staging,
  } as const satisfies Record<DeploymentIdentityKind, ProjectBundle>;

  const federated = Object.fromEntries(
    (Object.keys(bundles) as DeploymentIdentityKind[]).map((kind) => [
      kind,
      createFederatedIdentity(kind, bundles[kind]),
    ]),
  ) as Record<
    DeploymentIdentityKind,
    ReturnType<typeof createFederatedIdentity>
  >;
  const identities = Object.fromEntries(
    (Object.keys(federated) as DeploymentIdentityKind[]).map((kind) => [
      kind,
      federated[kind].identity,
    ]),
  ) as Record<DeploymentIdentityKind, FederatedIdentity>;

  const grants: pulumi.CustomResource[] = (
    Object.values(federated) as Array<
      ReturnType<typeof createFederatedIdentity>
    >
  ).map(({ workloadIdentityUser }) => workloadIdentityUser);
  grants.push(
    ...createApplicationGrants({
      kind: "production",
      identity: identities.production,
      bundle: args.production,
      repository: args.productionRepository,
      runtimeServiceAccount: args.productionRuntimeServiceAccount,
    }),
    ...createApplicationGrants({
      kind: "staging",
      identity: identities.staging,
      bundle: args.staging,
      repository: args.stagingRepository,
      runtimeServiceAccount: args.stagingRuntimeServiceAccount,
    }),
    ...createApplicationGrants({
      kind: "preview",
      identity: identities.preview,
      bundle: args.staging,
      repository: args.stagingRepository,
      runtimeServiceAccount: args.stagingRuntimeServiceAccount,
    }),
    ...createEdgeGrants({
      kind: "production-edge",
      identity: identities["production-edge"],
      bundle: args.production,
    }),
    ...createEdgeGrants({
      kind: "staging-edge",
      identity: identities["staging-edge"],
      bundle: args.staging,
    }),
    ...createFoundationProjectGrants({
      identity: identities.foundation,
      shared: args.shared,
      staging: args.staging,
      production: args.production,
    }),
  );

  return { identities, grants };
}
