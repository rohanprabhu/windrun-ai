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
