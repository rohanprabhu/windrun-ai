import * as pulumi from "@pulumi/pulumi";

export const FOUNDATION_OUTPUT_NAMES = [
  "sharedProjectId",
  "stagingProjectId",
  "productionProjectId",
  "stagingRepositoryId",
  "productionRepositoryId",
  "stagingRuntimeServiceAccountEmail",
  "productionRuntimeServiceAccountEmail",
  "stagingGlobalIp",
  "productionGlobalIp",
  "stagingCertificateMapId",
  "productionCertificateMapId",
  "stagingCertificateStatus",
  "productionCertificateStatus",
  "foundationWifProvider",
  "foundationDeployServiceAccount",
  "productionWifProvider",
  "productionDeployServiceAccount",
  "stagingWifProvider",
  "stagingDeployServiceAccount",
  "previewWifProvider",
  "previewDeployServiceAccount",
  "productionEdgeWifProvider",
  "productionEdgeDeployServiceAccount",
  "stagingEdgeWifProvider",
  "stagingEdgeDeployServiceAccount",
] as const;

export type FoundationOutputName = (typeof FOUNDATION_OUTPUT_NAMES)[number];

export type FoundationOutputs = Record<
  FoundationOutputName,
  pulumi.Output<string>
>;

function requireStringOutput(
  reference: pulumi.StackReference,
  stackName: string,
  name: FoundationOutputName,
) {
  return reference.outputs.apply((outputs) => {
    if (!Object.hasOwn(outputs, name)) {
      throw new Error(
        `Required output '${name}' does not exist on stack '${stackName}'.`,
      );
    }
    const value: unknown = outputs[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`foundation output ${name} must be a non-empty string`);
    }
    return value;
  });
}

export function getFoundationOutputs(): FoundationOutputs {
  const stackName =
    `${pulumi.getOrganization()}/${pulumi.getProject()}/foundation`;
  const foundation = new pulumi.StackReference(stackName);

  return Object.fromEntries(
    FOUNDATION_OUTPUT_NAMES.map((name) => [
      name,
      requireStringOutput(foundation, stackName, name),
    ]),
  ) as FoundationOutputs;
}
