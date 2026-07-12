import * as pulumi from "@pulumi/pulumi";

import { parseStackContext } from "./config";
import { SERVICE_NAMES } from "./constants";
import {
  assertDeliveryCredentials,
  createDeliveryStack,
} from "./delivery";
import { createFoundationStack } from "./foundation";
import { getFoundationOutputs } from "./foundation-outputs";
import { createProjectProvider } from "./providers";
import { createAppStack } from "./stacks/app";
import { createEdgeStack } from "./stacks/edge";
import type {
  RawStackConfig,
  StackContext,
  StackKind,
} from "./types";

function readStackContext(config: pulumi.Config): StackContext {
  const raw: RawStackConfig = {
    stackKind: config.require("stackKind") as StackKind,
    gitCommitSha: config.get("gitCommitSha"),
    pullRequestNumber: config.getNumber("pullRequestNumber"),
    allowProjectDeletion: config.getBoolean("allowProjectDeletion"),
    enablePulumiGithubOidc:
      config.getBoolean("enablePulumiGithubOidc"),
    productionCiEnabled: config.getBoolean("productionCiEnabled"),
    stagingCiEnabled: config.getBoolean("stagingCiEnabled"),
    pulumiOrganization: config.get("pulumiOrganization"),
  };

  return parseStackContext(pulumi.getStack(), raw);
}

function requireCommitSha(context: StackContext) {
  if (context.gitCommitSha === undefined) {
    throw new Error(`gitCommitSha is required for ${context.kind}`);
  }
  return context.gitCommitSha;
}

function run() {
  const config = new pulumi.Config();
  const context = readStackContext(config);

  switch (context.kind) {
    case "foundation":
      return createFoundationStack({
        allowProjectDeletion:
          config.getBoolean("allowProjectDeletion") ?? false,
        digitalOceanToken: config.requireSecret("digitalOceanToken"),
      });

    case "delivery": {
      const enablePulumiGithubOidc =
        config.getBoolean("enablePulumiGithubOidc") ?? false;
      const pulumiOrganization = config.require("pulumiOrganization");
      const productionCiEnabled =
        config.getBoolean("productionCiEnabled") ??
        enablePulumiGithubOidc;
      const stagingCiEnabled =
        config.getBoolean("stagingCiEnabled") ?? enablePulumiGithubOidc;
      if (
        !enablePulumiGithubOidc &&
        (productionCiEnabled || stagingCiEnabled)
      ) {
        throw new Error(
          "scope CI gates cannot be enabled while Pulumi GitHub OIDC is disabled",
        );
      }

      assertDeliveryCredentials(enablePulumiGithubOidc);

      const foundation = getFoundationOutputs();
      return createDeliveryStack({
        pulumiOrganization,
        enablePulumiGithubOidc,
        productionCiEnabled,
        stagingCiEnabled,
        foundation,
      });
    }

    case "production": {
      const foundation = getFoundationOutputs();
      const provider = createProjectProvider(
        "production",
        foundation.productionProjectId,
      );
      return createAppStack({
        kind: "production",
        projectId: foundation.productionProjectId,
        provider,
        repositoryId: foundation.productionRepositoryId,
        runtimeServiceAccountEmail:
          foundation.productionRuntimeServiceAccountEmail,
        serviceName: SERVICE_NAMES.production,
        gitCommitSha: requireCommitSha(context),
      });
    }

    case "staging": {
      const foundation = getFoundationOutputs();
      const provider = createProjectProvider(
        "staging",
        foundation.stagingProjectId,
      );
      return createAppStack({
        kind: "staging",
        projectId: foundation.stagingProjectId,
        provider,
        repositoryId: foundation.stagingRepositoryId,
        runtimeServiceAccountEmail:
          foundation.stagingRuntimeServiceAccountEmail,
        serviceName: SERVICE_NAMES.staging,
        gitCommitSha: requireCommitSha(context),
      });
    }

    case "preview": {
      const foundation = getFoundationOutputs();
      const provider = createProjectProvider(
        "staging",
        foundation.stagingProjectId,
      );
      return createAppStack({
        kind: "preview",
        projectId: foundation.stagingProjectId,
        provider,
        repositoryId: foundation.stagingRepositoryId,
        runtimeServiceAccountEmail:
          foundation.stagingRuntimeServiceAccountEmail,
        serviceName: context.stackName,
        gitCommitSha: requireCommitSha(context),
        sourceRoot: process.env.WINDRUN_APP_SOURCE,
      });
    }

    case "production-edge": {
      const foundation = getFoundationOutputs();
      const provider = createProjectProvider(
        "production",
        foundation.productionProjectId,
      );
      return createEdgeStack({
        kind: "production-edge",
        projectId: foundation.productionProjectId,
        provider,
        globalAddress: foundation.productionGlobalIp,
        certificateMapId: foundation.productionCertificateMapId,
        certificateStatus: foundation.productionCertificateStatus,
      });
    }

    case "staging-edge": {
      const foundation = getFoundationOutputs();
      const provider = createProjectProvider(
        "staging",
        foundation.stagingProjectId,
      );
      return createEdgeStack({
        kind: "staging-edge",
        projectId: foundation.stagingProjectId,
        provider,
        globalAddress: foundation.stagingGlobalIp,
        certificateMapId: foundation.stagingCertificateMapId,
        certificateStatus: foundation.stagingCertificateStatus,
      });
    }
  }
}

export = run;
