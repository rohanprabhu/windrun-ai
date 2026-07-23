#!/usr/bin/env bash
set -euo pipefail

image="windrun-ai:test"
container="windrun-ai-smoke-$$"
port="18080"

cleanup() {
  docker stop "$container" >/dev/null 2>&1 || true
  docker rm "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -f windrun-ai/Dockerfile -t "$image" .
docker run -d --name "$container" -p "127.0.0.1:${port}:8080" \
  -e PORT=8080 \
  -e APP_ENVIRONMENT=preview \
  -e GCP_PROJECT_ID=windrun-ai-staging-20260712 \
  -e GOOGLE_CLOUD_REGION=asia-south1 \
  -e GIT_COMMIT_SHA=0123456789abcdef \
  -e PULUMI_STACK=pr-1 \
  -e NEXT_PUBLIC_CANONICAL_HOST=pr-1.app.staging.windrun.ai \
  -e K_SERVICE=pr-1 \
  -e K_REVISION=pr-1-00001-smoke \
  "$image" >/dev/null

healthy=false
for _attempt in {1..30}; do
  if curl --connect-timeout 2 --max-time 5 --fail --silent "http://127.0.0.1:${port}/api/health" | grep -q '"ok":true'; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  docker logs "$container"
  exit 1
fi

runtime_uid="$(docker exec "$container" id -u)"
if [[ "$runtime_uid" == "0" ]]; then
  echo "container must not run as root" >&2
  exit 1
fi

status="$(curl --connect-timeout 2 --max-time 5 --fail --silent --show-error "http://127.0.0.1:${port}/api/status")"
node -e '
  const status = JSON.parse(process.argv[1]);
  const expected = {
    environment: "preview",
    projectId: "windrun-ai-staging-20260712",
    region: "asia-south1",
    commitSha: "0123456",
    stack: "pr-1",
    canonicalHost: "pr-1.app.staging.windrun.ai",
    service: "pr-1",
    revision: "pr-1-00001-smoke",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (status[key] !== value) {
      throw new Error(key + ": expected " + value + ", got " + status[key]);
    }
  }
' "$status"

curl --connect-timeout 2 --max-time 5 --fail --silent --show-error "http://127.0.0.1:${port}/" | grep -q "Hello from the"
echo "CONTAINER SMOKE OK image=${image} uid=${runtime_uid}"
