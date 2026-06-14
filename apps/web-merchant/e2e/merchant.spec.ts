import { test, expect, request } from "@playwright/test";

const WRITE_API = "http://localhost:3001";

test("an incoming order appears, can be accepted, and flips to ACCEPTED", async ({ page }) => {
  await page.goto("/");

  const orderId = crypto.randomUUID();
  const api = await request.newContext();
  try {
    const res = await api.post(`${WRITE_API}/orders`, {
      headers: { "X-Tenant-ID": "berlin", "Content-Type": "application/json" },
      data: { orderId, customerId: "e2e-merchant", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
    });
    expect(res.status()).toBe(201);

    const shortId = `#${orderId.slice(0, 8)}`;

    // Scope to table row to avoid matching the SheetTitle ("Order #xxxxxxxx") if it opens
    const row = page.getByRole("row").filter({ hasText: shortId });
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.click();
    await page.getByRole("button", { name: "Accept" }).click();

    // After accept the sheet closes; the row remains with the same short id and an ACCEPTED pill.
    await expect(row.getByText("ACCEPTED")).toBeVisible({ timeout: 45_000 });
  } finally {
    await api.dispose();
  }
});

test("status filter and search controls are present", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Search order id / customer")).toBeVisible();
  await expect(page.getByLabel("Filter by status")).toBeVisible();
});
