import { expect, test } from "@playwright/test";

// Every page must render with real, mostly empty data and nothing on sample mode.
const PAGES = ["buyers", "buyers/pulls", "buyers/signals", "offerings", "offerings/case-studies", "segments", "tests", "tests/library", "funnel", "leads", "meetings", "scorecard", "settings", "settings?tab=integrations", "settings?tab=buyers"];

test("every page renders on real data", async ({ page }) => {
  await page.goto("/signin");
  await page.getByRole("button", { name: /Zach Wiant/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  const problems: string[] = [];
  for (const p of PAGES) {
    const res = await page.goto(`/c/taazaa/${p}`);
    const boundary = await page.getByText("This page hit a problem").count();
    if (res?.status() !== 200 || boundary) problems.push(`${p}: status ${res?.status()}${boundary ? ", error boundary: " + (await page.locator("main").innerText()).slice(0, 200) : ""}`);
  }
  expect(problems).toEqual([]);
});
