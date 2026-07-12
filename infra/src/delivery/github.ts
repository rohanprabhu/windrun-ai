import * as github from "@pulumi/github";
import * as pulumi from "@pulumi/pulumi";

import {
  GITHUB_OWNER_ID,
  GITHUB_REPOSITORY,
} from "../constants";
import type { FoundationOutputs } from "../foundation-outputs";

export const DELIVERY_ENVIRONMENTS = [
  "foundation",
  "production",
  "production-edge",
  "staging",
  "staging-edge",
  "preview",
] as const;

export type DeliveryEnvironment = (typeof DELIVERY_ENVIRONMENTS)[number];

const privilegedEnvironments = new Set<DeliveryEnvironment>([
  "foundation",
  "production-edge",
  "staging-edge",
]);

const [githubOwner, githubRepository] = GITHUB_REPOSITORY.split("/");

if (!githubOwner || !githubRepository) {
  throw new Error("GITHUB_REPOSITORY must be owner/repository");
}

interface DeploymentPolicySpec {
  logicalName: string;
  environment: DeliveryEnvironment;
  branchPattern: string;
}

const deploymentPolicySpecs: DeploymentPolicySpec[] = [
  {
    logicalName: "foundation-main-policy",
    environment: "foundation",
    branchPattern: "main",
  },
  {
    logicalName: "production-main-policy",
    environment: "production",
    branchPattern: "main",
  },
  {
    logicalName: "production-edge-main-policy",
    environment: "production-edge",
    branchPattern: "main",
  },
  {
    logicalName: "staging-staging-policy",
    environment: "staging",
    branchPattern: "staging",
  },
  {
    logicalName: "staging-edge-main-policy",
    environment: "staging-edge",
    branchPattern: "main",
  },
  {
    logicalName: "preview-pull-request-policy",
    environment: "preview",
    branchPattern: "refs/pull/*/merge",
  },
  {
    logicalName: "preview-main-policy",
    environment: "preview",
    branchPattern: "main",
  },
];

export interface GitHubDeliveryResources {
  provider: github.Provider;
  environments: github.RepositoryEnvironment[];
  deploymentPolicies: github.RepositoryEnvironmentDeploymentPolicy[];
  variables: github.ActionsVariable[];
}

export function createGitHubDeliveryResources(args: {
  pulumiOrganization: string;
  foundation: FoundationOutputs;
  productionCiEnabled: boolean;
  stagingCiEnabled: boolean;
}): GitHubDeliveryResources {
  const provider = new github.Provider("github-windrun", {
    owner: githubOwner,
    baseUrl: "https://api.github.com/",
  });
  const environmentByName = Object.fromEntries(
    DELIVERY_ENVIRONMENTS.map((environment) => {
      const privileged = privilegedEnvironments.has(environment);
      const resource = new github.RepositoryEnvironment(
        `${environment}-environment`,
        {
          repository: githubRepository,
          environment,
          canAdminsBypass: false,
          preventSelfReview: false,
          deploymentBranchPolicy: {
            protectedBranches: false,
            customBranchPolicies: true,
          },
          reviewers: privileged
            ? [{ users: [Number(GITHUB_OWNER_ID)] }]
            : undefined,
        },
        { provider },
      );
      return [environment, resource];
    }),
  ) as Record<DeliveryEnvironment, github.RepositoryEnvironment>;
  const deploymentPolicies = deploymentPolicySpecs.map(
    ({ logicalName, environment, branchPattern }) =>
      new github.RepositoryEnvironmentDeploymentPolicy(
        logicalName,
        {
          repository: githubRepository,
          environment: environmentByName[environment].environment,
          branchPattern,
        },
        {
          provider,
          dependsOn: [environmentByName[environment]],
        },
      ),
  );

  const values: Record<string, pulumi.Input<string>> = {
    PULUMI_ORGANIZATION: args.pulumiOrganization,
    GCP_WIF_PROVIDER_PRODUCTION: args.foundation.productionWifProvider,
    GCP_SERVICE_ACCOUNT_PRODUCTION:
      args.foundation.productionDeployServiceAccount,
    GCP_WIF_PROVIDER_STAGING: args.foundation.stagingWifProvider,
    GCP_SERVICE_ACCOUNT_STAGING:
      args.foundation.stagingDeployServiceAccount,
    GCP_WIF_PROVIDER_PREVIEW: args.foundation.previewWifProvider,
    GCP_SERVICE_ACCOUNT_PREVIEW:
      args.foundation.previewDeployServiceAccount,
    GCP_WIF_PROVIDER_PRODUCTION_EDGE:
      args.foundation.productionEdgeWifProvider,
    GCP_SERVICE_ACCOUNT_PRODUCTION_EDGE:
      args.foundation.productionEdgeDeployServiceAccount,
    GCP_WIF_PROVIDER_STAGING_EDGE:
      args.foundation.stagingEdgeWifProvider,
    GCP_SERVICE_ACCOUNT_STAGING_EDGE:
      args.foundation.stagingEdgeDeployServiceAccount,
    GCP_WIF_PROVIDER_FOUNDATION: args.foundation.foundationWifProvider,
    GCP_SERVICE_ACCOUNT_FOUNDATION:
      args.foundation.foundationDeployServiceAccount,
    PULUMI_PRODUCTION_ENABLED: String(args.productionCiEnabled),
    PULUMI_STAGING_ENABLED: String(args.stagingCiEnabled),
  };
  const variables = Object.entries(values).map(
    ([variableName, value]) =>
      new github.ActionsVariable(
        `variable-${variableName.toLowerCase().replaceAll("_", "-")}`,
        {
          repository: githubRepository,
          variableName,
          value,
        },
        { provider },
      ),
  );

  return {
    provider,
    environments: Object.values(environmentByName),
    deploymentPolicies,
    variables,
  };
}

export function createCiEnabledGate(args: {
  provider: github.Provider;
  enabled: boolean;
  dependsOn: pulumi.Resource[];
}) {
  return new github.ActionsVariable(
    "variable-pulumi-ci-enabled",
    {
      repository: githubRepository,
      variableName: "PULUMI_CI_ENABLED",
      value: String(args.enabled),
    },
    { provider: args.provider, dependsOn: args.dependsOn },
  );
}
