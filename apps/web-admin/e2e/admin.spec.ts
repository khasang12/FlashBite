import { test, expect, request } from "@playwright/test";

const WRITE_API = "http://localhost:3001";

test("admin grid fans out across tenants and renders cards, charts, maps, table", async ({ page }) => {
  // Seed one order per tenant so charts/table have data (write-api → projection → read model).
  const api = await request.newContext();
  try {
    for (const tenant of ["berlin", "tokyo"]) {
      const res = await api.post(`${WRITE_API}/orders`, {
        headers: { "X-Tenant-ID": tenant, "Content-Type": "application/json" },
        data: { orderId: crypto.randomUUID(), customerId: "e2e-admin", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
      });
      expect(res.status()).toBe(201);
    }
  } finally {
    await api.dispose();
  }

  // Count distinct nearby fan-out calls (one per tenant — berlin & tokyo have distinct coords).
  const fanned = new Set<string>();
  page.on("response", (r) => {
    if (/\/api\/read\/drivers\/nearby\?/.test(r.url()) && r.request().method() === "GET" && r.status() === 200) {
      fanned.add(r.url());
    }
  });

  await page.goto("/");

  // Fan-out: a nearby query for each of the two tenants.
  await expect.poll(() => fanned.size, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  await expect(page.getByText("Total GMV")).toBeVisible();
  await expect(page.getByText("GMV by tenant")).toBeVisible();
  await expect(page.getByText(/Recent orders \(/)).toBeVisible();
  // Both per-tenant map regions render (token-less fallback in CI).
  await expect(page.getByTestId("map-fallback-berlin").or(page.locator(".mapboxgl-map").nth(0))).toBeVisible();
  await expect(page.getByTestId("map-fallback-tokyo").or(page.locator(".mapboxgl-map").nth(1))).toBeVisible();
});
