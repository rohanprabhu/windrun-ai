import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LaunchConsole } from "@/components/launch-console";
import type { DeploymentStatus } from "@/lib/deployment";

const stagingStatus: DeploymentStatus = {
  environment: "staging",
  projectId: "windrun-ai-staging-20260712",
  region: "asia-south1",
  commitSha: "abcdef0",
  stack: "staging",
  canonicalHost: "app.staging.windrun.ai",
  service: "staging",
  revision: "staging-00001",
};

const localStatus: DeploymentStatus = {
  environment: "local",
  projectId: "local-project",
  region: "local",
  commitSha: "local",
  stack: "local",
  canonicalHost: "localhost:3000",
  service: "windrun-local",
  revision: "local",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...stagingStatus,
        requestId: "11111111-1111-1111-1111-111111111111",
        serverTime: "2026-07-12T00:00:00.000Z",
      }),
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("pings the deployment and exposes its request id and latency", async () => {
  const user = userEvent.setup();
  render(<LaunchConsole initialStatus={stagingStatus} />);

  expect(screen.getByText("Project ID")).toBeInTheDocument();
  expect(screen.getByText("windrun-ai-staging-20260712")).toBeInTheDocument();
  expect(screen.getByText("Region")).toBeInTheDocument();
  expect(screen.getByText("asia-south1")).toBeInTheDocument();

  await user.click(
    screen.getByRole("button", { name: "Ping this deployment" }),
  );

  expect(fetch).toHaveBeenCalledWith("/api/status", {
    cache: "no-store",
    signal: expect.any(AbortSignal),
  });
  expect(await screen.findByText("11111111")).toBeInTheDocument();
  expect(screen.getByText(/\d+ ms/)).toBeInTheDocument();
});

it("aborts an unresponsive ping at its deadline and restores an accessible error state", async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementationOnce(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  render(<LaunchConsole initialStatus={stagingStatus} />);

  const button = screen.getByRole("button", {
    name: "Ping this deployment",
  });
  fireEvent.click(button);

  const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(button).toBeDisabled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000);
  });

  expect(signal?.aborted).toBe(true);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach this deployment",
  );
  expect(button).toBeEnabled();
});

it("clears the abort deadline after a successful ping", async () => {
  vi.useFakeTimers();
  render(<LaunchConsole initialStatus={stagingStatus} />);

  fireEvent.click(
    screen.getByRole("button", { name: "Ping this deployment" }),
  );

  const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText("11111111")).toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000);
  });

  expect(signal?.aborted).toBe(false);
});

it("reports a failed ping through an accessible live region", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
  const user = userEvent.setup();
  render(<LaunchConsole initialStatus={stagingStatus} />);

  await user.click(
    screen.getByRole("button", { name: "Ping this deployment" }),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach this deployment",
  );
});

it("offers an accessible bounded wind control", () => {
  render(<LaunchConsole initialStatus={localStatus} />);
  const control = screen.getByRole("slider", { name: "Wind strength" });

  expect(control).toHaveAttribute("min", "0.4");
  expect(control).toHaveAttribute("max", "2");
  expect(control).toHaveAttribute("step", "0.1");

  fireEvent.change(control, { target: { value: "1.6" } });

  expect(control).toHaveValue("1.6");
  expect(screen.getByText("1.6×")).toBeInTheDocument();
});
