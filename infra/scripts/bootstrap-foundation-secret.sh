#!/usr/bin/env bash
set -euo pipefail

validate_encrypted_config() {
  node - "$1" <<'NODE'
const { readFileSync } = require("node:fs");

let document;
try {
  const { parse } = require("yaml");
  document = parse(readFileSync(process.argv[2], "utf8"));
} catch {
  process.exit(1);
}

const ciphertext =
  document?.config?.["windrun-ai:digitalOceanToken"]?.secure;
process.exit(
  typeof ciphertext === "string" && ciphertext.trim().length > 0 ? 0 : 1,
);
NODE
}

cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--validate-config" ]]; then
  [[ $# -eq 2 ]]
  validate_encrypted_config "$2"
  exit
fi

TOKEN="$(security find-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean -w)"
pulumi config set --stack foundation --secret windrun-ai:digitalOceanToken "$TOKEN"
validate_encrypted_config Pulumi.foundation.yaml
security delete-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean
unset TOKEN
