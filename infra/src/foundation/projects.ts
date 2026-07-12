import * as gcp from "@pulumi/gcp";

import { BILLING_ACCOUNT, ORGANIZATION_ID } from "../constants";
import {
  createProjectProvider,
  type ProjectLogicalName,
} from "../providers";
import { createProjectServices } from "./services";

export interface ProjectBundle {
  project: gcp.organizations.Project;
  provider: gcp.Provider;
  services: Record<string, gcp.projects.Service>;
}

export function createProjectBundle(args: {
  logicalName: ProjectLogicalName;
  projectId: string;
  bootstrapProvider: gcp.Provider;
  allowProjectDeletion: boolean;
  services: readonly string[];
}): ProjectBundle {
  const project = new gcp.organizations.Project(
    `${args.logicalName}-project`,
    {
      projectId: args.projectId,
      name: `Windrun AI ${args.logicalName}`,
      orgId: ORGANIZATION_ID,
      billingAccount: BILLING_ACCOUNT,
      autoCreateNetwork: false,
      deletionPolicy: args.allowProjectDeletion ? "DELETE" : "PREVENT",
    },
    { provider: args.bootstrapProvider },
  );

  const provider = createProjectProvider(args.logicalName, project.projectId);
  const services = createProjectServices({
    logicalName: args.logicalName,
    project,
    provider,
    services: args.services,
  });

  return { project, provider, services };
}
