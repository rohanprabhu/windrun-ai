import * as gcp from "@pulumi/gcp";
import { describe, expect, it } from "vitest";

import { HOSTNAMES, PROJECT_IDS, REGION } from "../src/constants";
import {
  createEdgeStack,
  type EdgeStackArgs,
} from "../src/stacks/edge";
import {
  capturedCalls,
  capturedResources,
  gcpResourcesWithoutExplicitProvider,
  mockUrn,
  resolveOutput,
  resourcesOfType,
  setWindrunMocks,
} from "./helpers/pulumi-mocks";

type EdgeKind = EdgeStackArgs["kind"];

const fixtures = {
  "production-edge": {
    projectId: PROJECT_IDS.production,
    providerName: "gcp-production",
    address: "203.0.113.10",
    certificateMapId:
      `projects/${PROJECT_IDS.production}/locations/global/certificateMaps/windrun-production`,
    publicUrl: `https://${HOSTNAMES.production}`,
  },
  "staging-edge": {
    projectId: PROJECT_IDS.staging,
    providerName: "gcp-staging",
    address: "203.0.113.20",
    certificateMapId:
      `projects/${PROJECT_IDS.staging}/locations/global/certificateMaps/windrun-staging`,
    publicUrl: `https://${HOSTNAMES.staging}`,
  },
} as const;

async function createFixture(kind: EdgeKind) {
  const fixture = fixtures[kind];
  await setWindrunMocks(kind);
  const provider = new gcp.Provider(fixture.providerName, {
    project: fixture.projectId,
    region: REGION,
  });
  const outputs = createEdgeStack({
    kind,
    projectId: fixture.projectId,
    provider,
    globalAddress: fixture.address,
    certificateMapId: fixture.certificateMapId,
  });
  const publicUrl = await resolveOutput(outputs.publicUrl);

  return { fixture, publicUrl };
}

