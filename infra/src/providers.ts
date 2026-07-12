import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { REGION } from "./constants";

export interface ProjectProviders {
  shared: gcp.Provider;
  staging: gcp.Provider;
  production: gcp.Provider;
}

export function createBootstrapProvider() {
  return new gcp.Provider("gcp-bootstrap", {});
}

export function createProjectProviders(projectIds: {
  shared: pulumi.Input<string>;
  staging: pulumi.Input<string>;
  production: pulumi.Input<string>;
}): ProjectProviders {
  return {
    shared: new gcp.Provider("gcp-shared", {
      project: projectIds.shared,
      region: REGION,
    }),
    staging: new gcp.Provider("gcp-staging", {
      project: projectIds.staging,
      region: REGION,
    }),
    production: new gcp.Provider("gcp-production", {
      project: projectIds.production,
      region: REGION,
    }),
  };
}
