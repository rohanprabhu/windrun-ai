import type {
  RawStackConfig,
  StackContext,
  StackKind,
} from "./types";

const staticStackKinds = new Set<StackKind>([
  "foundation",
  "delivery",
  "production-edge",
  "production",
  "staging-edge",
  "staging",
]);

const applicationKinds = new Set<StackKind>([
  "production",
  "staging",
  "preview",
]);

const allowedConfigKeys: Record<StackKind, ReadonlySet<keyof RawStackConfig>> = {
  foundation: new Set(["stackKind", "allowProjectDeletion"]),
  delivery: new Set([
    "stackKind",
    "enablePulumiGithubOidc",
    "productionCiEnabled",
    "stagingCiEnabled",
    "pulumiOrganization",
  ]),
  "production-edge": new Set(["stackKind"]),
  production: new Set(["stackKind", "gitCommitSha"]),
  "staging-edge": new Set(["stackKind"]),
  staging: new Set(["stackKind", "gitCommitSha"]),
  preview: new Set(["stackKind", "gitCommitSha", "pullRequestNumber"]),
};

function expectedKind(stackName: string): StackKind {
  if (staticStackKinds.has(stackName as StackKind)) {
    return stackName as StackKind;
  }
  if (/^pr-[1-9][0-9]*$/.test(stackName)) {
    return "preview";
  }
  throw new Error(`invalid stack name ${stackName}`);
}

function validateAllowedKeys(kind: StackKind, config: RawStackConfig) {
  const allowed = allowedConfigKeys[kind];

  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && !allowed.has(key as keyof RawStackConfig)) {
      throw new Error(`${key} is not valid for ${kind}`);
    }
  }
}

function requireCommitSha(kind: StackKind, gitCommitSha: string | undefined) {
  if (gitCommitSha === undefined) {
    throw new Error(`gitCommitSha is required for ${kind}`);
  }
  if (!/^[0-9a-f]{40}$/.test(gitCommitSha)) {
    throw new Error("gitCommitSha must be a lowercase 40-character Git SHA");
  }
}

export function parseStackContext(
  stackName: string,
  config: RawStackConfig,
): StackContext {
  const kind = expectedKind(stackName);

  if (config.stackKind !== kind) {
    throw new Error(
      `stackKind ${config.stackKind} does not match stack ${stackName}`,
    );
  }

  validateAllowedKeys(kind, config);

  if (applicationKinds.has(kind)) {
    requireCommitSha(kind, config.gitCommitSha);
  }

  if (kind === "preview") {
    const previewNumber = Number(stackName.slice("pr-".length));
    if (config.pullRequestNumber !== previewNumber) {
      throw new Error(
        `pullRequestNumber ${config.pullRequestNumber} does not match stack ${stackName}`,
      );
    }

    return {
      kind,
      stackName,
      serviceName: stackName,
      previewNumber,
      gitCommitSha: config.gitCommitSha,
    };
  }

  if (kind === "production" || kind === "staging") {
    return {
      kind,
      stackName,
      gitCommitSha: config.gitCommitSha,
    };
  }

  return { kind, stackName };
}
