import path from "node:path";

import * as pulumi from "@pulumi/pulumi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HOSTNAMES, PROJECT_IDS, REGION } from "../src/constants";
import {
  capturedResources,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

const organization = "mock-org";
const commitSha = "b".repeat(40);
const repositoryRoot = path.resolve(__dirname, "..", "..");
const githubToken = "dispatcher-test-github-token";
const pulumiAccessToken = "dispatcher-test-pulumi-token";

function wifProvider(
  projectNumber: string,
  kind:
    | "foundation"
    | "production"
    | "production-edge"
    | "staging"
    | "staging-edge"
    | "preview",
) {
  return (
    `projects/${projectNumber}/locations/global/workloadIdentityPools/` +
    `github-${kind}/providers/github`
  );
}

const foundationOutputFixture = {
  sharedProjectId: PROJECT_IDS.shared,
  stagingProjectId: PROJECT_IDS.staging,
  productionProjectId: PROJECT_IDS.production,
  stagingRepositoryId: "staging-images",
  productionRepositoryId: "production-images",
  stagingRuntimeServiceAccountEmail:
    `staging-runtime@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
  productionRuntimeServiceAccountEmail:
    `production-runtime@${PROJECT_IDS.production}.iam.gserviceaccount.com`,
  stagingGlobalIp: "203.0.113.20",
  productionGlobalIp: "203.0.113.10",
  apexNameServers: [
    "ns-cloud-a1.googledomains.com.",
    "ns-cloud-a2.googledomains.com.",
    "ns-cloud-a3.googledomains.com.",
    "ns-cloud-a4.googledomains.com.",
  ],
  stagingCertificateMapId:
    `projects/${PROJECT_IDS.staging}/locations/global/certificateMaps/windrun-staging`,
  productionCertificateMapId:
    `projects/${PROJECT_IDS.production}/locations/global/certificateMaps/windrun-production`,
  stagingCertificateStatus: "ACTIVE",
  productionCertificateStatus: "ACTIVE",
  foundationWifProvider: wifProvider("100000000001", "foundation"),
  foundationDeployServiceAccount:
    `foundation-deploy@${PROJECT_IDS.shared}.iam.gserviceaccount.com`,
  productionWifProvider: wifProvider("100000000003", "production"),
  productionDeployServiceAccount:
    `production-deploy@${PROJECT_IDS.production}.iam.gserviceaccount.com`,
  stagingWifProvider: wifProvider("100000000002", "staging"),
  stagingDeployServiceAccount:
    `staging-deploy@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
  previewWifProvider: wifProvider("100000000002", "preview"),
  previewDeployServiceAccount:
    `preview-deploy@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
  productionEdgeWifProvider: wifProvider(
    "100000000003",
    "production-edge",
  ),
  productionEdgeDeployServiceAccount:
    `production-edge-deploy@${PROJECT_IDS.production}.iam.gserviceaccount.com`,
  stagingEdgeWifProvider: wifProvider("100000000002", "staging-edge"),
  stagingEdgeDeployServiceAccount:
    `staging-edge-deploy@${PROJECT_IDS.staging}.iam.gserviceaccount.com`,
} as const;

type ProgramOutputs = Record<string, pulumi.Output<string>>;

async function loadProgramRunner() {
  const imported = await import("../src/index");
  const run = (imported as { default?: unknown }).default ?? imported;
  if (typeof run !== "function") {
    throw new Error("Pulumi program must export a stack function");
  }
  return run as () => ProgramOutputs;
}

async function resolveProgramOutputs(outputs: ProgramOutputs) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(outputs).map(async ([name, output]) => [
        name,
        await resolveOutput(output),
      ]),
    ),
  ) as Record<string, string>;
}

async function runProgram(args: {
  stack: string;
  config: Record<string, string>;
  foundationOutputs?: Record<string, unknown>;
  sourceRoot?: string;
  githubToken?: string;
  pulumiAccessToken?: string;
}) {
  await setWindrunMocks(args.stack, {
    organization,
    stackReferenceOutputs:
      args.foundationOutputs ?? foundationOutputFixture,
  });
  pulumi.runtime.setAllConfig(args.config, []);
  vi.resetModules();

  const previousSourceRoot = process.env.WINDRUN_APP_SOURCE;
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousPulumiAccessToken = process.env.PULUMI_ACCESS_TOKEN;
  if (args.sourceRoot === undefined) {
    delete process.env.WINDRUN_APP_SOURCE;
  } else {
    process.env.WINDRUN_APP_SOURCE = args.sourceRoot;
  }
  if (args.githubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = args.githubToken;
  }
  if (args.pulumiAccessToken === undefined) {
    delete process.env.PULUMI_ACCESS_TOKEN;
  } else {
    process.env.PULUMI_ACCESS_TOKEN = args.pulumiAccessToken;
  }

  let outputs!: ProgramOutputs;
  try {
    await pulumi.runtime.runInPulumiStack(async () => {
      const run = await loadProgramRunner();
      outputs = run();
      return outputs;
    });
    const resolved = await resolveProgramOutputs(outputs);
    const secrets = Object.fromEntries(
      await Promise.all(
        Object.entries(outputs).map(async ([name, output]) => [
          name,
          await pulumi.isSecret(output),
        ]),
      ),
    ) as Record<string, boolean>;
    return { outputs, resolved, secrets };
  } finally {
    if (previousSourceRoot === undefined) {
      delete process.env.WINDRUN_APP_SOURCE;
    } else {
      process.env.WINDRUN_APP_SOURCE = previousSourceRoot;
    }
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
    if (previousPulumiAccessToken === undefined) {
      delete process.env.PULUMI_ACCESS_TOKEN;
    } else {
      process.env.PULUMI_ACCESS_TOKEN = previousPulumiAccessToken;
    }
    await pulumi.runtime.disconnect().catch(() => undefined);
  }
}

async function expectDeliveryCredentialError(args: {
  enablePulumiGithubOidc: boolean;
  githubToken?: string;
  pulumiAccessToken?: string;
  message: string;
}) {
  await setWindrunMocks("delivery", {
    organization,
    stackReferenceOutputs: foundationOutputFixture,
  });
  pulumi.runtime.setAllConfig(
    {
      "windrun-ai:stackKind": "delivery",
      "windrun-ai:enablePulumiGithubOidc": String(
        args.enablePulumiGithubOidc,
      ),
      "windrun-ai:pulumiOrganization": "windrun-pulumi-user",
    },
    [],
  );
  vi.resetModules();

  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousPulumiAccessToken = process.env.PULUMI_ACCESS_TOKEN;
  if (args.githubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = args.githubToken;
  }
  if (args.pulumiAccessToken === undefined) {
    delete process.env.PULUMI_ACCESS_TOKEN;
  } else {
    process.env.PULUMI_ACCESS_TOKEN = args.pulumiAccessToken;
  }

  try {
    const run = await loadProgramRunner();
    expect(() => run()).toThrow(args.message);
  } finally {
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
    if (previousPulumiAccessToken === undefined) {
      delete process.env.PULUMI_ACCESS_TOKEN;
    } else {
      process.env.PULUMI_ACCESS_TOKEN = previousPulumiAccessToken;
    }
    await pulumi.runtime.disconnect().catch(() => undefined);
  }
}

afterEach(() => {
  delete process.env.WINDRUN_APP_SOURCE;
  delete process.env.GITHUB_TOKEN;
  delete process.env.PULUMI_ACCESS_TOKEN;
});

describe("Pulumi stack dispatcher", () => {
  it.each([
    ["omitted", undefined, true, "PREVENT"],
    ["false", false, true, "PREVENT"],
    ["true", true, false, "DELETE"],
  ] as const)(
    "protects foundation resources when allowProjectDeletion is %s",
    async (_label, allowProjectDeletion, expectedProtect, deletionPolicy) => {
      const config: Record<string, string> = {
        "windrun-ai:stackKind": "foundation",
      };
      if (allowProjectDeletion !== undefined) {
        config["windrun-ai:allowProjectDeletion"] = String(
          allowProjectDeletion,
        );
      }

      const { resolved } = await runProgram({
        stack: "foundation",
        config,
      });

      const descendants = capturedResources.filter(
        (resource) => resource.type !== "pulumi:pulumi:Stack",
      );
      expect(descendants.length).toBeGreaterThan(70);
      expect(
        descendants.filter(
          (resource) => resource.protect !== expectedProtect,
        ),
      ).toEqual([]);
      expect(
        resourcesOfType("gcp:organizations/project:Project").map(
          (resource) => resource.inputs.deletionPolicy,
        ),
      ).toEqual([deletionPolicy, deletionPolicy, deletionPolicy]);
      expect(
        resourcesOfType("pulumi:pulumi:StackReference"),
      ).toEqual([]);
      assertFoundationResourceBoundary();
    },
  );

  it("exports the exact typed foundation boundary without credentials", async () => {
    const { resolved, secrets } = await runProgram({
      stack: "foundation",
      config: {
        "windrun-ai:stackKind": "foundation",
        "windrun-ai:allowProjectDeletion": "false",
      },
    });

    expect(Object.keys(resolved).sort()).toEqual(
      Object.keys(foundationOutputFixture).sort(),
    );
    expect(resolved).toMatchObject({
      sharedProjectId: PROJECT_IDS.shared,
      stagingProjectId: PROJECT_IDS.staging,
      productionProjectId: PROJECT_IDS.production,
      stagingRepositoryId: "windrun",
      productionRepositoryId: "windrun",
      stagingGlobalIp: "203.0.113.20",
      productionGlobalIp: "203.0.113.10",
      stagingCertificateStatus: "ACTIVE",
      productionCertificateStatus: "ACTIVE",
      foundationWifProvider: wifProvider("100000000001", "foundation"),
      productionWifProvider: wifProvider("100000000003", "production"),
      stagingWifProvider: wifProvider("100000000002", "staging"),
      previewWifProvider: wifProvider("100000000002", "preview"),
      productionEdgeWifProvider: wifProvider(
        "100000000003",
        "production-edge",
      ),
      stagingEdgeWifProvider: wifProvider(
        "100000000002",
        "staging-edge",
      ),
    });
    expect(
      Object.keys(resolved).filter((key) =>
        /token|credential|secret/i.test(key),
      ),
    ).toEqual([]);
    expect(Object.values(secrets)).toEqual(
      Array(Object.keys(foundationOutputFixture).length).fill(false),
    );
  });

  it("dispatches delivery after loading foundation outputs and keeps credentials environment-only", async () => {
    const { resolved } = await runProgram({
      stack: "delivery",
      config: {
        "windrun-ai:stackKind": "delivery",
        "windrun-ai:enablePulumiGithubOidc": "true",
        "windrun-ai:pulumiOrganization": "windrun-pulumi-user",
      },
      githubToken,
      pulumiAccessToken,
    });

    expect(resolved).toEqual({ ciEnabled: true });
    const stackReferenceIndex = capturedResources.findIndex(
      (resource) => resource.type === "pulumi:pulumi:StackReference",
    );
    const githubProviderIndex = capturedResources.findIndex(
      (resource) => resource.type === "pulumi:providers:github",
    );
    expect(stackReferenceIndex).toBeGreaterThanOrEqual(0);
    expect(githubProviderIndex).toBeGreaterThan(stackReferenceIndex);
    expect(resourcesOfType("pulumi:providers:github")[0].inputs).toEqual({
      owner: "rohanprabhu",
      baseUrl: "https://api.github.com/",
    });
    expect(
      resourcesOfType("pulumi:providers:pulumiservice")[0].inputs,
    ).toEqual({ apiUrl: "https://api.pulumi.com" });
    expect(JSON.stringify(capturedResources)).not.toContain(githubToken);
    expect(JSON.stringify(capturedResources)).not.toContain(
      pulumiAccessToken,
    );
    expect(
      capturedResources.filter(
        (resource) => resource.type.startsWith("gcp:"),
      ),
    ).toEqual([]);
  });

  it("requires GITHUB_TOKEN before registering delivery resources", async () => {
    await expectDeliveryCredentialError({
      enablePulumiGithubOidc: false,
      message: "GITHUB_TOKEN is required for the delivery stack",
    });

    expect(capturedResources).toEqual([]);
  });

  it("requires PULUMI_ACCESS_TOKEN only when Pulumi GitHub OIDC is enabled", async () => {
    await expectDeliveryCredentialError({
      enablePulumiGithubOidc: true,
      githubToken,
      message:
        "PULUMI_ACCESS_TOKEN is required when Pulumi GitHub OIDC is enabled",
    });

    expect(capturedResources).toEqual([]);

    const { resolved } = await runProgram({
      stack: "delivery",
      config: {
        "windrun-ai:stackKind": "delivery",
        "windrun-ai:enablePulumiGithubOidc": "false",
        "windrun-ai:pulumiOrganization": "windrun-pulumi-user",
      },
      githubToken,
    });
    expect(resolved).toEqual({ ciEnabled: false });
    expect(resourcesOfType("pulumi:providers:pulumiservice")).toEqual([]);
    expect(resourcesOfType("pulumiservice:index:OidcIssuer")).toEqual([]);
  });

  it.each([
    {
      stack: "production",
      kind: "production",
      projectId: PROJECT_IDS.production,
      providerName: "gcp-production",
      serviceName: "production",
      publicUrl: `https://${HOSTNAMES.production}`,
      context: repositoryRoot,
    },
    {
      stack: "staging",
      kind: "staging",
      projectId: PROJECT_IDS.staging,
      providerName: "gcp-staging",
      serviceName: "staging",
      publicUrl: `https://${HOSTNAMES.staging}`,
      context: repositoryRoot,
    },
    {
      stack: "pr-1",
      kind: "preview",
      projectId: PROJECT_IDS.staging,
      providerName: "gcp-staging",
      serviceName: "pr-1",
      publicUrl: `https://pr-1.${HOSTNAMES.previewSuffix}`,
      context: "/workspace/source",
    },
  ] as const)(
    "dispatches $stack to its isolated Cloud Run project",
    async (fixture) => {
      const config: Record<string, string> = {
        "windrun-ai:stackKind": fixture.kind,
        "windrun-ai:gitCommitSha": commitSha,
      };
      if (fixture.kind === "preview") {
        config["windrun-ai:pullRequestNumber"] = "1";
      }
      const { resolved } = await runProgram({
        stack: fixture.stack,
        config,
        sourceRoot:
          fixture.kind === "preview" ? fixture.context : undefined,
      });

      expect(resolved).toEqual({
        publicUrl: fixture.publicUrl,
        projectId: fixture.projectId,
        serviceName: fixture.serviceName,
        imageDigest: "sha256:mockdigest",
      });
      const reference = resourcesOfType("pulumi:pulumi:StackReference");
      expect(reference).toHaveLength(1);
      expect(reference[0].inputs.name).toBe(
        `${organization}/windrun-ai/foundation`,
      );
      const provider = resourcesOfType("pulumi:providers:gcp");
      expect(provider).toHaveLength(1);
      expect(provider[0].name).toBe(fixture.providerName);
      expect(provider[0].inputs.project).toBe(fixture.projectId);

      const image = resourcesOfType("docker-build:index:Image")[0];
      expect(image.inputs.context).toEqual({ location: fixture.context });
      expect(image.inputs.tags).toEqual([
        `${REGION}-docker.pkg.dev/${fixture.projectId}/${
          fixture.kind === "production"
            ? foundationOutputFixture.productionRepositoryId
            : foundationOutputFixture.stagingRepositoryId
        }/${fixture.serviceName}:${commitSha}`,
      ]);
      const service = resourcesOfType(
        "gcp:cloudrunv2/service:Service",
      )[0];
      expect(service.inputs).toMatchObject({
        project: fixture.projectId,
        name: fixture.serviceName,
        invokerIamDisabled: true,
        template: {
          serviceAccount:
            fixture.kind === "production"
              ? foundationOutputFixture.productionRuntimeServiceAccountEmail
              : foundationOutputFixture.stagingRuntimeServiceAccountEmail,
        },
      });
      expect(service.provider).toBe(
        `${mockUrn(
          "pulumi:pulumi:Stack$pulumi:providers:gcp",
          fixture.providerName,
          fixture.stack,
        )}::${fixture.providerName}-id`,
      );
      expect(JSON.stringify(resolved)).not.toContain("/workspace/source");
      expect(JSON.stringify(service.inputs.template)).not.toContain(
        "/workspace/source",
      );
      expect(
        capturedResources.map((resource) => resource.type).sort(),
      ).toEqual(
        [
          "pulumi:pulumi:Stack",
          "pulumi:pulumi:StackReference",
          "pulumi:providers:gcp",
          "pulumi:providers:docker-build",
          "docker-build:index:Image",
          "gcp:cloudrunv2/service:Service",
        ].sort(),
      );
    },
  );

  it("requires an explicit trusted source root only for previews", async () => {
    await setWindrunMocks("pr-1", {
      organization,
      stackReferenceOutputs: foundationOutputFixture,
    });
    pulumi.runtime.setAllConfig(
      {
        "windrun-ai:stackKind": "preview",
        "windrun-ai:gitCommitSha": commitSha,
        "windrun-ai:pullRequestNumber": "1",
      },
      [],
    );
    vi.resetModules();
    const previewRun = await loadProgramRunner();
    expect(() => previewRun()).toThrow("sourceRoot is required for preview");
    await pulumi.runtime.disconnect();

    const { resolved } = await runProgram({
      stack: "production",
      config: {
        "windrun-ai:stackKind": "production",
        "windrun-ai:gitCommitSha": commitSha,
      },
      sourceRoot: "/ignored/static/source",
    });
    expect(resolved.publicUrl).toBe(`https://${HOSTNAMES.production}`);
    expect(resourcesOfType("docker-build:index:Image")[0].inputs.context).toEqual(
      { location: repositoryRoot },
    );
  });

  it.each([
    {
      stack: "production-edge",
      projectId: PROJECT_IDS.production,
      providerName: "gcp-production",
      address: foundationOutputFixture.productionGlobalIp,
      certificateMapId:
        foundationOutputFixture.productionCertificateMapId,
      certificateStatus:
        foundationOutputFixture.productionCertificateStatus,
      publicUrl: `https://${HOSTNAMES.production}`,
    },
    {
      stack: "staging-edge",
      projectId: PROJECT_IDS.staging,
      providerName: "gcp-staging",
      address: foundationOutputFixture.stagingGlobalIp,
      certificateMapId: foundationOutputFixture.stagingCertificateMapId,
      certificateStatus: foundationOutputFixture.stagingCertificateStatus,
      publicUrl: `https://${HOSTNAMES.staging}`,
    },
  ] as const)("dispatches $stack without mutating foundation", async (fixture) => {
    const { resolved } = await runProgram({
      stack: fixture.stack,
      config: { "windrun-ai:stackKind": fixture.stack },
    });

    expect(resolved).toEqual({
      publicUrl: fixture.publicUrl,
      globalIp: fixture.address,
      certificateStatus: fixture.certificateStatus,
    });
    expect(resourcesOfType("pulumi:pulumi:StackReference")).toHaveLength(1);
    expect(resourcesOfType("pulumi:providers:gcp")).toHaveLength(1);
    expect(resourcesOfType("pulumi:providers:gcp")[0].inputs.project).toBe(
      fixture.projectId,
    );
    const httpsProxy = resourcesOfType(
      "gcp:compute/targetHttpsProxy:TargetHttpsProxy",
    )[0];
    expect(httpsProxy.inputs.certificateMap).toBe(
      `//certificatemanager.googleapis.com/${fixture.certificateMapId}`,
    );
    for (const rule of resourcesOfType(
      "gcp:compute/globalForwardingRule:GlobalForwardingRule",
    )) {
      expect(rule.inputs.ipAddress).toBe(fixture.address);
    }
    expect(
      capturedResources.filter(
        (resource) =>
          resource.type === "docker-build:index:Image" ||
          resource.type.startsWith("gcp:cloudrun"),
      ),
    ).toEqual([]);
    const expectedTypes = [
      "pulumi:pulumi:Stack",
      "pulumi:pulumi:StackReference",
      "pulumi:providers:gcp",
      "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
      "gcp:compute/backendService:BackendService",
      "gcp:compute/uRLMap:URLMap",
      "gcp:compute/uRLMap:URLMap",
      "gcp:compute/targetHttpsProxy:TargetHttpsProxy",
      "gcp:compute/targetHttpProxy:TargetHttpProxy",
      "gcp:compute/globalForwardingRule:GlobalForwardingRule",
      "gcp:compute/globalForwardingRule:GlobalForwardingRule",
    ];
    if (fixture.stack === "staging-edge") {
      expectedTypes.push(
        "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
        "gcp:compute/backendService:BackendService",
      );
    }
    expect(
      capturedResources.map((resource) => resource.type).sort(),
    ).toEqual(expectedTypes.sort());
  });

  it("fails closed when a required typed foundation output is absent", async () => {
    const incomplete = { ...foundationOutputFixture } as Record<
      string,
      unknown
    >;
    delete incomplete.productionRepositoryId;
    await setWindrunMocks("typed-output-test", {
      organization,
      stackReferenceOutputs: incomplete,
    });

    const { getFoundationOutputs } = await import(
      "../src/foundation-outputs"
    );
    const output = getFoundationOutputs()
      .productionRepositoryId as pulumi.Output<string> & {
      promise(withUnknowns?: boolean): Promise<string>;
      allResources(): Promise<Set<pulumi.Resource>>;
      isKnown: Promise<boolean>;
      isSecret: Promise<boolean>;
    };
    const settled = await Promise.allSettled([
      output.promise(),
      output.isKnown,
      output.isSecret,
      output.allResources(),
    ]);
    expect(
      settled
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => String(result.reason)),
    ).toEqual(
      Array(4).fill(
        "Error: Required output 'productionRepositoryId' does not exist on stack 'mock-org/windrun-ai/foundation'.",
      ),
    );
    await pulumi.runtime.disconnect().catch(() => undefined);
  });
});

