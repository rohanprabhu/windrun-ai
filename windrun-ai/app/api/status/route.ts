import { readDeploymentStatus } from "@/lib/deployment";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      ...readDeploymentStatus(),
      requestId: crypto.randomUUID(),
      serverTime: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
