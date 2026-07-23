export type AppEnvironment = "production" | "staging" | "preview" | "local";

export interface DeploymentStatus {
  environment: AppEnvironment;
  projectId: string;
  region: string;
  commitSha: string;
  stack: string;
  canonicalHost: string;
  service: string;
  revision: string;
}

const allowedEnvironments = new Set<AppEnvironment>([
  "production",
  "staging",
  "preview",
  "local",
]);

export function normalizeRequestHost(requestHost?: string | null) {
  const firstForwardedHost = requestHost?.split(",")[0]?.trim();

  if (
    !firstForwardedHost ||
    firstForwardedHost.includes("/") ||
    firstForwardedHost.includes("\\") ||
    /[\r\n]/.test(firstForwardedHost)
  ) {
    return undefined;
  }

  return firstForwardedHost.toLowerCase();
}

export function readDeploymentStatus(
  env: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
  requestHost?: string | null,
): DeploymentStatus {
  const candidate = env.APP_ENVIRONMENT as AppEnvironment | undefined;
  const environment =
    candidate && allowedEnvironments.has(candidate) ? candidate : "local";
  const canonicalHost =
    normalizeRequestHost(requestHost) ||
    // Bracket access keeps this server-read runtime value out of client bundles.
    env["NEXT_PUBLIC_CANONICAL_HOST"] ||
    "localhost:3000";

  return {
    environment,
    projectId: env.GCP_PROJECT_ID || "local-project",
    region: env.GOOGLE_CLOUD_REGION || "local",
    commitSha: env.GIT_COMMIT_SHA?.slice(0, 7) || "local",
    stack: env.PULUMI_STACK || "local",
    canonicalHost,
    service: env.K_SERVICE || "windrun-local",
    revision: env.K_REVISION || "local",
  };
}
