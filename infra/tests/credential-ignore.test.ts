import { spawnSync } from "node:child_process";
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

function isIgnoredByGit(path: string) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", path],
    { cwd: repositoryRoot },
  );

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.toString() || "git check-ignore failed");
  }

  return result.status === 0;
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

  it("ignores dotenv secrets while allowing sanitized examples", () => {
    expect(isIgnoredByGit("windrun-ai/.env")).toBe(true);
    expect(isIgnoredByGit("windrun-ai/.env.production")).toBe(true);
    expect(isIgnoredByGit("windrun-ai/.env.example")).toBe(false);
  });

  it("keeps credentials and repository metadata out of Docker contexts", () => {
    expect(ignoreLines(".dockerignore")).toEqual(
      expect.arrayContaining([
        ".git",
        "**/.envrc",
        "**/.netrc",
        "**/.npmrc",
        "**/*service-account*.json",
        "**/*service_account*.json",
        "**/application_default_credentials.json",
        "**/credentials.json",
        "**/gha-creds-*.json",
        "**/.workload_identity.jwt",
      ]),
    );
  });
});
