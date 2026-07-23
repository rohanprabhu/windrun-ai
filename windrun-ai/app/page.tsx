import { headers } from "next/headers";

import { LaunchConsole } from "@/components/launch-console";
import { readDeploymentStatus } from "@/lib/deployment";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const requestHeaders = await headers();
  const requestHost =
    requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");

  return (
    <LaunchConsole initialStatus={readDeploymentStatus(process.env, requestHost)} />
  );
}
