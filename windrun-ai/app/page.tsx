import { LaunchConsole } from "@/components/launch-console";
import { readDeploymentStatus } from "@/lib/deployment";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return <LaunchConsole initialStatus={readDeploymentStatus()} />;
}
