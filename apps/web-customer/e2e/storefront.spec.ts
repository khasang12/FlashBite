import { test, expect, request } from "@playwright/test";

const WRITE_API = "http://localhost:3001";

/**
 * Selector notes (verified against real DOM):
 *
 * - Add button: aria-label="add {item.name}" on a <Button size="icon"> in menu page
 * - Cart: <Link href="/checkout"><Button>Cart ({count})</Button></Link> — Playwright
 *   resolves the link's accessible name from its button child text "Cart (N)"
 * - Name input: placeholder="Your name" + aria-label="Your name" on <Input>
 * - Place order: <Button> text is "Place order · €X.XX" — /Place order/ regex matches
 * - Status: <StatusPill> renders {status} as raw text inside a <span>
 */

test("place an order and see it reach PLACED, then ACCEPTED after merchant accept", async ({
  page,
}) => {
  await page.goto("/");

  // Add "Pizza Margherita" from the "All items" grid (aria-label on Button size="icon")
  await page.getByRole("button", { name: /add Pizza Margherita/i }).click();

  // Cart header link: <a href="/checkout"> wrapping <button>Cart (1)</button>
  await page.getByRole("link", { name: /Cart \(/ }).click();

  await expect(page).toHaveURL(/\/checkout/);
  await page.getByPlaceholder("Your name").fill("e2e-alice");
  await page.getByRole("button", { name: /Place order/ }).click();

  await expect(page).toHaveURL(/\/orders\//);
  const orderId = page.url().split("/orders/")[1];
  await expect(page.getByText("PLACED")).toBeVisible({ timeout: 30_000 });

  // Merchant accept via write-api signals the saga workflow -> ACCEPTED
  const api = await request.newContext();
  try {
    const res = await api.post(`${WRITE_API}/orders/${orderId}/accept`, {
      headers: { "X-Tenant-ID": "berlin" },
    });
    expect(res.status()).toBe(202);
  } finally {
    await api.dispose();
  }

  await expect(page.getByText("ACCEPTED")).toBeVisible({ timeout: 45_000 });
});

test("tenant isolation: a berlin order is not visible to tokyo", async () => {
  const orderId = crypto.randomUUID();

  const write = await request.newContext({ baseURL: "http://localhost:3001" });
  try {
    const created = await write.post("/orders", {
      headers: { "X-Tenant-ID": "berlin", "Content-Type": "application/json" },
      data: { orderId, customerId: "iso-test", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
    });
    expect(created.status()).toBe(201);
  } finally {
    await write.dispose();
  }

  const read = await request.newContext({ baseURL: "http://localhost:3002" });
  try {
    // berlin sees the order once the projection catches up (poll briefly)
    let berlinStatus = 0;
    for (let i = 0; i < 20 && berlinStatus !== 200; i++) {
      const r = await read.get(`/orders/${orderId}`, { headers: { "X-Tenant-ID": "berlin" } });
      berlinStatus = r.status();
      if (berlinStatus !== 200) await new Promise((res) => setTimeout(res, 1000));
    }
    expect(berlinStatus).toBe(200);

    // tokyo must NOT see the berlin order
    const tokyo = await read.get(`/orders/${orderId}`, { headers: { "X-Tenant-ID": "tokyo" } });
    expect(tokyo.status()).toBe(404);
  } finally {
    await read.dispose();
  }
});
