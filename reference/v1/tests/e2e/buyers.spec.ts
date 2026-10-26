import { expect, test, type Page } from "@playwright/test";

// Buyers list and account page render on the seeded data. Read only: no actions are clicked.

async function signIn(page: Page, name: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
}

test("buyers list and an account page render", async ({ page }) => {
  await signIn(page, "Zach Wiant");

  await page.goto("/c/taazaa/buyers");
  const main = page.locator("main");
  await expect(main).toContainText("Buyers");
  await expect(main).not.toContainText("This page hit a problem");
  await expect(main).toContainText("Act now");
  await expect(main.locator("tbody tr").first()).toBeVisible();

  for (const tier of ["good_fit", "watch", "not_fit", "all"]) {
    await page.goto(`/c/taazaa/buyers?tier=${tier}`);
    await expect(main).not.toContainText("This page hit a problem");
  }

  await page.goto("/c/taazaa/buyers?q=northgate&tier=all");
  await expect(main).toContainText("Northgate Freight");
  await main.getByRole("link", { name: "Northgate Freight" }).click();
  await page.waitForURL(/\/buyers\/[^/?]+$/);
  await expect(main).not.toContainText("This page hit a problem");
  await expect(main).toContainText("Offer match");
  await expect(main).toContainText("Modernization Blueprint");
  await expect(main).toContainText("Signals");
  await expect(main).toContainText("Contacts");
  await expect(main).toContainText("Tech stack");
});
