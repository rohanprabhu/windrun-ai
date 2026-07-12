"use client";

import { useState, type CSSProperties } from "react";

import { StatusPanel } from "@/components/status-panel";
import type { AppEnvironment, DeploymentStatus } from "@/lib/deployment";

export interface LaunchConsoleProps {
  initialStatus: DeploymentStatus;
}

interface StatusResponse extends DeploymentStatus {
  requestId: string;
  serverTime: string;
}

type PingState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; latencyMs: number; requestId: string }
  | { kind: "error"; message: string };

const environments = new Set<AppEnvironment>([
  "production",
  "staging",
  "preview",
  "local",
]);

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function statusFromPayload(
  payload: Partial<StatusResponse>,
  fallback: DeploymentStatus,
): DeploymentStatus {
  const environment = environments.has(payload.environment as AppEnvironment)
    ? (payload.environment as AppEnvironment)
    : fallback.environment;

  return {
    environment,
    projectId: stringOr(payload.projectId, fallback.projectId),
    region: stringOr(payload.region, fallback.region),
    commitSha: stringOr(payload.commitSha, fallback.commitSha),
    stack: stringOr(payload.stack, fallback.stack),
    canonicalHost: stringOr(payload.canonicalHost, fallback.canonicalHost),
    service: stringOr(payload.service, fallback.service),
    revision: stringOr(payload.revision, fallback.revision),
  };
}

export function LaunchConsole({ initialStatus }: LaunchConsoleProps) {
  const [status, setStatus] = useState(initialStatus);
  const [ping, setPing] = useState<PingState>({ kind: "idle" });
  const [windStrength, setWindStrength] = useState(1);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );

  const deploymentUrl =
    initialStatus.environment === "local" &&
    initialStatus.canonicalHost === "localhost:3000"
      ? "http://localhost:3000"
      : `https://${initialStatus.canonicalHost}`;

  async function pingDeployment() {
    setPing({ kind: "pending" });
    const startedAt = performance.now();

    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("status request failed");
      }

      const payload = (await response.json()) as Partial<StatusResponse>;
      if (typeof payload.requestId !== "string" || payload.requestId.length < 8) {
        throw new Error("status response is missing a request id");
      }

      setStatus((current) => statusFromPayload(payload, current));
      setPing({
        kind: "success",
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        requestId: payload.requestId.slice(0, 8),
      });
    } catch {
      setPing({
        kind: "error",
        message: "Could not reach this deployment. Try again in a moment.",
      });
    }
  }

  async function copyDeploymentUrl() {
    try {
      await navigator.clipboard.writeText(deploymentUrl);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const shellStyle = {
    "--wind-speed": windStrength,
  } as CSSProperties;

  return (
    <main className="launch-shell" style={shellStyle}>
      <div className="wind-layer wind-layer-one" aria-hidden="true" />
      <div className="wind-layer wind-layer-two" aria-hidden="true" />

      <header className="site-header">
        <a className="brand" href={deploymentUrl} aria-label="Windrun home">
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <span>windrun.ai</span>
        </a>
        <span className="header-coordinate">{status.region} · Cloud Run</span>
      </header>

      <div className="console-layout">
        <section className="hero" aria-labelledby="launch-heading">
          <p className="eyebrow">Transmission received</p>
          <h1 id="launch-heading">
            Hello from the
            <span> other side of the cloud.</span>
          </h1>
          <p className="hero-copy">
            A small Next.js signal, carried by Cloud Run and steered entirely
            by Pulumi. The page is alive, the route is healthy, and the wind is
            yours to tune.
          </p>

          <div className="action-row">
            <button
              className="button button-primary"
              type="button"
              onClick={pingDeployment}
              disabled={ping.kind === "pending"}
            >
              {ping.kind === "pending" ? "Pinging deployment…" : "Ping this deployment"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={copyDeploymentUrl}
            >
              Copy deployment URL
            </button>
          </div>

          <div className="interaction-status" aria-live="polite">
            {ping.kind === "pending" && <p>Sending a live status request…</p>}
            {ping.kind === "success" && (
              <p>
                Signal returned in <strong>{ping.latencyMs} ms</strong>
                <span aria-hidden="true"> · </span>
                request <code>{ping.requestId}</code>
              </p>
            )}
            {copyState === "copied" && <p>Deployment URL copied.</p>}
            {copyState === "error" && <p>Copy unavailable in this browser.</p>}
          </div>
          {ping.kind === "error" && <p role="alert">{ping.message}</p>}

          <div className="wind-control">
            <div>
              <label htmlFor="wind-strength">Wind strength</label>
              <p>Adjust the atmosphere without touching the deployment.</p>
            </div>
            <input
              id="wind-strength"
              type="range"
              min="0.4"
              max="2"
              step="0.1"
              value={windStrength}
              onChange={(event) => setWindStrength(Number(event.target.value))}
            />
            <output htmlFor="wind-strength">{windStrength.toFixed(1)}×</output>
          </div>
        </section>

        <StatusPanel status={status} />
      </div>

      <footer>
        <span>Infrastructure as code. Signal as proof.</span>
        <span>{status.canonicalHost}</span>
      </footer>
    </main>
  );
}
