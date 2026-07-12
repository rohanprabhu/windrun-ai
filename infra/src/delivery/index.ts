import * as pulumi from "@pulumi/pulumi";

import type { FoundationOutputs } from "../foundation-outputs";
import {
  createCiEnabledGate,
  createGitHubDeliveryResources,
} from "./github";
import { createPulumiGithubOidc } from "./pulumi-oidc";

export interface DeliveryStackArgs {
  pulumiOrganization: string;
  enablePulumiGithubOidc: boolean;
  foundation: FoundationOutputs;
}

export interface DeliveryStackOutputs {
  ciEnabled: pulumi.Output<boolean>;
}

function withoutCredentialProviderInputs<T>(create: () => T): T {
  const githubToken = process.env.GITHUB_TOKEN;
  const pulumiAccessToken = process.env.PULUMI_ACCESS_TOKEN;

  // The generated GitHub SDK otherwise copies GITHUB_TOKEN into provider
  // resource inputs. Provider plugins still inherit the Pulumi engine's env.
  delete process.env.GITHUB_TOKEN;
  delete process.env.PULUMI_ACCESS_TOKEN;
  try {
    return create();
  } finally {
    if (githubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = githubToken;
    }
    if (pulumiAccessToken === undefined) {
      delete process.env.PULUMI_ACCESS_TOKEN;
    } else {
      process.env.PULUMI_ACCESS_TOKEN = pulumiAccessToken;
    }
  }
}

function createDeliveryResources(
  args: DeliveryStackArgs,
): DeliveryStackOutputs {
  const github = createGitHubDeliveryResources({
    pulumiOrganization: args.pulumiOrganization,
    foundation: args.foundation,
  });
  const oidcPrerequisites: pulumi.Resource[] = [
    ...github.environments,
    ...github.deploymentPolicies,
  ];
  const pulumiOidc = args.enablePulumiGithubOidc
    ? createPulumiGithubOidc({
        pulumiOrganization: args.pulumiOrganization,
        dependsOn: oidcPrerequisites,
      })
    : undefined;
  const prerequisites: pulumi.Resource[] = [
    ...github.environments,
    ...github.deploymentPolicies,
    ...github.variables,
    ...(pulumiOidc ? [pulumiOidc.issuer] : []),
  ];
  const gate = createCiEnabledGate({
    provider: github.provider,
    enabled: args.enablePulumiGithubOidc,
    dependsOn: prerequisites,
  });

  return {
    ciEnabled: gate.id.apply(() => args.enablePulumiGithubOidc),
  };
}

export function createDeliveryStack(
  args: DeliveryStackArgs,
): DeliveryStackOutputs {
  return withoutCredentialProviderInputs(() => createDeliveryResources(args));
}
