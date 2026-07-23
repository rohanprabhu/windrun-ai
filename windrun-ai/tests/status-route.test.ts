import { expect, it } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { GET as status } from "@/app/api/status/route";

it("returns a cache-free health response", async () => {
  const response = await health();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("cache-control")).toContain("no-store");
});

it("returns cache-free status with a bounded request identifier", async () => {
  const response = await status(
    new Request("https://ignored.test/api/status", {
      headers: { host: "app.staging.windrun.ai" },
    }),
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(body.environment).toBeDefined();
  expect(body.projectId).toBeDefined();
  expect(body.region).toBeDefined();
  expect(body.stack).toBeDefined();
  expect(body.canonicalHost).toBe("app.staging.windrun.ai");
});
