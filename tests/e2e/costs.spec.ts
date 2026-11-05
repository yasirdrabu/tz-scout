import { expect, test, type Page } from '@playwright/test';
import { mainNav, shows, signInAs } from './helpers';

// Costs (R3a, screens.md §18): from the month's AI usage spend s, an owner sets the AI usage budget B to s + $10 and
// adds a manual AI usage cost L big enough that s + L is at least 110% of B, so Costs shows the paused banner and
// "Over by {s + L - B}"; raising the budget above s + L clears it. A seller has no Costs. The level is worked out in
// the same transaction that adds the line, so a reload shows it. The test voids its line and puts the original budget
// back at the end, and works from the starting spend whatever it is, so it can run again on the same data.

const OWNER = 'zach.wiant@taazaa.com';
const SELLER = 'ash@taazaa.com';

const PAUSED = 'AI usage is paused: it is over 110% of its';

const aiRow = (page: Page) => page.getByRole('region', { name: 'Monthly budgets' }).getByText('AI usage').locator('xpath=ancestor::li[1]');
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(cents / 100);

/** AI usage this month, in cents, as the API reports it: the spend so far and the budget (0 for none). */
async function aiUsage(page: Page): Promise<{ spent: number; budget: number }> {
  const res = await page.request.get('/api/v1/costs/summary', { headers: { 'x-scout-tenant': 'taazaa' } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { categories: { key: string; spend_month_cents: number; budget_cents: number | null }[] };
  const ai = body.categories.find((c) => c.key === 'ai_usage')!;
  return { spent: ai.spend_month_cents, budget: ai.budget_cents ?? 0 };
}

async function setAiBudget(page: Page, cents: number) {
  await page.getByRole('button', { name: 'Edit budgets' }).click();
  await page.getByLabel('AI usage budget').fill(cents === 0 ? '' : (cents / 100).toFixed(2));
  await page.getByRole('button', { name: 'Save budgets' }).click();
  await shows(page, /^Budgets saved\. Monthly total /);
}

test('a budget crossed by a manual cost pauses AI usage, and raising the budget clears it', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/t/taazaa/costs');
  await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
  const { spent: s, budget: original } = await aiUsage(page);
  const budget = s + 1000;
  // Enough that s + line is at least 110% of the budget, plus a dollar.
  const line = Math.ceil(1.1 * budget - s) + 100;
  let budgetChanged = false;
  let added = false;

  try {
    budgetChanged = true;
    await setAiBudget(page, budget);
    await expect(page.getByText(PAUSED)).toHaveCount(0);

    await page.getByRole('button', { name: 'Add cost' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add cost' });
    await dialog.getByLabel('Category').selectOption('ai_usage');
    await dialog.getByLabel('Amount').fill((line / 100).toFixed(2));
    await dialog.getByLabel('Note').fill('E2E overage');
    await dialog.getByRole('button', { name: 'Add cost' }).click();
    await shows(page, 'Cost added.');
    added = true;

    await expect(page.getByText(PAUSED)).toBeVisible();
    await expect(aiRow(page)).toContainText(`Over by ${usd(s + line - budget)}`);

    // The same pause shows on Settings > Integrations.
    await page.goto('/t/taazaa/settings/integrations');
    await expect(page.getByText(PAUSED)).toBeVisible();

    await page.goto('/t/taazaa/costs');
    await setAiBudget(page, (s + line) * 2);
    await expect(page.getByText(PAUSED)).toHaveCount(0);
    await expect(aiRow(page)).not.toContainText('Over by');
  } finally {
    // Void the added line and put the budget back, so the month is where it started.
    if (added || budgetChanged) await page.goto('/t/taazaa/costs');
    if (added) {
      const row = page.getByRole('row').filter({ hasText: 'E2E overage' }).first();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Void' }).click();
      await page.getByLabel('Reason').fill('E2E cleanup');
      await page.getByRole('button', { name: 'Void cost' }).click();
      await shows(page, 'Cost voided.');
    }
    if (budgetChanged) await setAiBudget(page, original);
  }
});

test('a seller has no Costs in the navigation', async ({ page }) => {
  await signInAs(page, SELLER);
  await page.goto('/t/taazaa/accounts');
  await expect(mainNav(page).getByRole('link', { name: 'All accounts' })).toBeVisible();
  await expect(mainNav(page).getByRole('link', { name: 'Costs' })).toHaveCount(0);
});
