import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { REGION } from "./constants";

export interface ProjectProviders {
  shared: gcp.Provider;
  staging: gcp.Provider;
  production: gcp.Provider;
}

export type ProjectLogicalName = "shared" | "staging" | "production";

export function createBootstrapProvider() {
  return new gcp.Provider("gcp-bootstrap", {});
}

export function createProjectProvider(
  logicalName: ProjectLogicalName,
  projectId: pulumi.Input<string>,
) {
  return new gcp.Provider(`gcp-${logicalName}`, {
    project: projectId,
    region: REGION,
  });
}

export function createProjectProviders(projectIds: {
  shared: pulumi.Input<string>;
  staging: pulumi.Input<string>;
  production: pulumi.Input<string>;
}): ProjectProviders {
  return {
    shared: createProjectProvider("shared", projectIds.shared),
    staging: createProjectProvider("staging", projectIds.staging),
    production: createProjectProvider("production", projectIds.production),
  };
}
