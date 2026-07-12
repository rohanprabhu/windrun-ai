import * as gcp from "@pulumi/gcp";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createBootstrapProvider,
  createProjectProviders,
} from "../src/providers";
import { REGION } from "../src/constants";
import {
  gcpResourcesWithoutExplicitProvider,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

beforeAll(async () => {
  await setWindrunMocks("providers-test");
});

describe("explicit GCP providers", () => {
  it("creates one projectless bootstrap provider and three project providers", async () => {
    const bootstrap = createBootstrapProvider();
    const providers = createProjectProviders({
      shared: "windrun-ai-shared-20260712",
      staging: "windrun-ai-staging-20260712",
      production: "windrun-ai-prod-20260712",
    });

    await Promise.all([
      resolveOutput(bootstrap.urn),
      resolveOutput(providers.shared.urn),
      resolveOutput(providers.staging.urn),
      resolveOutput(providers.production.urn),
    ]);

    const providerResources = resourcesOfType("pulumi:providers:gcp");
    expect(providerResources).toHaveLength(4);

    const bootstrapResource = providerResources.find(
      (resource) => resource.name === "gcp-bootstrap",
    );
    expect(bootstrapResource).toBeDefined();
    expect(bootstrapResource?.inputs).not.toHaveProperty("project");

    expect(
      providerResources.find((resource) => resource.name === "gcp-shared")
        ?.inputs,
    ).toMatchObject({
      project: "windrun-ai-shared-20260712",
      region: REGION,
    });
    expect(
      providerResources.find((resource) => resource.name === "gcp-staging")
        ?.inputs,
    ).toMatchObject({
      project: "windrun-ai-staging-20260712",
      region: REGION,
    });
    expect(
      providerResources.find((resource) => resource.name === "gcp-production")
        ?.inputs,
    ).toMatchObject({
      project: "windrun-ai-prod-20260712",
      region: REGION,
    });

    const sampleService = new gcp.projects.Service(
      "provider-invariant",
      {
        project: "windrun-ai-staging-20260712",
        service: "run.googleapis.com",
        disableOnDestroy: false,
      },
      { provider: providers.staging },
    );
    await resolveOutput(sampleService.urn);

    const dependentService = new gcp.projects.Service(
      "dependency-invariant",
      {
        project: "windrun-ai-staging-20260712",
        service: "compute.googleapis.com",
        disableOnDestroy: false,
      },
      { provider: providers.staging, dependsOn: [sampleService] },
    );
    await resolveOutput(dependentService.urn);

    expect(
      resourcesOfType("gcp:projects/service:Service").find(
        (resource) => resource.name === "dependency-invariant",
      )?.dependencies,
    ).toContain(
      mockUrn(
        "gcp:projects/service:Service",
        "provider-invariant",
        "providers-test",
      ),
    );

    expect(gcpResourcesWithoutExplicitProvider()).toEqual([]);
  });
});