function assertFoundationResourceBoundary() {
  const allowedTypes = new Set([
    "pulumi:pulumi:Stack",
    "pulumi:providers:gcp",
    "gcp:organizations/project:Project",
    "gcp:projects/service:Service",
    "gcp:artifactregistry/repository:Repository",
    "gcp:compute/globalAddress:GlobalAddress",
    "gcp:serviceaccount/account:Account",
    "gcp:dns/managedZone:ManagedZone",
    "gcp:dns/recordSet:RecordSet",
    "gcp:certificatemanager/dnsAuthorization:DnsAuthorization",
    "gcp:certificatemanager/certificate:Certificate",
    "gcp:certificatemanager/certificateMap:CertificateMap",
    "gcp:certificatemanager/certificateMapEntry:CertificateMapEntry",
    "gcp:iam/workloadIdentityPool:WorkloadIdentityPool",
    "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider",
    "gcp:serviceaccount/iAMMember:IAMMember",
    "gcp:projects/iAMMember:IAMMember",
    "gcp:artifactregistry/repositoryIamMember:RepositoryIamMember",
  ]);
  expect(
    capturedResources.filter((resource) => !allowedTypes.has(resource.type)),
  ).toEqual([]);
  expect(
    capturedResources.filter(
      (resource) =>
        resource.type.startsWith("gcp:") && !resource.provider,
    ),
  ).toEqual([]);
}
