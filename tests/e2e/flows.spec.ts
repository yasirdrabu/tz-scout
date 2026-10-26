import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// Live flows through the UI and background jobs on mocks: a form webhook to a validated lead to a
// booked call, and an approved message test launched to verdicts.

const secret = (fs.readFileSync(".env", "utf8").match(/^WEBHOOK_SECRET="?([^"\n]+)"?/m) ?? [])[1] ?? "";

async function signIn(page: Page, name: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
}

test("form webhook to validated lead to booked call", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const res = await request.post("/api/webhooks/form/taazaa", {
    headers: { "x-webhook-secret": secret },
    data: { email: `dana.reyes+${tag}@keystone-ridge-properties.com`, firstName: "Dana", lastName: "Reyes", title: "Chief Operating Officer", company: "Keystone Ridge Properties", timeline: "3m", offering: "ai-opportunity-map", smsConsent: true, phone: "+15555550100" },
  });
  expect(res.status()).toBe(202);
  const { leadId } = await res.json();

  expect((await request.post("/api/webhooks/form/taazaa", { headers: { "x-webhook-secret": "wrong" }, data: {} })).status()).toBe(401);

  await signIn(page, "Zach Wiant");
  await page.goto(`/c/taazaa/leads/${leadId}`);
  await expect(page.locator("main")).toContainText("Validated", { timeout: 60_000 });
  await expect(page.locator("main")).toContainText("Work email");

  // The booking link points at the public booking page.
  await page.goto(`/book/taazaa/${leadId}`);
  await page.locator("form button").first().click();
  await expect(page.locator("body")).toContainText(/booked/i);
  await page.goto(`/c/taazaa/leads/${leadId}`);
  await expect(page.locator("main")).toContainText(/reminder/i);
});

test("approved batch launches and verdicts arrive", async ({ page }) => {
  page.on("dialog", (d) => d.accept()); // launch asks for confirmation
  await signIn(page, "Zach Wiant");
  await page.goto("/c/taazaa/tests?status=APPROVED");
  await page.getByRole("link", { name: /Batch 1/ }).first().click();
  await page.getByRole("button", { name: /Launch/ }).click();
  await expect(page.locator("main")).toContainText(/running/i);
  await expect(page.locator("main")).toContainText(/Pass|Not enough data|Fail/, { timeout: 120_000 });
  await expect(page.locator("main")).toContainText(/complete/i, { timeout: 120_000 });
});
