#!/usr/bin/env bash
set -euo pipefail

ACCOUNT="windrun-ai"
SERVICE="com.windrun.pulumi.digitalocean"
STACK="${1:-}"

if [[ -z "${STACK}" ]]; then
  echo "usage: bootstrap-foundation-secret.sh <pulumi-foundation-stack-ref>" >&2
  exit 2
fi

if [[ "${STACK}" != */windrun-ai/foundation ]]; then
  echo "stack must be the fully qualified windrun-ai foundation stack" >&2
  exit 2
fi

TOKEN="$(security find-generic-password -a "${ACCOUNT}" -s "${SERVICE}" -w)"
if [[ -z "${TOKEN//[[:space:]]/}" ]]; then
  unset TOKEN
  echo "DigitalOcean token is empty" >&2
  exit 1
fi

pulumi config set \
  windrun-ai:digitalOceanToken \
  "${TOKEN}" \
  --secret \
  --stack "${STACK}"

unset TOKEN

CONFIG_JSON="$(pulumi config --json --stack "${STACK}")"
if ! node -e '
const config = JSON.parse(process.argv[1]);
const entry = config["windrun-ai:digitalOceanToken"];
if (!entry || entry.secret !== true || typeof entry.value !== "string" || entry.value.trim() === "") {
  process.exit(1);
}
' "${CONFIG_JSON}"; then
  unset CONFIG_JSON
  echo "encrypted DigitalOcean token config was not verified" >&2
  exit 1
fi

unset CONFIG_JSON
security delete-generic-password -a "${ACCOUNT}" -s "${SERVICE}" >/dev/null
