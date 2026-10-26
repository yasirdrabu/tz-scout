import { expect, test, type Page } from "@playwright/test";

// Signs in with the dev sign-in and opens every page in the left nav. Expects the seeded data.

async function signIn(page: Page, name: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
}

const PAGES: [string, RegExp][] = [
  ["buyers", /Act now/],
  ["buyers/pulls", /target buyers/],
  ["buyers/signals", /Hiring/],
  ["offerings", /AI Opportunity Map/],
  ["offerings/case-studies", /Taurex/],
  ["segments", /Segments/],
  ["tests", /Message tests|test batch/i],
  ["tests/library", /library|winners/i],
  ["funnel", /Cost per won client/i],
  ["leads", /Leads/],
  ["meetings", /Meetings/],
  ["scorecard", /scorecard/i],
  ["settings", /settings/i],
  ["settings?tab=buyers", /fit/i],
];

test("owner can open every page", async ({ page }) => {
  await signIn(page, "Zach Wiant");
  for (const [path, text] of PAGES) {
    const res = await page.goto(`/c/taazaa/${path}`);
    expect(res?.status(), path).toBe(200);
    await expect(page.locator("main")).toContainText(text);
    await expect(page.getByText("This page hit a problem")).toHaveCount(0);
  }
});

test("sales sees leads and meetings but not offerings in the nav", async ({ page }) => {
  await signIn(page, "Sample SDR");
  await expect(page.getByRole("link", { name: "Leads" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Offerings" })).toHaveCount(0);
});

test("a member of one company can't open another company", async ({ page }) => {
  await signIn(page, "Northwind Owner");
  const res = await page.goto("/c/taazaa/offerings");
  expect(res?.status()).toBe(404);
});
