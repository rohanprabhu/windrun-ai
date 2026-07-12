import { describe, expect, it } from "vitest";

import { readDeploymentStatus } from "@/lib/deployment";

describe("readDeploymentStatus", () => {
  it("normalizes Cloud Run metadata without leaking unrelated variables", () => {
    expect(
      readDeploymentStatus({
        APP_ENVIRONMENT: "preview",
        GCP_PROJECT_ID: "windrun-ai-staging-20260712",
        GOOGLE_CLOUD_REGION: "asia-south1",
        GIT_COMMIT_SHA: "0123456789abcdef",
        PULUMI_STACK: "pr-42",
        NEXT_PUBLIC_CANONICAL_HOST: "pr-42.staging.app.windrun.ai",
        K_SERVICE: "pr-42",
        K_REVISION: "pr-42-00007-abc",
        SECRET_VALUE: "never-return-this",
      }),
    ).toEqual({
      environment: "preview",
      projectId: "windrun-ai-staging-20260712",
      region: "asia-south1",
      commitSha: "0123456",
      stack: "pr-42",
      canonicalHost: "pr-42.staging.app.windrun.ai",
      service: "pr-42",
      revision: "pr-42-00007-abc",
    });
  });

  it("uses explicit local defaults", () => {
    expect(readDeploymentStatus({})).toEqual({
      environment: "local",
      projectId: "local-project",
      region: "local",
      commitSha: "local",
      stack: "local",
      canonicalHost: "localhost:3000",
      service: "windrun-local",
      revision: "local",
    });
  });

  it("normalizes an unknown environment to local", () => {
    expect(readDeploymentStatus({ APP_ENVIRONMENT: "development" }).environment).toBe(
      "local",
    );
  });
});
