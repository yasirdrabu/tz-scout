import { expect, test } from '@playwright/test';
import { mainNav, shows, signInAs } from './helpers';

// Costs (R3a, screens.md §18): an owner sets the AI usage budget to $10 and adds a manual AI usage cost of $12, so
// Costs shows the paused banner and "Over by $2.00"; raising the budget to $20 clears it. A seller has no Costs.

const OWNER = 'zach.wiant@taazaa.com';
const SELLER = 'ash@taazaa.com';

const PAUSED = 'AI usage is paused: it is over 110% of its';

async function setAiBudget(page: import('@playwright/test').Page, dollars: string) {
  await page.getByRole('button', { name: 'Edit budgets' }).click();
  await page.getByLabel('AI usage budget').fill(dollars);
  await page.getByRole('button', { name: 'Save budgets' }).click();
  await shows(page, /^Budgets saved\. Monthly total /);
}

test('a budget crossed by a manual cost pauses AI usage, and raising the budget clears it', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/t/taazaa/costs');
  await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
  await expect(page.getByText(PAUSED)).toHaveCount(0);

  await setAiBudget(page, '10');

  await page.getByRole('button', { name: 'Add cost' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add cost' });
  await dialog.getByLabel('Category').selectOption('ai_usage');
  await dialog.getByLabel('Amount').fill('12');
  await dialog.getByLabel('Note').fill('E2E overage');
  await dialog.getByRole('button', { name: 'Add cost' }).click();
  await shows(page, 'Cost added.');

  await expect(page.getByText(PAUSED)).toBeVisible();
  const budgets = page.getByRole('region', { name: 'Monthly budgets' });
  await expect(budgets.getByText('AI usage').locator('xpath=ancestor::li[1]')).toContainText('Over by $2.00');

  // The same pause shows on Settings > Integrations.
  await page.goto('/t/taazaa/settings/integrations');
  await expect(page.getByText(PAUSED)).toBeVisible();

  await page.goto('/t/taazaa/costs');
  await setAiBudget(page, '20');
  await expect(page.getByText(PAUSED)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Monthly budgets' }).getByText('AI usage').locator('xpath=ancestor::li[1]')).not.toContainText('Over by');
});

test('a seller has no Costs in the navigation', async ({ page }) => {
  await signInAs(page, SELLER);
  await page.goto('/t/taazaa/accounts');
  await expect(mainNav(page).getByRole('link', { name: 'All accounts' })).toBeVisible();
  await expect(mainNav(page).getByRole('link', { name: 'Costs' })).toHaveCount(0);
});
