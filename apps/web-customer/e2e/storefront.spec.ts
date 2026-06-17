import { test, expect, request } from "@playwright/test";
import { apiToken, loginViaUI } from "./auth";

const WRITE_API = "http://localhost:3001";
const READ_API = "http://localhost:3002";

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
  request,
}) => {
  await loginViaUI(page, "Berlin customer");

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
  const merchantToken = await apiToken(request, "merchant@berlin.test");
  const res = await request.post(`${WRITE_API}/orders/${orderId}/accept`, {
    headers: { Authorization: `Bearer ${merchantToken}` },
  });
  expect(res.status()).toBe(202);

  await expect(page.getByText("ACCEPTED")).toBeVisible({ timeout: 45_000 });
});

test("tenant isolation: a berlin order is not visible to tokyo", async ({ request }) => {
  const orderId = crypto.randomUUID();

  const berlinToken = await apiToken(request, "customer@berlin.test");
  const created = await request.post(`${WRITE_API}/orders`, {
    headers: { Authorization: `Bearer ${berlinToken}`, "Content-Type": "application/json" },
    data: { orderId, customerId: "iso-test", items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200 },
  });
  expect(created.status()).toBe(201);

  // berlin sees the order once the projection catches up (poll briefly)
  let berlinStatus = 0;
  for (let i = 0; i < 20 && berlinStatus !== 200; i++) {
    const r = await request.get(`${READ_API}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${berlinToken}` },
    });
    berlinStatus = r.status();
    if (berlinStatus !== 200) await new Promise((res) => setTimeout(res, 1000));
  }
  expect(berlinStatus).toBe(200);

  // tokyo must NOT see the berlin order
  const tokyoToken = await apiToken(request, "customer@tokyo.test");
  const tokyo = await request.get(`${READ_API}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${tokyoToken}` },
  });
  expect(tokyo.status()).toBe(404);
});
