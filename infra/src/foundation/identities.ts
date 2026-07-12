import * as gcp from "@pulumi/gcp";

import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export type DeploymentServiceAccountKind =
  | "foundation"
  | "production"
  | "production-edge"
  | "staging"
  | "staging-edge"
  | "preview";

export interface RuntimeIdentityResources {
  productionRuntimeServiceAccount: gcp.serviceaccount.Account;
  stagingRuntimeServiceAccount: gcp.serviceaccount.Account;
}

function createRuntimeServiceAccount(
  logicalName: "production" | "staging",
  bundle: ProjectBundle,
) {
  return new gcp.serviceaccount.Account(
    `${logicalName}-runtime`,
    {
      project: bundle.project.projectId,
      accountId: `${logicalName}-runtime`,
      displayName: `Windrun ${logicalName} Cloud Run runtime`,
      description: `Permissionless runtime identity for Windrun ${logicalName}`,
    },
    {
      provider: bundle.provider,
      dependsOn: [requireProjectService(bundle.services, "iam.googleapis.com")],
    },
  );
}

export function createRuntimeIdentities(args: {
  staging: ProjectBundle;
  production: ProjectBundle;
}): RuntimeIdentityResources {
  return {
    productionRuntimeServiceAccount: createRuntimeServiceAccount(
      "production",
      args.production,
    ),
    stagingRuntimeServiceAccount: createRuntimeServiceAccount(
      "staging",
      args.staging,
    ),
  };
}

export function createDeploymentServiceAccount(
  kind: DeploymentServiceAccountKind,
  bundle: ProjectBundle,
) {
  return new gcp.serviceaccount.Account(
    `${kind}-deploy`,
    {
      project: bundle.project.projectId,
      accountId: `${kind}-deploy`,
      displayName: `Windrun ${kind} deployment`,
      description: `Keyless GitHub deployment identity for Windrun ${kind}`,
    },
    {
      provider: bundle.provider,
      dependsOn: [requireProjectService(bundle.services, "iam.googleapis.com")],
    },
  );
}
