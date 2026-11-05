import { expect, test, type Page } from '@playwright/test';
import { mainNav, shows, signInAs } from './helpers';

// Costs (R3a, screens.md §18): an owner sets the AI usage budget $10 above what the month has spent and adds a
// manual AI usage cost of $12, so Costs shows the paused banner and "Over by $2.00"; raising the budget clears it.
// A seller has no Costs. The level is worked out in the same transaction that adds the line, so a reload shows it.
// The test voids its line at the end and works from the month's starting spend, so it can run again on the same data.

const OWNER = 'zach.wiant@taazaa.com';
const SELLER = 'ash@taazaa.com';

const PAUSED = 'AI usage is paused: it is over 110% of its';

const aiRow = (page: Page) => page.getByRole('region', { name: 'Monthly budgets' }).getByText('AI usage').locator('xpath=ancestor::li[1]');

/** The AI usage spend so far this month, in cents, as the API reports it. */
async function aiSpendCents(page: Page): Promise<number> {
  const res = await page.request.get('/api/v1/costs/summary', { headers: { 'x-scout-tenant': 'taazaa' } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { categories: { key: string; spend_month_cents: number }[] };
  return body.categories.find((c) => c.key === 'ai_usage')!.spend_month_cents;
}

async function setAiBudget(page: Page, cents: number) {
  await page.getByRole('button', { name: 'Edit budgets' }).click();
  await page.getByLabel('AI usage budget').fill((cents / 100).toFixed(2));
  await page.getByRole('button', { name: 'Save budgets' }).click();
  await shows(page, /^Budgets saved\. Monthly total /);
}

test('a budget crossed by a manual cost pauses AI usage, and raising the budget clears it', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/t/taazaa/costs');
  await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
  const start = await aiSpendCents(page);
  let added = false;

  try {
    // Budget: the spend so far plus $10. Then a $12 line takes the month to $2 over it.
    await setAiBudget(page, start + 1000);
    await expect(page.getByText(PAUSED)).toHaveCount(0);

    await page.getByRole('button', { name: 'Add cost' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add cost' });
    await dialog.getByLabel('Category').selectOption('ai_usage');
    await dialog.getByLabel('Amount').fill('12');
    await dialog.getByLabel('Note').fill('E2E overage');
    await dialog.getByRole('button', { name: 'Add cost' }).click();
    await shows(page, 'Cost added.');
    added = true;

    await expect(page.getByText(PAUSED)).toBeVisible();
    await expect(aiRow(page)).toContainText('Over by $2.00');

    // The same pause shows on Settings > Integrations.
    await page.goto('/t/taazaa/settings/integrations');
    await expect(page.getByText(PAUSED)).toBeVisible();

    await page.goto('/t/taazaa/costs');
    await setAiBudget(page, start + 2000);
    await expect(page.getByText(PAUSED)).toHaveCount(0);
    await expect(aiRow(page)).not.toContainText('Over by');
  } finally {
    // Void the added line so the month is back where it started.
    if (added) {
      await page.goto('/t/taazaa/costs');
      const row = page.getByRole('row').filter({ hasText: 'E2E overage' }).first();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Void' }).click();
      await page.getByLabel('Reason').fill('E2E cleanup');
      await page.getByRole('button', { name: 'Void cost' }).click();
      await shows(page, 'Cost voided.');
    }
  }
});

test('a seller has no Costs in the navigation', async ({ page }) => {
  await signInAs(page, SELLER);
  await page.goto('/t/taazaa/accounts');
  await expect(mainNav(page).getByRole('link', { name: 'All accounts' })).toBeVisible();
  await expect(mainNav(page).getByRole('link', { name: 'Costs' })).toHaveCount(0);
});
