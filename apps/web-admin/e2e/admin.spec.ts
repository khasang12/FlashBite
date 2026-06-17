import { test, expect } from "@playwright/test";
import { apiToken, loginViaUI } from "./auth";

const WRITE_API = "http://localhost:3001";

test("admin grid loads cross-tenant data via operator /admin/* endpoints and renders cards, charts, maps, table", async ({
  page,
  request,
}) => {
  // Seed one order per tenant so charts/table have data (write-api → projection → read model).
  const berlinToken = await apiToken(request, "customer@berlin.test");
  const tokyoToken = await apiToken(request, "customer@tokyo.test");

  for (const [token] of [
    [berlinToken],
    [tokyoToken],
  ] as [string][]) {
    const res = await request.post(`${WRITE_API}/orders`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { orderId: crypto.randomUUID(), customerId: "e2e-admin", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
    });
    expect(res.status()).toBe(201);
  }

  // The operator app makes a single cross-tenant call to /admin/orders and /admin/drivers
  // (not per-tenant /drivers/nearby fan-out).
  const adminCalls = new Set<string>();
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (
      (u.pathname === "/api/read/admin/orders" || u.pathname === "/api/read/admin/drivers") &&
      r.request().method() === "GET" &&
      r.status() === 200
    ) {
      adminCalls.add(u.pathname);
    }
  });

  await loginViaUI(page, "Operator");

  // Confirm at least one cross-tenant admin endpoint was called successfully.
  await expect.poll(() => adminCalls.size, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  await expect(page.getByText("Total GMV")).toBeVisible();
  await expect(page.getByText("GMV by tenant")).toBeVisible();
  await expect(page.getByText(/Recent orders \(/)).toBeVisible();
  // Both per-tenant map regions render (token-less fallback in CI).
  await expect(page.getByTestId("map-fallback-berlin").or(page.locator(".mapboxgl-map").nth(0))).toBeVisible();
  await expect(page.getByTestId("map-fallback-tokyo").or(page.locator(".mapboxgl-map").nth(1))).toBeVisible();
});
