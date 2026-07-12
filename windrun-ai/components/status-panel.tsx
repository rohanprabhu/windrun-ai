import type { DeploymentStatus } from "@/lib/deployment";

interface StatusPanelProps {
  status: DeploymentStatus;
}

const rows: ReadonlyArray<{
  label: string;
  key: keyof DeploymentStatus;
}> = [
  { label: "Environment", key: "environment" },
  { label: "Project ID", key: "projectId" },
  { label: "Region", key: "region" },
  { label: "Pulumi stack", key: "stack" },
  { label: "Service", key: "service" },
  { label: "Revision", key: "revision" },
  { label: "Commit", key: "commitSha" },
  { label: "Canonical host", key: "canonicalHost" },
];

export function StatusPanel({ status }: StatusPanelProps) {
  return (
    <section className="status-panel" aria-labelledby="status-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Live deployment</p>
          <h2 id="status-heading">Runtime coordinates</h2>
        </div>
        <span className={`environment-badge environment-${status.environment}`}>
          <span className="status-dot" aria-hidden="true" />
          {status.environment}
        </span>
      </div>

      <dl className="status-grid">
        {rows.map((row) => (
          <div className="status-row" key={row.key}>
            <dt>{row.label}</dt>
            <dd>{status[row.key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
