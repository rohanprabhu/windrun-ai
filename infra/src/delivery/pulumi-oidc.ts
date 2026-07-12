import * as pulumi from "@pulumi/pulumi";
import * as pulumiService from "@pulumi/pulumiservice";

import {
  GITHUB_OWNER_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
} from "../constants";
import {
  DELIVERY_ENVIRONMENTS,
  type DeliveryEnvironment,
} from "./github";

const workflowPrefix = `${GITHUB_REPOSITORY}/.github/workflows/`;

function commonRules(
  pulumiOrganization: string,
  environment: DeliveryEnvironment,
) {
  return {
    aud: `urn:pulumi:org:${pulumiOrganization}`,
    repository_id: GITHUB_REPOSITORY_ID,
    repository_owner_id: GITHUB_OWNER_ID,
    repository: GITHUB_REPOSITORY,
    environment,
    sub: `repo:*:environment:${environment}`,
  };
}

function personalPolicy(args: {
  pulumiOrganization: string;
  environment: DeliveryEnvironment;
  rules: Record<string, string>;
}): pulumiService.types.input.AuthPolicyDefinitionArgs {
  return {
    decision: pulumiService.AuthPolicyDecision.Allow,
    tokenType: pulumiService.AuthPolicyTokenType.Personal,
    userLogin: args.pulumiOrganization,
    rules: {
      ...commonRules(args.pulumiOrganization, args.environment),
      ...args.rules,
    },
  };
}

export function githubOidcPolicies(
  pulumiOrganization: string,
  scopes: {
    productionCiEnabled: boolean;
    stagingCiEnabled: boolean;
  } = { productionCiEnabled: true, stagingCiEnabled: true },
) {
  const directPolicies: Array<{
    environment: Exclude<DeliveryEnvironment, "preview">;
    eventName: "push" | "workflow_dispatch";
    ref: "main" | "staging";
    workflow: string;
  }> = [
    {
      environment: "foundation",
      eventName: "workflow_dispatch",
      ref: "main",
      workflow: "manage-foundation.yml",
    },
    {
      environment: "production",
      eventName: "push",
      ref: "main",
      workflow: "deploy-production.yml",
    },
    {
      environment: "production-edge",
      eventName: "workflow_dispatch",
      ref: "main",
      workflow: "manage-edge.yml",
    },
    {
      environment: "staging",
      eventName: "push",
      ref: "staging",
      workflow: "deploy-staging.yml",
    },
    {
      environment: "staging-edge",
      eventName: "workflow_dispatch",
      ref: "main",
      workflow: "manage-edge.yml",
    },
  ];
  const scopeEnabled = (environment: DeliveryEnvironment) => {
    if (environment === "production" || environment === "production-edge") {
      return scopes.productionCiEnabled;
    }
    if (
      environment === "staging" ||
      environment === "staging-edge" ||
      environment === "preview"
    ) {
      return scopes.stagingCiEnabled;
    }
    return true;
  };
  const policies = directPolicies
    .filter((policy) => scopeEnabled(policy.environment))
    .map((policy) =>
    personalPolicy({
      pulumiOrganization,
      environment: policy.environment,
      rules: {
        event_name: policy.eventName,
        ref: `refs/heads/${policy.ref}`,
        workflow_ref:
          `${workflowPrefix}${policy.workflow}@refs/heads/${policy.ref}`,
      },
    }),
  );
  const previewBase = {
    event_name: "pull_request",
    base_ref: "main",
  };
  const previewPolicies = [
    personalPolicy({
      pulumiOrganization,
      environment: "preview",
      rules: {
        ...previewBase,
        ref: "refs/pull/*/merge",
        workflow_ref:
          `${workflowPrefix}pull-request.yml@refs/pull/*/merge`,
        job_workflow_ref:
          `${workflowPrefix}_preview-deploy.yml@refs/heads/main`,
      },
    }),
    personalPolicy({
      pulumiOrganization,
      environment: "preview",
      rules: {
        ...previewBase,
        ref: "refs/pull/*/merge",
        workflow_ref:
          `${workflowPrefix}pull-request.yml@refs/pull/*/merge`,
        job_workflow_ref:
          `${workflowPrefix}_preview-destroy.yml@refs/heads/main`,
      },
    }),
    personalPolicy({
      pulumiOrganization,
      environment: "preview",
      rules: {
        ...previewBase,
        ref: "refs/heads/main",
        workflow_ref:
          `${workflowPrefix}pull-request.yml@refs/heads/main`,
        job_workflow_ref:
          `${workflowPrefix}_preview-destroy.yml@refs/heads/main`,
      },
    }),
  ];
  if (scopes.stagingCiEnabled) policies.push(...previewPolicies);

  const coveredEnvironments = new Set<DeliveryEnvironment>(
    directPolicies.map((policy) => policy.environment),
  );
  coveredEnvironments.add("preview");
  if (coveredEnvironments.size !== DELIVERY_ENVIRONMENTS.length) {
    throw new Error("Pulumi OIDC policies must cover every delivery environment");
  }
  return policies;
}

export function createPulumiGithubOidc(args: {
  pulumiOrganization: string;
  productionCiEnabled: boolean;
  stagingCiEnabled: boolean;
  dependsOn: pulumi.Resource[];
}) {
  const provider = new pulumiService.Provider("pulumi-service-windrun", {
    apiUrl: "https://api.pulumi.com",
  });
  const policies = githubOidcPolicies(args.pulumiOrganization, {
    productionCiEnabled: args.productionCiEnabled,
    stagingCiEnabled: args.stagingCiEnabled,
  });
  if (policies.length === 0) {
    throw new Error("Pulumi GitHub OIDC requires at least one auth policy");
  }
  const issuer = new pulumiService.OidcIssuer(
    "github-oidc-issuer",
    {
      name: "windrun-github-actions",
      organization: args.pulumiOrganization,
      url: "https://token.actions.githubusercontent.com",
      maxExpirationSeconds: 3600,
      policies,
    },
    { provider, dependsOn: args.dependsOn },
  );
  return { provider, issuer };
}
