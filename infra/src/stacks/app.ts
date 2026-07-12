import path from "node:path";

import * as dockerBuild from "@pulumi/docker-build";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { HOSTNAMES, REGION, SERVICE_NAMES } from "../constants";

export interface AppStackArgs {
  kind: "production" | "staging" | "preview";
  projectId: pulumi.Input<string>;
  provider: gcp.Provider;
  repositoryId: pulumi.Input<string>;
  runtimeServiceAccountEmail: pulumi.Input<string>;
  serviceName: string;
  gitCommitSha: string;
  sourceRoot?: string;
}

export interface AppStackOutputs {
  publicUrl: pulumi.Output<string>;
  projectId: pulumi.Output<string>;
  serviceName: pulumi.Output<string>;
  imageDigest: pulumi.Output<string>;
}

const gitShaPattern = /^[0-9a-f]{40}$/;
const previewServicePattern = /^pr-[1-9][0-9]*$/;

function validateArgs(args: AppStackArgs) {
  if (!gitShaPattern.test(args.gitCommitSha)) {
    throw new Error(
      "gitCommitSha must be a lowercase 40-character Git SHA",
    );
  }

  if (args.kind === "preview") {
    if (args.sourceRoot === undefined) {
      throw new Error("sourceRoot is required for preview");
    }
    if (!path.isAbsolute(args.sourceRoot)) {
      throw new Error("sourceRoot must be absolute");
    }
    if (!previewServicePattern.test(args.serviceName)) {
      throw new Error("preview serviceName must match pr-<number>");
    }
    return;
  }

  if (args.sourceRoot !== undefined) {
    throw new Error("sourceRoot is valid only for preview");
  }

  if (
    args.kind === "production" &&
    args.serviceName !== SERVICE_NAMES.production
  ) {
    throw new Error("production serviceName must be production");
  }

  if (args.kind === "staging" && args.serviceName !== SERVICE_NAMES.staging) {
    throw new Error("staging serviceName must be staging");
  }
}

function canonicalHost(args: AppStackArgs) {
  if (args.kind === "production") return HOSTNAMES.production;
  if (args.kind === "staging") return HOSTNAMES.staging;
  return `${args.serviceName}.${HOSTNAMES.previewSuffix}`;
}

export function createAppStack(args: AppStackArgs): AppStackOutputs {
  validateArgs(args);

  const registryHost = `${REGION}-docker.pkg.dev`;
  const contextRoot = args.sourceRoot ?? "..";
  const dockerfile = args.sourceRoot
    ? path.join(args.sourceRoot, "windrun-ai", "Dockerfile")
    : "../windrun-ai/Dockerfile";
  const host = canonicalHost(args);
  const tag = pulumi.interpolate`${registryHost}/${args.projectId}/${args.repositoryId}/${args.serviceName}:${args.gitCommitSha}`;
  const dockerProvider = new dockerBuild.Provider(
    `${args.serviceName}-docker-build`,
    { host: "" },
  );

  const image = new dockerBuild.Image(
    `${args.serviceName}-image`,
    {
      buildOnPreview: false,
      exec: false,
      context: { location: contextRoot },
      dockerfile: { location: dockerfile },
      platforms: [dockerBuild.Platform.Linux_amd64],
      push: true,
      tags: [tag],
    },
    { provider: dockerProvider, retainOnDelete: true },
  );

  const service = new gcp.cloudrunv2.Service(
    args.serviceName,
    {
      project: args.projectId,
      name: args.serviceName,
      location: REGION,
      deletionProtection: false,
      ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      invokerIamDisabled: true,
      template: {
        serviceAccount: args.runtimeServiceAccountEmail,
        containers: [
          {
            image: image.ref,
            ports: { containerPort: 8080 },
            envs: [
              { name: "APP_ENVIRONMENT", value: args.kind },
              { name: "GCP_PROJECT_ID", value: args.projectId },
              { name: "GOOGLE_CLOUD_REGION", value: REGION },
              { name: "GIT_COMMIT_SHA", value: args.gitCommitSha },
              { name: "PULUMI_STACK", value: pulumi.getStack() },
              { name: "NEXT_PUBLIC_CANONICAL_HOST", value: host },
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
    },
    { provider: args.provider },
  );

  return {
    publicUrl: service.uri.apply(() => `https://${host}`),
    projectId: service.project,
    serviceName: service.name,
    imageDigest: image.digest,
  };
}
