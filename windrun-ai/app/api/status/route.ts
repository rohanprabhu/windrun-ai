import { readDeploymentStatus } from "@/lib/deployment";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const requestHost =
    request.headers.get("x-forwarded-host") || request.headers.get("host");

  return Response.json(
    {
      ...readDeploymentStatus(process.env, requestHost),
      requestId: crypto.randomUUID(),
      serverTime: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
