import { test, expect } from "@playwright/test";

test("not watching by default — no nearby section until started", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("Not watching — start to see nearby drivers (stream GPS via scripts/stream-gps.sh)."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /start watching/i })).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toHaveCount(0);
});

test("starting watch queries nearby (200) and shows the nearby section", async ({ page }) => {
  await page.goto("/");

  const nearbyReq = page.waitForResponse(
    (r) =>
      /\/api\/read\/drivers\/nearby\?/.test(r.url()) &&
      r.request().method() === "GET" &&
      r.status() === 200,
    { timeout: 30_000 },
  );

  await page.getByRole("button", { name: /start watching/i }).click();

  const res = await nearbyReq;
  expect(res.status()).toBe(200);

  await expect(page.getByText("Watching — live nearby")).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toBeVisible();
  // Nearby readout renders (table or its empty state) once a refresh completes.
  await expect(page.getByText(/nearby drivers \(/i)).toBeVisible();
});