describe("stable Cloud Run edge stacks", () => {
  it("creates a production-only global external managed load balancer", async () => {
    const { fixture, publicUrl } = await createFixture("production-edge");
    expect(publicUrl).toBe(fixture.publicUrl);

    const negs = resourcesOfType(
      "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
    );
    expect(negs).toHaveLength(1);
    expect(negs[0].inputs).toEqual({
      project: fixture.projectId,
      name: "windrun-production-primary",
      region: REGION,
      networkEndpointType: "SERVERLESS",
      cloudRun: { service: "production" },
    });

    const backends = resourcesOfType(
      "gcp:compute/backendService:BackendService",
    );
    expect(backends).toHaveLength(1);
    expect(backends[0].inputs).toEqual({
      project: fixture.projectId,
      name: "windrun-production-primary",
      protocol: "HTTP",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      backends: [{ group: "production-primary-neg-id" }],
    });

    const urlMaps = resourcesOfType("gcp:compute/uRLMap:URLMap");
    expect(urlMaps).toHaveLength(2);
    expect(
      urlMaps.find((resource) => resource.name === "production-https-url-map")
        ?.inputs,
    ).toEqual({
      project: fixture.projectId,
      name: "windrun-production-https",
      defaultService: "production-primary-backend-id",
    });
    expect(
      urlMaps.find(
        (resource) => resource.name === "production-http-redirect-url-map",
      )?.inputs,
    ).toEqual({
      project: fixture.projectId,
      name: "windrun-production-http-redirect",
      defaultUrlRedirect: { httpsRedirect: true, stripQuery: false },
    });

    assertFrontends(
      "production",
      fixture.projectId,
      fixture.address,
      fixture.certificateMapId,
    );
    assertDependencyGraph("production", false);
  });

  it("shares one staging load balancer across staging and dynamic previews", async () => {
    const { fixture, publicUrl } = await createFixture("staging-edge");
    expect(publicUrl).toBe(fixture.publicUrl);

    const negs = resourcesOfType(
      "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
    );
    expect(negs).toHaveLength(2);
    expect(
      negs.find((resource) => resource.name === "staging-primary-neg")?.inputs,
    ).toEqual({
      project: fixture.projectId,
      name: "windrun-staging-primary",
      region: REGION,
      networkEndpointType: "SERVERLESS",
      cloudRun: { service: "staging" },
    });
    expect(
      negs.find((resource) => resource.name === "staging-preview-neg")?.inputs,
    ).toEqual({
      project: fixture.projectId,
      name: "windrun-staging-preview",
      region: REGION,
      networkEndpointType: "SERVERLESS",
      cloudRun: { urlMask: "<service>.staging.app.windrun.ai" },
    });
    expect(
      negs.filter(
        (resource) =>
          (resource.inputs.cloudRun as { urlMask?: string }).urlMask !==
          undefined,
      ),
    ).toHaveLength(1);

    const backends = resourcesOfType(
      "gcp:compute/backendService:BackendService",
    );
    expect(backends).toHaveLength(2);
    expect(
      backends.find(
        (resource) => resource.name === "staging-primary-backend",
      )?.inputs,
    ).toEqual({
      project: fixture.projectId,
      name: "windrun-staging-primary",
      protocol: "HTTP",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      backends: [{ group: "staging-primary-neg-id" }],
    });
    expect(
      backends.find(
        (resource) => resource.name === "staging-preview-backend",
      )?.inputs,
    ).toEqual({
      project: fixture.projectId,
      name: "windrun-staging-preview",
      protocol: "HTTP",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      backends: [{ group: "staging-preview-neg-id" }],
    });

    const httpsMap = resourcesOfType("gcp:compute/uRLMap:URLMap").find(
      (resource) => resource.name === "staging-https-url-map",
    );
    expect(httpsMap?.inputs).toEqual({
      project: fixture.projectId,
      name: "windrun-staging-https",
      defaultService: "staging-primary-backend-id",
      hostRules: [
        {
          hosts: [HOSTNAMES.staging],
          pathMatcher: "staging-primary",
        },
        {
          hosts: [`*.${HOSTNAMES.staging}`],
          pathMatcher: "staging-previews",
        },
      ],
      pathMatchers: [
        {
          name: "staging-primary",
          defaultService: "staging-primary-backend-id",
        },
        {
          name: "staging-previews",
          defaultService: "staging-preview-backend-id",
        },
      ],
    });

    assertFrontends(
      "staging",
      fixture.projectId,
      fixture.address,
      fixture.certificateMapId,
    );
    assertDependencyGraph("staging", true);
  });

  it.each(["production-edge", "staging-edge"] as const)(
    "%s uses only its exact provider and edge resource multiset",
    async (kind) => {
      const { fixture } = await createFixture(kind);

      const expectedTypes = [
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
      if (kind === "staging-edge") {
        expectedTypes.push(
          "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
          "gcp:compute/backendService:BackendService",
        );
      }
      expect(
        capturedResources.map((resource) => resource.type).sort(),
      ).toEqual(expectedTypes.sort());
      expect(capturedCalls).toEqual([]);
      expect(
        capturedResources.filter((resource) => resource.type.includes("health")),
      ).toEqual([]);
      expect(gcpResourcesWithoutExplicitProvider()).toEqual([]);

      const expectedProvider = `${mockUrn(
        "pulumi:providers:gcp",
        fixture.providerName,
        kind,
      )}::${fixture.providerName}-id`;
      for (const resource of capturedResources.filter((candidate) =>
        candidate.type.startsWith("gcp:"),
      )) {
        expect(resource.provider).toBe(expectedProvider);
      }
    },
  );
});

function assertFrontends(
  logicalName: "production" | "staging",
  projectId: string,
  address: string,
  certificateMapId: string,
) {
  const redirectMap = resourcesOfType("gcp:compute/uRLMap:URLMap").find(
    (resource) =>
      resource.name === `${logicalName}-http-redirect-url-map`,
  );
  expect(redirectMap?.inputs).toEqual({
    project: projectId,
    name: `windrun-${logicalName}-http-redirect`,
    defaultUrlRedirect: { httpsRedirect: true, stripQuery: false },
  });

  const httpsProxy = resourcesOfType(
    "gcp:compute/targetHttpsProxy:TargetHttpsProxy",
  )[0];
  expect(httpsProxy.inputs).toEqual({
    project: projectId,
    name: `windrun-${logicalName}-https`,
    urlMap: `${logicalName}-https-url-map-id`,
    certificateMap: `//certificatemanager.googleapis.com/${certificateMapId}`,
  });

  const httpProxy = resourcesOfType(
    "gcp:compute/targetHttpProxy:TargetHttpProxy",
  )[0];
  expect(httpProxy.inputs).toEqual({
    project: projectId,
    name: `windrun-${logicalName}-http`,
    urlMap: `${logicalName}-http-redirect-url-map-id`,
  });

  const rules = resourcesOfType(
    "gcp:compute/globalForwardingRule:GlobalForwardingRule",
  );
  expect(rules).toHaveLength(2);
  expect(
    rules.find(
      (resource) => resource.name === `${logicalName}-http-forwarding-rule`,
    )?.inputs,
  ).toEqual({
    project: projectId,
    name: `windrun-${logicalName}-http`,
    ipAddress: address,
    ipProtocol: "TCP",
    portRange: "80",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    networkTier: "PREMIUM",
    target: `${logicalName}-http-proxy-id`,
  });
  expect(
    rules.find(
      (resource) => resource.name === `${logicalName}-https-forwarding-rule`,
    )?.inputs,
  ).toEqual({
    project: projectId,
    name: `windrun-${logicalName}-https`,
    ipAddress: address,
    ipProtocol: "TCP",
    portRange: "443",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    networkTier: "PREMIUM",
    target: `${logicalName}-https-proxy-id`,
  });
}

function assertDependencyGraph(
  logicalName: "production" | "staging",
  includePreview: boolean,
) {
  const stack = `${logicalName}-edge`;
  const dependency = (type: string, name: string) =>
    mockUrn(type, name, stack);
  const expectDependencies = (
    type: string,
    name: string,
    expected: string[],
  ) => {
    const resource = capturedResources.find(
      (candidate) => candidate.type === type && candidate.name === name,
    );
    expect(resource, `${type}::${name}`).toBeDefined();
    expect([...(resource?.dependencies ?? [])].sort()).toEqual(
      [...expected].sort(),
    );
  };

  expectDependencies(
    "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
    `${logicalName}-primary-neg`,
    [],
  );
  expectDependencies(
    "gcp:compute/backendService:BackendService",
    `${logicalName}-primary-backend`,
    [
      dependency(
        "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
        `${logicalName}-primary-neg`,
      ),
    ],
  );

  const httpsMapDependencies = [
    dependency(
      "gcp:compute/backendService:BackendService",
      `${logicalName}-primary-backend`,
    ),
  ];
  if (includePreview) {
    expectDependencies(
      "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
      "staging-preview-neg",
      [],
    );
    expectDependencies(
      "gcp:compute/backendService:BackendService",
      "staging-preview-backend",
      [
        dependency(
          "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup",
          "staging-preview-neg",
        ),
      ],
    );
    httpsMapDependencies.push(
      dependency(
        "gcp:compute/backendService:BackendService",
        "staging-preview-backend",
      ),
    );
  }

  expectDependencies(
    "gcp:compute/uRLMap:URLMap",
    `${logicalName}-https-url-map`,
    httpsMapDependencies,
  );
  expectDependencies(
    "gcp:compute/uRLMap:URLMap",
    `${logicalName}-http-redirect-url-map`,
    [],
  );
  expectDependencies(
    "gcp:compute/targetHttpsProxy:TargetHttpsProxy",
    `${logicalName}-https-proxy`,
    [
      dependency(
        "gcp:compute/uRLMap:URLMap",
        `${logicalName}-https-url-map`,
      ),
    ],
  );
  expectDependencies(
    "gcp:compute/targetHttpProxy:TargetHttpProxy",
    `${logicalName}-http-proxy`,
    [
      dependency(
        "gcp:compute/uRLMap:URLMap",
        `${logicalName}-http-redirect-url-map`,
      ),
    ],
  );
  expectDependencies(
    "gcp:compute/globalForwardingRule:GlobalForwardingRule",
    `${logicalName}-https-forwarding-rule`,
    [
      dependency(
        "gcp:compute/targetHttpsProxy:TargetHttpsProxy",
        `${logicalName}-https-proxy`,
      ),
    ],
  );
  expectDependencies(
    "gcp:compute/globalForwardingRule:GlobalForwardingRule",
    `${logicalName}-http-forwarding-rule`,
    [
      dependency(
        "gcp:compute/targetHttpProxy:TargetHttpProxy",
        `${logicalName}-http-proxy`,
      ),
    ],
  );
}
