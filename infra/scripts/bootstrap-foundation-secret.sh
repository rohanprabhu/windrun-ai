#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
TOKEN="$(security find-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean -w)"
pulumi config set --stack foundation --secret windrun-ai:digitalOceanToken "$TOKEN"
rg -q 'windrun-ai:digitalOceanToken:' Pulumi.foundation.yaml
security delete-generic-password -a windrun-ai -s com.windrun.pulumi.digitalocean
unset TOKEN
