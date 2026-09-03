import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server.js";
import { DEFAULT_CONFIG } from "../config.js";
import { __resetProxyStorageForTests } from "../storage/factory.js";

interface AdminRoute {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const routes: readonly AdminRoute[] = [
  { method: "POST", path: "/v3/instance/proxy-destroy", body: { instance_id: "demo" } },
  { method: "GET", path: "/v3/admin/rate-limits" },
  { method: "PUT", path: "/v3/admin/rate-limits", body: { input_tpm: 100, qpm: 10 } },
  { method: "DELETE", path: "/v3/admin/rate-limits", body: {} },
  { method: "POST", path: "/v3/session/refresh-cache", body: { session_key: "demo" } },
  { method: "POST", path: "/v3/session/force-archive-skill", body: { session_key: "demo" } },
];

function appWithAdminKey(apiKey: string) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.admin.apiKey = apiKey;
  config.storage = { ...config.storage, enabled: true, backend: "memory" };
  return createApp(config);
}

async function request(
  app: ReturnType<typeof createApp>,
  route: AdminRoute,
  authorization?: string,
): Promise<Response> {
  return app.request(`http://local${route.path}`, {
    method: route.method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    ...(route.body ? { body: JSON.stringify(route.body) } : {}),
  });
}

describe("administration route authentication", () => {
  afterEach(() => __resetProxyStorageForTests());

  it("fails closed when the administrator key is not configured", async () => {
    const app = appWithAdminKey("");
    for (const route of routes) {
      expect((await request(app, route)).status, `${route.method} ${route.path}`).toBe(503);
    }
  });

  it("rejects missing and invalid Bearer tokens on every administration route", async () => {
    const app = appWithAdminKey("admin-secret");
    for (const route of routes) {
      expect((await request(app, route)).status, `${route.method} ${route.path} missing`).toBe(401);
      expect(
        (await request(app, route, "Bearer wrong-secret")).status,
        `${route.method} ${route.path} invalid`,
      ).toBe(401);
    }
  });

  it("allows a valid Bearer token to reach the requested operation", async () => {
    const app = appWithAdminKey("admin-secret");
    const response = await request(app, routes[0], "Bearer admin-secret");
    expect(response.status).toBe(200);
  });
});
