# Windrun Application and Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vite starter with a polished, tested Next.js deployment console that runs as a minimal non-root Cloud Run container.

**Architecture:** The application remains in `windrun-ai/` inside a two-package pnpm workspace. Server-only deployment metadata is normalized in `lib/deployment.ts`; route handlers and the page consume that one interface. A client launch-console component owns latency checks and the visual wind control, while CSS owns animation and reduced-motion behavior.

**Tech Stack:** Next.js 16.2.10, React 19.2.7, TypeScript 5.9.3, Vitest 4.1.10, Testing Library 16.3.2, pnpm 11.7.0, Node.js 22 LTS, Docker/BuildKit.

## Global Constraints

- Preserve the application directory name `windrun-ai/` and consolidate dependency installation into one root lockfile.
- Use Next.js App Router, `output: "standalone"`, and set `outputFileTracingRoot` to the repository root so monorepo standalone output contains `windrun-ai/server.js`.
- Bind the production server to `0.0.0.0` and the `PORT` environment variable.
- Do not fetch fonts or runtime assets from third parties.
- Do not expose secrets or raw request headers through `/api/status`.
- The application metadata contract is `APP_ENVIRONMENT`, `GCP_PROJECT_ID`, `GOOGLE_CLOUD_REGION`, `GIT_COMMIT_SHA`, `PULUMI_STACK`, and `NEXT_PUBLIC_CANONICAL_HOST`, plus Cloud Run-provided `K_SERVICE` and `K_REVISION`; project ID is intentionally public, while unrelated process variables remain private. Consume `NEXT_PUBLIC_CANONICAL_HOST` only through the server metadata reader so it remains a runtime value.
- Application deployments set `GOOGLE_CLOUD_REGION=asia-south1`; missing project and region metadata use the explicit local defaults `local-project` and `local`.
- All animation must honor `prefers-reduced-motion: reduce`.
- The container runtime uses the official Node.js 22 Alpine image for reliable Cloud Run execution, runs as non-root, and receives only standalone runtime output, static assets, and public assets from the builder. It must not receive application source, tests, the pnpm store, or build dependencies; tools bundled by the official base image are permitted but are not used at runtime.

---

### Task 1: Consolidate the workspace and install the Next.js test harness

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json`
- Replace: `windrun-ai/package.json`
- Create: `windrun-ai/next.config.ts`
- Create: `windrun-ai/tsconfig.json`
- Create: `windrun-ai/vitest.config.ts`
- Create: `windrun-ai/vitest.setup.ts`
- Create: `windrun-ai/eslint.config.mjs`
- Delete after migration: `windrun-ai/pnpm-lock.yaml`, Vite/TanStack configuration and source files
- Regenerate: `pnpm-lock.yaml`

**Interfaces:**
- Produces root scripts `dev`, `build`, `test`, `test:app`, `lint`, and `typecheck`.
- Produces a Next.js package named `@windrun/app` addressable with `pnpm --filter @windrun/app`.

- [ ] **Step 1: Write the workspace manifest and package scripts**

```yaml
# pnpm-workspace.yaml
packages:
  - windrun-ai
  - infra
