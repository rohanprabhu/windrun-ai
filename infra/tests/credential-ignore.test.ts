import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(__dirname, "../..");

function ignoreLines(file: ".gitignore" | ".dockerignore") {
  return readFileSync(resolve(repositoryRoot, file), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("generated credential containment", () => {
  it("keeps Google OIDC credential artifacts out of Git", () => {
    expect(ignoreLines(".gitignore")).toEqual(
      expect.arrayContaining([
        "gha-creds-*.json",
        ".workload_identity.jwt",
      ]),
    );
  });

  it("keeps credentials and repository metadata out of Docker contexts", () => {
    expect(ignoreLines(".dockerignore")).toEqual(
      expect.arrayContaining([
        ".git",
        "**/gha-creds-*.json",
        "**/.workload_identity.jwt",
      ]),
    );
  });
});
