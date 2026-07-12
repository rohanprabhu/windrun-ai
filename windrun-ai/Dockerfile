FROM node:22.22.0-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

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
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=8080

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

# `outputFileTracingRoot` mirrors the workspace-relative `windrun-ai/` path.
COPY --from=builder --chown=nextjs:nodejs /workspace/windrun-ai/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/windrun-ai/.next/static ./windrun-ai/.next/static
COPY --from=builder --chown=nextjs:nodejs /workspace/windrun-ai/public ./windrun-ai/public

WORKDIR /app/windrun-ai

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
