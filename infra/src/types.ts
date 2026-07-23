export type StackKind =
  | "foundation"
  | "delivery"
  | "production-edge"
  | "production"
  | "staging-edge"
  | "staging"
  | "preview";

export interface StackContext {
  kind: StackKind;
  stackName: string;
  serviceName?: string;
  previewNumber?: number;
  gitCommitSha?: string;
}

export interface RawStackConfig {
  stackKind: StackKind;
  gitCommitSha?: string;
  pullRequestNumber?: number;
  allowProjectDeletion?: boolean;
  allowStagingCertificateReplacement?: boolean;
  allowStagingPreviewNegReplacement?: boolean;
  enablePulumiGithubOidc?: boolean;
  productionCiEnabled?: boolean;
  stagingCiEnabled?: boolean;
  pulumiOrganization?: string;
}
