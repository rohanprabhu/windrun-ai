import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scriptPath = resolve(
  __dirname,
  "../scripts/bootstrap-foundation-secret.sh",
);
const script = readFileSync(scriptPath, "utf8");
const validationMode = 'if [[ "${1:-}" == "--validate-config" ]]';

function validateFixture(yaml: string) {
  expect(script).toContain(validationMode);

  const directory = mkdtempSync(join(tmpdir(), "windrun-secret-bootstrap-"));
  const fixturePath = join(directory, "Pulumi.foundation.yaml");

  try {
    writeFileSync(fixturePath, yaml, "utf8");
    return spawnSync(scriptPath, ["--validate-config", fixturePath], {
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("foundation secret bootstrap", () => {
  it("moves the DigitalOcean token into encrypted Pulumi config without logging it", () => {
    const readCommand =
      'TOKEN="$(security find-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean -w)"';
    const setSecretCommand =
      'pulumi config set --stack foundation --secret windrun-ai:digitalOceanToken "$TOKEN"';
    const ciphertextCheck =
      "validate_encrypted_config Pulumi.foundation.yaml";
    const deleteCommand =
      "security delete-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean";

    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain(validationMode);
    expect(script).toContain(readCommand);
    expect(script).toContain(setSecretCommand);
    expect(script).toContain(ciphertextCheck);
    expect(script).toContain(deleteCommand);
    expect(script).toContain("unset TOKEN");
    expect(script).not.toContain(
      "rg -q 'windrun-ai:digitalOceanToken:' Pulumi.foundation.yaml",
    );

    expect(script.indexOf(ciphertextCheck)).toBeGreaterThan(
      script.indexOf(setSecretCommand),
    );
    expect(script.indexOf(deleteCommand)).toBeGreaterThan(
      script.indexOf(ciphertextCheck),
    );
    expect(script.indexOf("unset TOKEN")).toBeGreaterThan(
      script.indexOf(deleteCommand),
    );

    expect(script).not.toMatch(/^\s*(?:echo|printf|printenv|env)\b/mu);
    expect(script).not.toMatch(/^\s*set\s+(?:-x|-o\s+xtrace)\b/mu);
    expect(script).not.toMatch(/\b(?:gcloud|doctl|gh)\b/u);
  });

  it("accepts a non-empty secure ciphertext at the exact config path", () => {
    const result = validateFixture(`
config:
  unrelated:key: value
  windrun-ai:digitalOceanToken:
    secure: "v1:encrypted-fixture"
`);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it.each([
    [
      "a plaintext value",
      `
config:
  windrun-ai:digitalOceanToken: plaintext-fixture
`,
    ],
    [
      "an empty secure value",
      `
config:
  windrun-ai:digitalOceanToken:
    secure: ""
`,
    ],
    [
      "a whitespace-only secure value",
      `
config:
  windrun-ai:digitalOceanToken:
    secure: "   "
`,
    ],
    [
      "a stale occurrence outside config",
      `
metadata:
  windrun-ai:digitalOceanToken:
    secure: v1:stale-fixture
config: {}
`,
    ],
    [
      "a secure value under an unrelated key",
      `
config:
  windrun-ai:anotherToken:
    secure: v1:unrelated-fixture
`,
    ],
    [
      "a commented secure value",
      `
config:
  windrun-ai:digitalOceanToken:
    # secure: v1:commented-fixture
    value: plaintext-fixture
`,
    ],
    [
      "a malformed document",
      `
config:
  windrun-ai:digitalOceanToken:
    secure: [unterminated
`,
    ],
  ])("rejects %s without output", (_label, yaml) => {
    const result = validateFixture(yaml);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
