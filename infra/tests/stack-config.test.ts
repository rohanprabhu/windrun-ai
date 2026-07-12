import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const infraDirectory = resolve(__dirname, "..");
const staticStacks = [
  "foundation",
  "delivery",
  "production-edge",
  "production",
  "staging-edge",
  "staging",
] as const;

const allowedProjectConfigKeys = new Set([
  "windrun-ai:stackKind",
  "windrun-ai:gitCommitSha",
  "windrun-ai:pullRequestNumber",
  "windrun-ai:allowProjectDeletion",
  "windrun-ai:enablePulumiGithubOidc",
  "windrun-ai:productionCiEnabled",
  "windrun-ai:stagingCiEnabled",
  "windrun-ai:pulumiOrganization",
  "windrun-ai:digitalOceanToken",
]);

type StaticStack = (typeof staticStacks)[number];

function stackFileName(stack: StaticStack) {
  return `Pulumi.${stack}.yaml`;
}

function readStackConfig(stack: StaticStack): Record<string, unknown> {
  const document = parse(
    readFileSync(resolve(infraDirectory, stackFileName(stack)), "utf8"),
  ) as { config?: Record<string, unknown> };

  expect(document.config).toBeDefined();
  return document.config ?? {};
}

describe("static Pulumi stack configuration", () => {
  it.each(staticStacks)(
    "disables the default GCP provider and matches the %s filename",
    (stack) => {
      const config = readStackConfig(stack);

      expect(config["pulumi:disable-default-providers"]).toContain("gcp");
      expect(config["windrun-ai:stackKind"]).toBe(stack);
    },
  );

  it.each(["production", "staging"] as const)(
    "disables the default docker-build provider for %s",
    (stack) => {
      expect(readStackConfig(stack)["pulumi:disable-default-providers"]).toContain(
        "docker-build",
      );
    },
  );

  it("commits only safe foundation defaults", () => {
    const config = readStackConfig("foundation");

    expect([false, "false"]).toContain(
      config["windrun-ai:allowProjectDeletion"],
    );
    expect(config).not.toHaveProperty("windrun-ai:enablePulumiGithubOidc");
    expect(config).not.toHaveProperty("windrun-ai:pulumiOrganization");
  });

  it("keeps delivery OIDC disabled until the Pulumi organization is claimed", () => {
    const config = readStackConfig("delivery");

    expect(config["windrun-ai:enablePulumiGithubOidc"]).toBe(false);
    expect(config).not.toHaveProperty("windrun-ai:pulumiOrganization");
  });

  it.each(["production", "staging"] as const)(
    "leaves the %s deployment commit as a dynamic input",
    (stack) => {
      expect(readStackConfig(stack)).not.toHaveProperty(
        "windrun-ai:gitCommitSha",
      );
    },
  );

  it.each(staticStacks)(
    "leaves preview metadata out of the %s static config",
    (stack) => {
      expect(readStackConfig(stack)).not.toHaveProperty(
        "windrun-ai:pullRequestNumber",
      );
    },
  );

  it("contains no committed preview stack config", () => {
    const previewConfigs = readdirSync(infraDirectory).filter((file) =>
      /^Pulumi\.pr-.*\.yaml$/u.test(file),
    );

    expect(previewConfigs).toEqual([]);
  });

  it.each(staticStacks)(
    "uses only the seven-key Windrun config contract in %s",
    (stack) => {
      const projectKeys = Object.keys(readStackConfig(stack)).filter((key) =>
        key.startsWith("windrun-ai:"),
      );

      expect(
        projectKeys.filter((key) => !allowedProjectConfigKeys.has(key)),
      ).toEqual([]);
    },
  );
});
