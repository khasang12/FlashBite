import { APIRequestContext, Page, expect } from "@playwright/test";

export async function apiToken(
  request: APIRequestContext,
  email: string,
  password = "devpassword",
): Promise<string> {
  const res = await request.post("http://localhost:3003/auth/login", {
    headers: { "Content-Type": "application/json" },
    data: { email, password },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Drive the AuthGate login form via the demo quick-pick button, then Sign in. */
export async function loginViaUI(page: Page, demoLabel: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: demoLabel }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}
