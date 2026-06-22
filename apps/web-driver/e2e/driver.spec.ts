import { test, expect } from "@playwright/test";
import { loginViaUI } from "./auth";

test("offline by default — prompts to go online, no nearby section", async ({ page }) => {
  await loginViaUI(page, "Berlin drv-1");
  await expect(page.getByText("You're offline. Go online to receive delivery offers.")).toBeVisible();
  await expect(page.getByRole("button", { name: /go online/i })).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toHaveCount(0);
});

test("going online queries nearby (200) and shows the nearby section + waiting state", async ({ page }) => {
  await loginViaUI(page, "Berlin drv-1");

  const onlineReq = page.waitForResponse(
    (r) => /\/api\/read\/drivers\/drv-1\/online$/.test(r.url()) && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  const nearbyReq = page.waitForResponse(
    (r) => /\/api\/read\/drivers\/nearby\?/.test(r.url()) && r.request().method() === "GET" && r.status() === 200,
    { timeout: 30_000 },
  );

  await page.getByRole("button", { name: /go online/i }).click();

  expect((await onlineReq).status()).toBe(202);
  expect((await nearbyReq).status()).toBe(200);

  await expect(page.getByText(/waiting for an offer/i)).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toBeVisible();
});
