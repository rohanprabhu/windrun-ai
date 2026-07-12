import * as gcp from "@pulumi/gcp";

import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export interface AddressResources {
  productionAddress: gcp.compute.GlobalAddress;
  stagingAddress: gcp.compute.GlobalAddress;
}

function createAddress(
  logicalName: "production" | "staging",
  bundle: ProjectBundle,
) {
  return new gcp.compute.GlobalAddress(
    `${logicalName}-address`,
    {
      project: bundle.project.projectId,
      name: `windrun-${logicalName}-ip`,
      addressType: "EXTERNAL",
      ipVersion: "IPV4",
      description: `Windrun ${logicalName} global load-balancer address`,
    },
    {
      provider: bundle.provider,
      dependsOn: [
        requireProjectService(bundle.services, "compute.googleapis.com"),
      ],
    },
  );
}

export function createAddresses(args: {
  staging: ProjectBundle;
  production: ProjectBundle;
}): AddressResources {
  return {
    productionAddress: createAddress("production", args.production),
    stagingAddress: createAddress("staging", args.staging),
  };
}
