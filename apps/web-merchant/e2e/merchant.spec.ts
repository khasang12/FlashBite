import { test, expect } from "@playwright/test";
import { apiToken, loginViaUI } from "./auth";

const WRITE_API = "http://localhost:3001";
const READ_API = "http://localhost:3002";

test("an incoming order appears, can be accepted, and flips to ACCEPTED", async ({
  page,
  request,
}) => {
  await loginViaUI(page, "Berlin merchant");

  const orderId = crypto.randomUUID();
  const customerToken = await apiToken(request, "customer@berlin.test");
  const res = await request.post(`${WRITE_API}/orders`, {
    headers: { Authorization: `Bearer ${customerToken}`, "Content-Type": "application/json" },
    data: { orderId, customerId: "e2e-merchant", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
  });
  expect(res.status()).toBe(201);

  // Customer confirms payment (3c-iii gate); wait until the saga authorizes so the
  // merchant's accept gate opens and the detail sheet shows the action buttons.
  let confirmed = 0;
  for (let i = 0; i < 30 && confirmed !== 202; i++) {
    const c = await request.post(`${WRITE_API}/orders/${orderId}/confirm-payment`, { headers: { Authorization: `Bearer ${customerToken}` } });
    confirmed = c.status();
    if (confirmed !== 202) await new Promise((r) => setTimeout(r, 500));
  }
  expect(confirmed).toBe(202);
  let paid = false;
  for (let i = 0; i < 30 && !paid; i++) {
    const r = await request.get(`${READ_API}/orders/${orderId}/payment`, { headers: { Authorization: `Bearer ${customerToken}` } });
    paid = r.ok() && (await r.json()).status === "AUTHORIZED";
    if (!paid) await new Promise((res) => setTimeout(res, 500));
  }
  expect(paid).toBe(true);

  const shortId = `#${orderId.slice(0, 8)}`;

  // Scope to table row to avoid matching the SheetTitle ("Order #xxxxxxxx") if it opens
  const row = page.getByRole("row").filter({ hasText: shortId });
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.click();
  await page.getByRole("button", { name: "Accept" }).click();

  // After accept the sheet closes; the row remains with the same short id and an ACCEPTED pill.
  await expect(row.getByText("ACCEPTED")).toBeVisible({ timeout: 45_000 });
});

test("status filter and search controls are present", async ({ page }) => {
  await loginViaUI(page, "Berlin merchant");
  await expect(page.getByPlaceholder("Search order id / customer")).toBeVisible();
  await expect(page.getByLabel("Filter by status")).toBeVisible();
});
