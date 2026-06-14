import { test, expect } from "@playwright/test";

test("offline by default — no nearby section until online", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("Offline — go online to start streaming your location."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /go online/i })).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toHaveCount(0);
});

test("going online streams a location ping (202) and shows the nearby section", async ({ page }) => {
  await page.goto("/");

  const ping = page.waitForResponse(
    (r) =>
      /\/api\/read\/drivers\/.+\/location$/.test(r.url()) &&
      r.request().method() === "POST" &&
      r.status() === 202,
    { timeout: 30_000 },
  );

  await page.getByRole("button", { name: /go online/i }).click();

  const res = await ping;
  expect(res.status()).toBe(202);

  await expect(page.getByText("Online — streaming GPS")).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toBeVisible();
  // Nearby readout renders (table or its empty state) once a refresh completes.
  await expect(page.getByText(/nearby drivers \(/i)).toBeVisible();
});
