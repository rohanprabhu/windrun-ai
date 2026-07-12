import * as pulumi from "@pulumi/pulumi";
import type {
  MockCallArgs,
  MockResourceArgs,
} from "@pulumi/pulumi/runtime/mocks";
import { MockMonitor } from "@pulumi/pulumi/runtime/mocks";

export const MOCK_NAME_SERVERS = [
  "ns-cloud-a1.googledomains.com.",
  "ns-cloud-a2.googledomains.com.",
  "ns-cloud-a3.googledomains.com.",
  "ns-cloud-a4.googledomains.com.",
] as const;

export const MOCK_PRODUCTION_IP = "203.0.113.10";
export const MOCK_STAGING_IP = "203.0.113.20";

export interface CapturedResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
  provider?: string;
  dependencies: string[];
}

export const capturedResources: CapturedResource[] = [];
export const capturedCalls: Array<{
  token: string;
  inputs: Record<string, unknown>;
  provider?: string;
}> = [];

let activeStack = "test";
let activeDigitalOceanRecords: Array<{
  type: string;
  value: string;
  tag?: string;
}> = [];
const pendingDependencies = new Map<string, string[]>();
const patchKey = Symbol.for("windrun-ai:pulumi-mock-dependencies");

type PatchedMockMonitor = typeof MockMonitor.prototype & {
  [patchKey]?: true;
};

const monitorPrototype = MockMonitor.prototype as PatchedMockMonitor;
if (!monitorPrototype[patchKey]) {
  const originalRegisterResource = monitorPrototype.registerResource;
  monitorPrototype.registerResource = function registerResourceWithDependencies(
    this: MockMonitor,
    request: {
      getType(): string;
      getName(): string;
      getDependenciesList?(): string[];
    },
    callback: Parameters<typeof originalRegisterResource>[1],
  ) {
    pendingDependencies.set(
      `${request.getType()}::${request.getName()}`,
      request.getDependenciesList?.() ?? [],
    );
    return originalRegisterResource.call(this, request, callback);
  } as typeof originalRegisterResource;
  monitorPrototype[patchKey] = true;
}

function projectNumber(name: string) {
  if (name.includes("shared")) return "100000000001";
  if (name.includes("staging")) return "100000000002";
  return "100000000003";
}

function resourceState(args: MockResourceArgs) {
  const state: Record<string, unknown> = { ...args.inputs };

  switch (args.type) {
    case "gcp:organizations/project:Project":
      return { ...state, number: projectNumber(args.name) };
    case "gcp:serviceaccount/account:Account": {
      const project = String(state.project);
      const accountId = String(state.accountId);
      const email = `${accountId}@${project}.iam.gserviceaccount.com`;
      return {
        ...state,
        email,
        member: `serviceAccount:${email}`,
        name: `projects/${project}/serviceAccounts/${email}`,
      };
    }
    case "gcp:artifactregistry/repository:Repository":
      return {
        ...state,
        name: `projects/${String(state.project)}/locations/${String(state.location)}/repositories/${String(state.repositoryId)}`,
      };
    case "gcp:iam/workloadIdentityPool:WorkloadIdentityPool":
      return {
        ...state,
        name: `projects/${projectNumber(String(state.project))}/locations/global/workloadIdentityPools/${String(state.workloadIdentityPoolId)}`,
      };
    case "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider":
      return {
        ...state,
        name: `projects/${projectNumber(String(state.project))}/locations/global/workloadIdentityPools/${String(state.workloadIdentityPoolId)}/providers/${String(state.workloadIdentityPoolProviderId)}`,
      };
    case "gcp:dns/managedZone:ManagedZone":
      return { ...state, nameServers: [...MOCK_NAME_SERVERS] };
    case "gcp:certificatemanager/dnsAuthorization:DnsAuthorization":
      return {
        ...state,
        dnsResourceRecords: [
          {
            name: `_acme-challenge.${args.name}.app.windrun.ai.`,
            type: "CNAME",
            data: `${args.name}.authorize.certificatemanager.goog.`,
          },
        ],
      };
    case "gcp:certificatemanager/certificate:Certificate":
      return {
        ...state,
        managed: {
          ...(state.managed as Record<string, unknown>),
          state: "ACTIVE",
        },
      };
    case "gcp:compute/globalAddress:GlobalAddress":
      return {
        ...state,
        address: args.name.includes("production")
          ? MOCK_PRODUCTION_IP
          : MOCK_STAGING_IP,
      };
    case "docker-build:index:Image":
      return {
        ...state,
        ref: "asia-south1-docker.pkg.dev/mock/app/image@sha256:mockdigest",
        digest: "sha256:mockdigest",
      };
    case "gcp:cloudrunv2/service:Service":
      return {
        ...state,
        uri: `https://${args.name}-mock.a.run.app`,
        latestReadyRevision: `${args.name}-00001-mock`,
      };
    default:
      return state;
  }
}

function callResult(args: MockCallArgs) {
  switch (args.token) {
    case "gcp:organizations/getClientConfig:getClientConfig":
      return {
        accessToken: "mock-access-token",
        project: "mock-project",
        region: "asia-south1",
      };
    case "digitalocean:index/getRecords:getRecords":
      return { records: activeDigitalOceanRecords };
    default:
      return args.inputs;
  }
}

export async function setWindrunMocks(
  stack = "test",
  options: {
    digitalOceanRecords?: Array<{
      type: string;
      value: string;
      tag?: string;
    }>;
  } = {},
) {
  activeStack = stack;
  activeDigitalOceanRecords = options.digitalOceanRecords ?? [];
  capturedResources.length = 0;
  capturedCalls.length = 0;
  pendingDependencies.clear();

  await pulumi.runtime.setMocks(
    {
      newResource(args) {
        const key = `${args.type}::${args.name}`;
        capturedResources.push({
          type: args.type,
          name: args.name,
          inputs: args.inputs,
          provider: args.provider || undefined,
          dependencies: pendingDependencies.get(key) ?? [],
        });
        pendingDependencies.delete(key);

        return {
          id: args.custom ? `${args.name}-id` : undefined,
          state: resourceState(args),
        };
      },
      call(args) {
        capturedCalls.push({
          token: args.token,
          inputs: args.inputs,
          provider: args.provider || undefined,
        });
        return callResult(args);
      },
    },
    "windrun-ai",
    stack,
    false,
  );
}

export function resourcesOfType(type: string) {
  return capturedResources.filter((resource) => resource.type === type);
}

export function gcpResourcesWithoutExplicitProvider() {
  return capturedResources.filter(
    (resource) =>
      resource.type.startsWith("gcp:") &&
      resource.type !== "gcp:organizations/project:Project" &&
      !resource.provider,
  );
}

export function mockUrn(type: string, name: string, stack = activeStack) {
  return `urn:pulumi:${stack}::windrun-ai::${type}::${name}`;
}

export function resolveOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return (
    output as pulumi.Output<T> & { promise(withUnknowns?: boolean): Promise<T> }
  ).promise();
}
