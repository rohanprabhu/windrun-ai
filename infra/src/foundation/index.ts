import * as pulumi from "@pulumi/pulumi";

import { PROJECT_IDS } from "../constants";
import type { FoundationOutputs } from "../foundation-outputs";
import { createBootstrapProvider } from "../providers";
import { createDnsCertificateResources } from "./certificates";
import { createFoundationCoreResources } from "./core";
import { createGitHubDeploymentIdentities } from "./github-wif";
import { createProjectBundle } from "./projects";
import { SHARED_APIS, WORKLOAD_APIS } from "./services";

export interface FoundationStackArgs {
  allowProjectDeletion: boolean;
  allowStagingCertificateReplacement: boolean;
}

export interface FoundationStackOutputs extends FoundationOutputs {
  apexNameServers: pulumi.Output<string[]>;
}

const stagingHostnameMigrationResources = new Set([
  "preview-a-record",
  "staging-a-record",
  "staging-validation-record",
  "staging-dns-authorization",
  "staging-certificate",
  "staging-certificate-entry",
  "staging-wildcard-certificate-entry",
]);

function registerFoundationProtection(args: {
  allowProjectDeletion: boolean;
  allowStagingCertificateReplacement: boolean;
}) {
  pulumi.runtime.registerStackTransformation(({ name, props, opts }) => ({
    props,
    opts: {
      ...opts,
      protect:
        !args.allowProjectDeletion &&
        !(
          args.allowStagingCertificateReplacement &&
          stagingHostnameMigrationResources.has(name)
        ),
    },
  }));
}

export function createFoundationStack(
  args: FoundationStackArgs,
): FoundationStackOutputs {
  registerFoundationProtection({
    allowProjectDeletion: args.allowProjectDeletion,
    allowStagingCertificateReplacement:
      args.allowStagingCertificateReplacement,
  });

  const bootstrapProvider = createBootstrapProvider();
  const shared = createProjectBundle({
    logicalName: "shared",
    projectId: PROJECT_IDS.shared,
    bootstrapProvider,
    allowProjectDeletion: args.allowProjectDeletion,
    services: SHARED_APIS,
  });
  const staging = createProjectBundle({
    logicalName: "staging",
    projectId: PROJECT_IDS.staging,
    bootstrapProvider,
    allowProjectDeletion: args.allowProjectDeletion,
    services: WORKLOAD_APIS,
  });
  const production = createProjectBundle({
    logicalName: "production",
    projectId: PROJECT_IDS.production,
    bootstrapProvider,
    allowProjectDeletion: args.allowProjectDeletion,
    services: WORKLOAD_APIS,
  });
  const core = createFoundationCoreResources({ staging, production });
  const certificates = createDnsCertificateResources({
    shared,
    staging,
    production,
    productionAddress: core.productionAddress,
    stagingAddress: core.stagingAddress,
    allowStagingCertificateReplacement:
      args.allowStagingCertificateReplacement,
  });
  const deployment = createGitHubDeploymentIdentities({
    shared,
    staging,
    production,
    productionRepository: core.productionRepository,
    stagingRepository: core.stagingRepository,
    productionRuntimeServiceAccount:
      core.productionRuntimeServiceAccount,
    stagingRuntimeServiceAccount: core.stagingRuntimeServiceAccount,
  });
  const identities = deployment.identities;

  return {
    apexNameServers: certificates.apexNameServers,
    sharedProjectId: shared.project.projectId,
    stagingProjectId: staging.project.projectId,
    productionProjectId: production.project.projectId,
    stagingRepositoryId: core.stagingRepository.repositoryId,
    productionRepositoryId: core.productionRepository.repositoryId,
    stagingRuntimeServiceAccountEmail:
      core.stagingRuntimeServiceAccount.email,
    productionRuntimeServiceAccountEmail:
      core.productionRuntimeServiceAccount.email,
    stagingGlobalIp: core.stagingAddress.address,
    productionGlobalIp: core.productionAddress.address,
    stagingCertificateMapId: certificates.stagingCertificateMap.id,
    productionCertificateMapId: certificates.productionCertificateMap.id,
    stagingCertificateStatus: certificates.stagingCertificate.managed.apply(
      (managed) => managed?.state ?? "UNKNOWN",
    ),
    productionCertificateStatus:
      certificates.productionCertificate.managed.apply(
        (managed) => managed?.state ?? "UNKNOWN",
      ),
    foundationWifProvider: identities.foundation.provider.name,
    foundationDeployServiceAccount:
      identities.foundation.serviceAccount.email,
    productionWifProvider: identities.production.provider.name,
    productionDeployServiceAccount:
      identities.production.serviceAccount.email,
    stagingWifProvider: identities.staging.provider.name,
    stagingDeployServiceAccount: identities.staging.serviceAccount.email,
    previewWifProvider: identities.preview.provider.name,
    previewDeployServiceAccount: identities.preview.serviceAccount.email,
    productionEdgeWifProvider:
      identities["production-edge"].provider.name,
    productionEdgeDeployServiceAccount:
      identities["production-edge"].serviceAccount.email,
    stagingEdgeWifProvider: identities["staging-edge"].provider.name,
    stagingEdgeDeployServiceAccount:
      identities["staging-edge"].serviceAccount.email,
  };
}
