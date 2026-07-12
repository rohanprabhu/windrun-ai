import * as gcp from "@pulumi/gcp";
import { describe, expect, it } from "vitest";

import { PROJECT_IDS, REGION } from "../src/constants";
import {
  createAppStack,
  type AppStackArgs,
} from "../src/stacks/app";
import {
  capturedCalls,
  capturedResources,
  gcpResourcesWithoutExplicitProvider,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

const commitSha = "a".repeat(40);

type AppKind = AppStackArgs["kind"];

const fixtures = {
  production: {
    stack: "production",
    projectId: PROJECT_IDS.production,
    serviceName: "production",
    repositoryId: "windrun",
    runtimeServiceAccountEmail:
      `production-runtime@${PROJECT_IDS.production}.iam.gserviceaccount.com`,
  },
  staging: {
    stack: "staging",
    projectId: PROJECT_IDS.staging,
    serviceName: "staging",
    repositoryId: "windrun",
    runtimeServiceAccountEmail:
      `staging-runtime@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
  },
  preview: {
    stack: "pr-42",
    projectId: PROJECT_IDS.staging,
    serviceName: "pr-42",
    repositoryId: "windrun",
    runtimeServiceAccountEmail:
      `staging-runtime@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
    sourceRoot: "/workspace/source",
  },
} as const;

async function createFixture(kind: AppKind) {
  const fixture = fixtures[kind];
  await setWindrunMocks(fixture.stack);
  const logicalProject = kind === "production" ? "production" : "staging";
  const provider = new gcp.Provider(`gcp-${logicalProject}`, {
    project: fixture.projectId,
    region: REGION,
  });
  const outputs = createAppStack({
    kind,
    projectId: fixture.projectId,
    provider,
    repositoryId: fixture.repositoryId,
    runtimeServiceAccountEmail: fixture.runtimeServiceAccountEmail,
    serviceName: fixture.serviceName,
    gitCommitSha: commitSha,
    sourceRoot: "sourceRoot" in fixture ? fixture.sourceRoot : undefined,
  });
  const resolved = await Promise.all([
    resolveOutput(outputs.publicUrl),
    resolveOutput(outputs.projectId),
    resolveOutput(outputs.serviceName),
    resolveOutput(outputs.imageDigest),
  ]);

  return { fixture, outputs, resolved };
}

describe("Cloud Run application stacks", () => {
  it("builds one immutable production image for linux/amd64", async () => {
    const { fixture, resolved } = await createFixture("production");

    const images = resourcesOfType("docker-build:index:Image");
    expect(images).toHaveLength(1);
    const image = images[0];
    const tag =
      `${REGION}-docker.pkg.dev/${fixture.projectId}/windrun/production:${commitSha}`;
    expect(image.inputs).toMatchObject({
      buildOnPreview: false,
      exec: false,
      context: { location: ".." },
      dockerfile: { location: "../windrun-ai/Dockerfile" },
      platforms: ["linux/amd64"],
      push: true,
      tags: [tag],
    });
    expect(image.retainOnDelete).toBe(true);
    expect(image.provider).toContain(
      mockUrn(
        "pulumi:providers:docker-build",
        "production-docker-build",
        "production",
      ),
    );

    const dockerProviders = resourcesOfType(
      "pulumi:providers:docker-build",
    );
    expect(dockerProviders).toHaveLength(1);
    expect(dockerProviders[0].inputs).toEqual({ host: "" });

    expect(image.inputs.registries).toBeUndefined();
    const exportedCheckpoint = {
      version: 3,
      deployment: {
        manifest: {},
        pending_operations: [],
        resources: capturedResources.map((resource) => ({
          urn: mockUrn(resource.type, resource.name, "production"),
          type: resource.type,
          custom: true,
          inputs: resource.inputs,
          outputs: resource.inputs,
        })),
      },
    };
    expect(JSON.stringify(exportedCheckpoint)).not.toContain(
      "mock-access-token",
    );

    expect(resolved).toEqual([
      "https://app.windrun.ai",
      fixture.projectId,
      "production",
      "sha256:mockdigest",
    ]);
  });

  it("deploys the digest-qualified image with the exact Cloud Run contract", async () => {
    const { fixture } = await createFixture("staging");

    const services = resourcesOfType("gcp:cloudrunv2/service:Service");
    expect(services).toHaveLength(1);
    const service = services[0];
    const tag =
      `${REGION}-docker.pkg.dev/${fixture.projectId}/windrun/staging:${commitSha}`;
    expect(service.inputs).toEqual({
      project: fixture.projectId,
      name: "staging",
      location: REGION,
      deletionProtection: false,
      ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      invokerIamDisabled: true,
      template: {
        serviceAccount: fixture.runtimeServiceAccountEmail,
        containers: [
          {
            image: `${tag}@sha256:mockdigest`,
            ports: { containerPort: 8080 },
            envs: [
              { name: "APP_ENVIRONMENT", value: "staging" },
              { name: "GCP_PROJECT_ID", value: fixture.projectId },
              { name: "GOOGLE_CLOUD_REGION", value: REGION },
              { name: "GIT_COMMIT_SHA", value: commitSha },
              { name: "PULUMI_STACK", value: "staging" },
              {
                name: "NEXT_PUBLIC_CANONICAL_HOST",
                value: "staging.app.windrun.ai",
              },
            ],
          },
        ],
      },
      traffics: [
        {
          type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
          percent: 100,
        },
      ],
    });
    expect(service.provider).toContain(
      mockUrn("pulumi:providers:gcp", "gcp-staging", "staging"),
    );
    expect(service.dependencies).toContain(
      mockUrn("docker-build:index:Image", "staging-image", "staging"),
    );
  });

  it("uses only trusted staging inputs and an explicit source root for previews", async () => {
    const { fixture, resolved } = await createFixture("preview");

    const image = resourcesOfType("docker-build:index:Image")[0];
    expect(image.inputs.context).toEqual({ location: "/workspace/source" });
    expect(image.inputs.dockerfile).toEqual({
      location: "/workspace/source/windrun-ai/Dockerfile",
    });
    expect(image.inputs.tags).toEqual([
      `${REGION}-docker.pkg.dev/${PROJECT_IDS.staging}/windrun/pr-42:${commitSha}`,
    ]);

    const service = resourcesOfType("gcp:cloudrunv2/service:Service")[0];
    expect(service.inputs).toMatchObject({
      project: PROJECT_IDS.staging,
      name: "pr-42",
      template: {
        serviceAccount: fixture.runtimeServiceAccountEmail,
        containers: [
          {
            envs: expect.arrayContaining([
              { name: "APP_ENVIRONMENT", value: "preview" },
              {
                name: "NEXT_PUBLIC_CANONICAL_HOST",
                value: "pr-42.staging.app.windrun.ai",
              },
            ]),
          },
        ],
      },
    });
    expect(service.provider).toContain(
      mockUrn("pulumi:providers:gcp", "gcp-staging", "pr-42"),
    );
    expect(resolved[0]).toBe("https://pr-42.staging.app.windrun.ai");
  });

  it("rejects untrusted source and service-name combinations", async () => {
    await setWindrunMocks("app-validation-test");
    const provider = new gcp.Provider("gcp-staging", {
      project: PROJECT_IDS.staging,
      region: REGION,
    });
    await resolveOutput(provider.urn);
    const base = {
      projectId: PROJECT_IDS.staging,
      provider,
      repositoryId: "windrun",
      runtimeServiceAccountEmail:
        `staging-runtime@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
      gitCommitSha: commitSha,
    } as const;

    expect(() =>
      createAppStack({
        ...base,
        kind: "preview",
        serviceName: "pr-42",
      }),
    ).toThrow("sourceRoot is required for preview");
    expect(() =>
      createAppStack({
        ...base,
        kind: "preview",
        serviceName: "pr-42",
        sourceRoot: "../source",
      }),
    ).toThrow("sourceRoot must be absolute");
    expect(() =>
      createAppStack({
        ...base,
        kind: "preview",
        serviceName: "staging",
        sourceRoot: "/workspace/source",
      }),
    ).toThrow("preview serviceName must match pr-<number>");
    expect(() =>
      createAppStack({
        ...base,
        kind: "staging",
        serviceName: "staging",
        sourceRoot: "/workspace/source",
      }),
    ).toThrow("sourceRoot is valid only for preview");
    expect(() =>
      createAppStack({
        ...base,
        kind: "staging",
        serviceName: "not-staging",
      }),
    ).toThrow("staging serviceName must be staging");
    expect(() =>
      createAppStack({
        ...base,
        kind: "staging",
        serviceName: "staging",
        gitCommitSha: "ABC",
      }),
    ).toThrow("gitCommitSha must be a lowercase 40-character Git SHA");
  });

  it("registers no IAM, edge, or credential-discovery operation", async () => {
    await createFixture("production");

    expect(
      capturedResources.map((resource) => resource.type).sort(),
    ).toEqual([
      "docker-build:index:Image",
      "gcp:cloudrunv2/service:Service",
      "pulumi:providers:docker-build",
      "pulumi:providers:gcp",
    ]);
    expect(gcpResourcesWithoutExplicitProvider()).toEqual([]);
    expect(capturedCalls).toEqual([]);
    expect(JSON.stringify(capturedResources)).not.toMatch(
      /oauth2accesstoken|mock-access-token/u,
    );
  });
});