```

```json
{
  "name": "windrun-ai-platform",
  "private": true,
  "packageManager": "pnpm@11.7.0",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "dev": "pnpm --filter @windrun/app dev",
    "build": "pnpm -r --filter=!windrun-ai-platform --if-present build",
    "test": "pnpm -r --filter=!windrun-ai-platform --if-present test",
    "test:app": "pnpm --filter @windrun/app test",
    "lint": "pnpm -r --filter=!windrun-ai-platform --if-present lint",
    "typecheck": "pnpm -r --filter=!windrun-ai-platform --if-present typecheck"
  }
}
```

- [ ] **Step 2: Replace the app manifest and framework configuration**

```json
{
  "name": "@windrun/app",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start -H 0.0.0.0",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . --max-warnings=0",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "16.2.10",
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "22.18.12",
    "@types/react": "19.2.2",
    "@types/react-dom": "19.2.2",
    "eslint": "9.39.1",
    "eslint-config-next": "16.2.10",
    "jsdom": "27.0.1",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

```ts
// windrun-ai/next.config.ts
import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // `pnpm --filter @windrun/app build` runs with `windrun-ai/` as cwd.
  // Root tracing makes standalone preserve the monorepo-relative app path:
  // `.next/standalone/windrun-ai/server.js`.
  outputFileTracingRoot: path.join(process.cwd(), ".."),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
```

- [ ] **Step 3: Configure strict TypeScript, Vitest, and Next.js ESLint rules**

```ts
// windrun-ai/vitest.config.ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    coverage: { reporter: ["text", "json-summary"] },
  },
  resolve: { alias: { "@": appRoot } },
});
```

```ts
// windrun-ai/vitest.setup.ts
import "@testing-library/jest-dom/vitest";
```

```js
// windrun-ai/eslint.config.mjs
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);
```

- [ ] **Step 4: Remove the obsolete Vite/TanStack files and install once from the root**

Run: `pnpm install`

Expected: one root `pnpm-lock.yaml`; `pnpm --filter @windrun/app exec next --version` prints `Next.js v16.2.10`.

- [ ] **Step 5: Verify the empty Next scaffold compiles**

Run: `pnpm --filter @windrun/app typecheck`

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml windrun-ai
git commit -m "chore: migrate app workspace to Next.js"
```

---

### Task 2: Implement typed deployment metadata and API routes with tests

**Files:**
- Create: `windrun-ai/lib/deployment.ts`
- Create: `windrun-ai/app/api/health/route.ts`
- Create: `windrun-ai/app/api/status/route.ts`
- Create: `windrun-ai/tests/deployment.test.ts`
- Create: `windrun-ai/tests/status-route.test.ts`

**Interfaces:**
- Produces `DeploymentStatus` and `readDeploymentStatus(env?: NodeJS.ProcessEnv): DeploymentStatus`.
- Produces `GET /api/health -> { ok: true }` and `GET /api/status -> DeploymentStatus & { requestId, serverTime }`.
- `DeploymentStatus` exposes `environment`, public `projectId`, configured `region`, `commitSha`, `stack`, `canonicalHost`, `service`, and `revision`; it does not expose unrelated process variables.

- [ ] **Step 1: Write failing normalization tests**

```ts
import { describe, expect, it } from "vitest";
import { readDeploymentStatus } from "@/lib/deployment";

describe("readDeploymentStatus", () => {
  it("normalizes Cloud Run metadata without leaking unrelated variables", () => {
    expect(readDeploymentStatus({
      APP_ENVIRONMENT: "preview",
      GCP_PROJECT_ID: "windrun-ai-staging-20260712",
      GOOGLE_CLOUD_REGION: "asia-south1",
      GIT_COMMIT_SHA: "0123456789abcdef",
      PULUMI_STACK: "pr-42",
      NEXT_PUBLIC_CANONICAL_HOST: "pr-42.staging.app.windrun.ai",
      K_SERVICE: "pr-42",
      K_REVISION: "pr-42-00007-abc",
      SECRET_VALUE: "never-return-this"
    })).toEqual({
      environment: "preview",
      projectId: "windrun-ai-staging-20260712",
      region: "asia-south1",
      commitSha: "0123456",
      stack: "pr-42",
      canonicalHost: "pr-42.staging.app.windrun.ai",
      service: "pr-42",
      revision: "pr-42-00007-abc"
    });
  });

  it("uses explicit local defaults", () => {
    expect(readDeploymentStatus({})).toEqual({
      environment: "local",
      projectId: "local-project",
      region: "local",
      commitSha: "local",
      stack: "local",
      canonicalHost: "localhost:3000",
      service: "windrun-local",
      revision: "local"
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `pnpm --filter @windrun/app test -- tests/deployment.test.ts`

Expected: FAIL because `@/lib/deployment` does not exist.

- [ ] **Step 3: Implement the metadata interface**

```ts
export type AppEnvironment = "production" | "staging" | "preview" | "local";

export interface DeploymentStatus {
  environment: AppEnvironment;
  projectId: string;
  region: string;
  commitSha: string;
  stack: string;
  canonicalHost: string;
  service: string;
  revision: string;
}

const allowedEnvironments = new Set<AppEnvironment>([
  "production", "staging", "preview", "local"
]);

export function readDeploymentStatus(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentStatus {
  const candidate = env.APP_ENVIRONMENT as AppEnvironment | undefined;
  const environment = candidate && allowedEnvironments.has(candidate) ? candidate : "local";
  return {
    environment,
    projectId: env.GCP_PROJECT_ID || "local-project",
    region: env.GOOGLE_CLOUD_REGION || "local",
    commitSha: env.GIT_COMMIT_SHA?.slice(0, 7) || "local",
    stack: env.PULUMI_STACK || "local",
    // Bracket access keeps this server-read runtime value out of client bundles.
    canonicalHost: env["NEXT_PUBLIC_CANONICAL_HOST"] || "localhost:3000",
    service: env.K_SERVICE || "windrun-local",
    revision: env.K_REVISION || "local",
  };
}
```

- [ ] **Step 4: Write and implement route tests**

```ts
import { expect, it } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { GET as status } from "@/app/api/status/route";

it("returns a cache-free health response", async () => {
  const response = await health();
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it("returns status with a bounded request identifier", async () => {
  const response = await status();
  const body = await response.json();
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(body.environment).toBeDefined();
  expect(body.projectId).toBeDefined();
  expect(body.region).toBeDefined();
  expect(body.stack).toBeDefined();
  expect(body.canonicalHost).toBeDefined();
});
```

```ts
// windrun-ai/app/api/health/route.ts
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
```

```ts
// windrun-ai/app/api/status/route.ts
import { readDeploymentStatus } from "@/lib/deployment";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({
    ...readDeploymentStatus(),
    requestId: crypto.randomUUID(),
    serverTime: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
```

- [ ] **Step 5: Run focused and full tests**

Run: `pnpm --filter @windrun/app test`

Expected: all deployment and route tests PASS.

- [ ] **Step 6: Commit**

```bash
git add windrun-ai/lib windrun-ai/app/api windrun-ai/tests
git commit -m "feat: expose deployment health and status"
```

---

### Task 3: Build the launch console using component-first TDD

**Files:**
- Create: `windrun-ai/app/layout.tsx`
- Create: `windrun-ai/app/page.tsx`
- Create: `windrun-ai/components/launch-console.tsx`
- Create: `windrun-ai/components/status-panel.tsx`
- Create: `windrun-ai/tests/launch-console.test.tsx`

**Interfaces:**
- `LaunchConsoleProps { initialStatus: DeploymentStatus }`.
- Client fetches `/api/status`, reports latency, and updates only non-sensitive status fields.

- [ ] **Step 1: Write the failing interaction test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { LaunchConsole } from "@/components/launch-console";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      environment: "staging", projectId: "windrun-ai-staging-20260712",
      region: "asia-south1", commitSha: "abcdef0",
      stack: "staging", canonicalHost: "staging.app.windrun.ai",
      service: "staging", revision: "staging-00001",
      requestId: "11111111-1111-1111-1111-111111111111",
      serverTime: "2026-07-12T00:00:00.000Z"
    })
  }));
});

