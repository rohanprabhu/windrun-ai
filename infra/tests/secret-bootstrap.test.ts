import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const script = readFileSync(
  resolve(__dirname, "../scripts/bootstrap-foundation-secret.sh"),
  "utf8",
);

describe("foundation secret bootstrap", () => {
  it("moves the DigitalOcean token into encrypted Pulumi config without logging it", () => {
    const readCommand =
      'TOKEN="$(security find-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean -w)"';
    const setSecretCommand =
      'pulumi config set --stack foundation --secret windrun-ai:digitalOceanToken "$TOKEN"';
    const ciphertextCheck =
      "rg -q 'windrun-ai:digitalOceanToken:' Pulumi.foundation.yaml";
    const deleteCommand =
      "security delete-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean";

    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain(readCommand);
    expect(script).toContain(setSecretCommand);
    expect(script).toContain(ciphertextCheck);
    expect(script).toContain(deleteCommand);
    expect(script).toContain("unset TOKEN");

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
});
