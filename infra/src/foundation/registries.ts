import * as gcp from "@pulumi/gcp";

import { REGION } from "../constants";
import type { ProjectBundle } from "./projects";
import { requireProjectService } from "./services";

export interface RegistryResources {
  productionRepository: gcp.artifactregistry.Repository;
  stagingRepository: gcp.artifactregistry.Repository;
}

function createRepository(
  logicalName: "production" | "staging",
  bundle: ProjectBundle,
) {
  return new gcp.artifactregistry.Repository(
    `${logicalName}-repository`,
    {
      project: bundle.project.projectId,
      location: REGION,
      repositoryId: "windrun",
      format: "DOCKER",
      mode: "STANDARD_REPOSITORY",
      description: `Windrun ${logicalName} Cloud Run images`,
      dockerConfig: { immutableTags: false },
    },
    {
      provider: bundle.provider,
      dependsOn: [
        requireProjectService(
          bundle.services,
          "artifactregistry.googleapis.com",
        ),
      ],
    },
  );
}

export function createRegistries(args: {
  staging: ProjectBundle;
  production: ProjectBundle;
}): RegistryResources {
  return {
    productionRepository: createRepository("production", args.production),
    stagingRepository: createRepository("staging", args.staging),
  };
}