it("pings the deployment and exposes the request id", async () => {
  const user = userEvent.setup();
  render(<LaunchConsole initialStatus={{
    environment: "staging", projectId: "windrun-ai-staging-20260712",
    region: "asia-south1", commitSha: "abcdef0",
    stack: "staging", canonicalHost: "staging.app.windrun.ai",
    service: "staging", revision: "staging-00001"
  }} />);
  expect(screen.getByText("Project ID")).toBeInTheDocument();
  expect(screen.getByText("windrun-ai-staging-20260712")).toBeInTheDocument();
  expect(screen.getByText("Region")).toBeInTheDocument();
  expect(screen.getByText("asia-south1")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Ping this deployment" }));
  expect(await screen.findByText("11111111")).toBeInTheDocument();
  expect(screen.getByText(/ms/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @windrun/app test -- tests/launch-console.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the server page and client state boundary**

```tsx
// windrun-ai/app/page.tsx
import { LaunchConsole } from "@/components/launch-console";
import { readDeploymentStatus } from "@/lib/deployment";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return <LaunchConsole initialStatus={readDeploymentStatus()} />;
}
```

Implement `LaunchConsole` with `useState`, `performance.now()`, a guarded fetch, accessible pending/error live regions, wind-strength range input, and a copy-URL button. Build the copy target from `initialStatus.canonicalHost`: use `http://localhost:3000` for the local default and `https://${initialStatus.canonicalHost}` for deployed environments. `StatusPanel` must render labelled rows for Environment, Project ID, Region, Pulumi stack, Service, Revision, Commit, and Canonical host. Do not duplicate metadata rendering in the parent and do not read `process.env` from a client component.

- [ ] **Step 4: Add layout metadata and semantic structure**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Windrun Launch Console",
  description: "A Cloud Run deployment by Windrun AI",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @windrun/app test && pnpm --filter @windrun/app typecheck`

Expected: PASS; no `act()` warnings or TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add windrun-ai/app windrun-ai/components windrun-ai/tests
git commit -m "feat: add interactive Windrun launch console"
```

---

### Task 4: Add the finished visual system and accessibility checks

**Files:**
- Create: `windrun-ai/app/globals.css`
- Create: `windrun-ai/public/windrun-mark.svg`
- Modify: `windrun-ai/tests/launch-console.test.tsx`

**Interfaces:**
- CSS custom property `--wind-speed` is set by the client to a bounded value from `0.4` to `2`.
- Reduced motion disables non-essential animation while retaining readable state.

- [ ] **Step 1: Add assertions for labels and bounded wind control**

```tsx
it("offers an accessible bounded wind control", async () => {
  const user = userEvent.setup();
  render(<LaunchConsole initialStatus={localStatus} />);
  const control = screen.getByRole("slider", { name: "Wind strength" });
  expect(control).toHaveAttribute("min", "0.4");
  expect(control).toHaveAttribute("max", "2");
  await user.clear(control);
  await user.type(control, "1.6");
  expect(control).toHaveValue("1.6");
});
```

- [ ] **Step 2: Implement the CSS system**

Define tokens for ink, cloud, electric blue, aurora cyan, and warm white; a full-viewport atmospheric background; two pseudo-element wind layers; glass panels; environment-specific badge colors; responsive two-column-to-one-column layout; and `@media (prefers-reduced-motion: reduce)` that sets animation duration to `0.001ms` and disables smooth scrolling. Use no generated raster images.

- [ ] **Step 3: Verify accessibility and production build**

Run: `pnpm --filter @windrun/app test && pnpm --filter @windrun/app lint && pnpm --filter @windrun/app build`

Expected: all tests PASS; ESLint reports zero warnings; Next reports successful route generation for `/`, `/api/health`, and `/api/status`.

- [ ] **Step 4: Commit**

```bash
git add windrun-ai/app/globals.css windrun-ai/public windrun-ai/tests
git commit -m "style: finish responsive Windrun visual system"
```

---

### Task 5: Package and smoke-test the standalone Cloud Run image

**Files:**
- Create: `windrun-ai/Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/smoke-container.sh`
- Modify: `package.json`

**Interfaces:**
- Image listens on container port `8080` and exposes `/api/health`.
- `APP_ENVIRONMENT`, `GCP_PROJECT_ID`, `GOOGLE_CLOUD_REGION`, `GIT_COMMIT_SHA`, `PULUMI_STACK`, and `NEXT_PUBLIC_CANONICAL_HOST` are injected when the container starts, never as Docker build arguments; Cloud Run supplies `K_SERVICE` and `K_REVISION`.
- Because `outputFileTracingRoot` is the repository root, the standalone server entry is `windrun-ai/.next/standalone/windrun-ai/server.js`; runtime static and public assets must live beside that mirrored app directory.
- The root `.dockerignore` applies to the `docker build ... .` context and prevents local dependencies, builds, coverage, credentials, and repository metadata from entering any build stage.

- [ ] **Step 1: Write the failing smoke script**

```bash
#!/usr/bin/env bash
set -euo pipefail
image="windrun-ai:test"
container="windrun-ai-smoke"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
docker build -f windrun-ai/Dockerfile -t "$image" .
docker run --rm -d --name "$container" -p 18080:8080 \
  -e PORT=8080 \
  -e APP_ENVIRONMENT=preview \
  -e GCP_PROJECT_ID=windrun-ai-staging-20260712 \
  -e GOOGLE_CLOUD_REGION=asia-south1 \
  -e GIT_COMMIT_SHA=0123456789abcdef \
  -e PULUMI_STACK=pr-1 \
  -e NEXT_PUBLIC_CANONICAL_HOST=pr-1.staging.app.windrun.ai \
  -e K_SERVICE=pr-1 \
  -e K_REVISION=pr-1-00001-smoke \
  "$image"
healthy=false
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:18080/api/health | grep -q '"ok":true'; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  docker logs "$container"
  exit 1
fi
status="$(curl --fail --silent http://127.0.0.1:18080/api/status)"
node -e '
  const status = JSON.parse(process.argv[1]);
  const expected = {
    environment: "preview",
    projectId: "windrun-ai-staging-20260712",
    region: "asia-south1",
    commitSha: "0123456",
    stack: "pr-1",
    canonicalHost: "pr-1.staging.app.windrun.ai",
    service: "pr-1",
    revision: "pr-1-00001-smoke",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (status[key] !== value) throw new Error(`${key}: expected ${value}, got ${status[key]}`);
  }
' "$status"
```

- [ ] **Step 2: Run it and verify failure**

Run: `bash scripts/smoke-container.sh`

Expected: FAIL because `windrun-ai/Dockerfile` does not exist.

- [ ] **Step 3: Implement the non-root multi-stage Dockerfile**

```dockerfile
FROM node:22.22.0-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

FROM base AS deps
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY windrun-ai/package.json windrun-ai/package.json
RUN pnpm install --frozen-lockfile --filter @windrun/app...

FROM deps AS builder
COPY windrun-ai windrun-ai
RUN pnpm --filter @windrun/app test && pnpm --filter @windrun/app build

FROM node:22.22.0-alpine AS runner
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8080
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
# `outputFileTracingRoot` mirrors the workspace-relative `windrun-ai/` path.
COPY --from=builder --chown=nextjs:nodejs /workspace/windrun-ai/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/windrun-ai/.next/static ./windrun-ai/.next/static
COPY --from=builder --chown=nextjs:nodejs /workspace/windrun-ai/public ./windrun-ai/public
WORKDIR /app/windrun-ai
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
```

Create the ignore file at the repository root because the Docker build context is `.`:

```dockerignore
# .dockerignore
.git
.github
docs
**/node_modules
**/.next
**/coverage
**/*.log
**/.env
**/.env.*
```

- [ ] **Step 4: Verify the monorepo standalone path, then run the container and repository checks**

Run: `pnpm build && test -f windrun-ai/.next/standalone/windrun-ai/server.js && bash scripts/smoke-container.sh && pnpm test`

Expected: the traced server exists at `windrun-ai/.next/standalone/windrun-ai/server.js`; the smoke script validates the runtime metadata contract and exits 0; all repository tests PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json .dockerignore windrun-ai/Dockerfile scripts/smoke-container.sh
git commit -m "build: package Next.js app for Cloud Run"
```
