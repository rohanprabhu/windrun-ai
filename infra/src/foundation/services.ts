import * as gcp from "@pulumi/gcp";

export const SHARED_APIS = [
  "cloudbilling.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "dns.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "serviceusage.googleapis.com",
  "sts.googleapis.com",
] as const;

export const WORKLOAD_APIS = [
  "artifactregistry.googleapis.com",
  "certificatemanager.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "compute.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "run.googleapis.com",
  "serviceusage.googleapis.com",
  "sts.googleapis.com",
] as const;

function apiLogicalName(api: string) {
  return api.replace(/\.googleapis\.com$/, "").replace(/[^a-z0-9]+/g, "-");
}

export function createProjectServices(args: {
  logicalName: "shared" | "staging" | "production";
  project: gcp.organizations.Project;
  provider: gcp.Provider;
  services: readonly string[];
}) {
  const resources: Record<string, gcp.projects.Service> = {};
  const serviceUsageApi = args.services.includes("serviceusage.googleapis.com")
    ? new gcp.projects.Service(
        `${args.logicalName}-serviceusage-api`,
        {
          project: args.project.projectId,
          service: "serviceusage.googleapis.com",
          disableOnDestroy: false,
        },
        { provider: args.provider, dependsOn: [args.project] },
      )
    : undefined;

  if (serviceUsageApi) {
    resources["serviceusage.googleapis.com"] = serviceUsageApi;
  }

  for (const api of args.services) {
    if (api === "serviceusage.googleapis.com") continue;

    resources[api] = new gcp.projects.Service(
      `${args.logicalName}-${apiLogicalName(api)}-api`,
      {
        project: args.project.projectId,
        service: api,
        disableOnDestroy: false,
      },
      {
        provider: args.provider,
        dependsOn: serviceUsageApi
          ? [args.project, serviceUsageApi]
          : [args.project],
      },
    );
  }

  return resources;
}
