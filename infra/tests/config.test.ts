import { describe, expect, it } from "vitest";

import { parseStackContext } from "../src/config";

const commitSha = "0123456789abcdef0123456789abcdef01234567";

describe("parseStackContext", () => {
  it.each([
    ["foundation", "foundation"],
    ["delivery", "delivery"],
    ["production-edge", "production-edge"],
    ["staging-edge", "staging-edge"],
  ] as const)("accepts static stack %s", (stackName, configuredKind) => {
    expect(parseStackContext(stackName, { stackKind: configuredKind })).toEqual({
      kind: configuredKind,
      stackName,
    });
  });

  it.each(["production", "staging"] as const)(
    "requires deployment metadata for %s",
    (stackName) => {
      expect(
        parseStackContext(stackName, {
          stackKind: stackName,
          gitCommitSha: commitSha,
        }),
      ).toEqual({
        kind: stackName,
        stackName,
        gitCommitSha: commitSha,
      });
    },
  );

  it("normalizes pr-42 into a preview service", () => {
    expect(
      parseStackContext("pr-42", {
        stackKind: "preview",
        gitCommitSha: commitSha,
        pullRequestNumber: 42,
      }),
    ).toEqual({
      kind: "preview",
      stackName: "pr-42",
      serviceName: "pr-42",
      previewNumber: 42,
      gitCommitSha: commitSha,
    });
  });

  it.each(["pr-0", "pr-01", "pr-main", "preview", "production2"])(
    "rejects invalid stack name %s",
    (stackName) => {
      expect(() =>
        parseStackContext(stackName, {
          stackKind: "preview",
          gitCommitSha: commitSha,
          pullRequestNumber: 42,
        }),
      ).toThrow("invalid stack name");
    },
  );

  it("rejects a configured kind that disagrees with the stack name", () => {
    expect(() =>
      parseStackContext("production", {
        stackKind: "staging",
        gitCommitSha: commitSha,
      }),
    ).toThrow("stackKind staging does not match stack production");
  });

  it.each(["abc", "A".repeat(40), "g".repeat(40), "0".repeat(39)])(
    "rejects invalid application commit SHA %s",
    (gitCommitSha) => {
      expect(() =>
        parseStackContext("production", {
          stackKind: "production",
          gitCommitSha,
        }),
      ).toThrow("gitCommitSha must be a lowercase 40-character Git SHA");
    },
  );

  it("requires pullRequestNumber to match the preview stack", () => {
    expect(() =>
      parseStackContext("pr-42", {
        stackKind: "preview",
        gitCommitSha: commitSha,
        pullRequestNumber: 41,
      }),
    ).toThrow("pullRequestNumber 41 does not match stack pr-42");
  });

  it("requires preview deployment metadata", () => {
    expect(() =>
      parseStackContext("pr-42", {
        stackKind: "preview",
      }),
    ).toThrow("gitCommitSha is required for preview");
  });

  it("allows only the deletion flag on foundation", () => {
    expect(
      parseStackContext("foundation", {
        stackKind: "foundation",
        allowProjectDeletion: true,
      }),
    ).toEqual({ kind: "foundation", stackName: "foundation" });

    expect(() =>
      parseStackContext("foundation", {
        stackKind: "foundation",
        gitCommitSha: commitSha,
      }),
    ).toThrow("gitCommitSha is not valid for foundation");
  });

  it("allows only OIDC enablement and organization on delivery", () => {
    expect(
      parseStackContext("delivery", {
        stackKind: "delivery",
        enablePulumiGithubOidc: true,
        pulumiOrganization: "rohan",
      }),
    ).toEqual({ kind: "delivery", stackName: "delivery" });

    expect(() =>
      parseStackContext("delivery", {
        stackKind: "delivery",
        allowProjectDeletion: false,
      }),
    ).toThrow("allowProjectDeletion is not valid for delivery");
  });

  it.each([
    ["production", { enablePulumiGithubOidc: false }],
    ["staging", { pulumiOrganization: "rohan" }],
    ["production-edge", { gitCommitSha: commitSha }],
    ["staging-edge", { pullRequestNumber: 1 }],
  ] as const)("rejects config outside the %s contract", (stackName, extra) => {
    const base =
      stackName === "production" || stackName === "staging"
        ? { stackKind: stackName, gitCommitSha: commitSha }
        : { stackKind: stackName };

    expect(() => parseStackContext(stackName, { ...base, ...extra })).toThrow(
      "is not valid for",
    );
  });
});
