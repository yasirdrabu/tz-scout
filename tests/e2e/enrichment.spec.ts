import { expect, test, type Page } from '@playwright/test';
import { sendAccount, shows, signInAs } from './helpers';

// Enrichment requests (requests-and-approval.md ENR-E1-S1, ENR-E1-S3; screens.md §4c, §8a): a seller asks
// for the technical buyer on their account, the owner approves it in Enrichment, and the sample Apollo
// run lands a new person on the account. The test sends its own account and leaves every limit alone.

const OWNER = 'zach.wiant@taazaa.com';
// No other spec signs in as Mike, so his assignments are this test's alone.
const SELLER = 'mike@taazaa.com';

const accountIdOf = (page: Page) => new URL(page.url()).pathname.split('/').pop()!;

test('a seller asks for a technical buyer, the owner approves, and the person arrives', async ({ page, browser }) => {
  // A seller sees only their own accounts, so the owner assigns this one to Mike first. Mike signs in once
  // before, so his membership is active and he can be assigned.
  const seller = await (await browser.newContext()).newPage();
  await signInAs(seller, SELLER);
  await signInAs(page, OWNER);
  const name = `E2E Enrichment ${Date.now()}`;
  await sendAccount(page, name);
  await page.goto('/t/taazaa/queue');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name }).getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const id = accountIdOf(page);
  await page.getByRole('button', { name: 'Approve and assign' }).click();
  const assign = page.getByRole('dialog', { name: `Assign ${name}` });
  await assign.getByRole('radio', { name: /^Mike/ }).check();
  await assign.getByRole('button', { name: /^Assign to / }).click();
  await shows(page, `Sending ${name} to HubSpot.`);

  // The seller: Enrich, People for buying roles, Technical buyer only, a reason, Ask for approval.
  await seller.goto(`/t/taazaa/accounts/${id}`);
  await expect(seller.getByRole('heading', { level: 1, name })).toBeVisible();
  await seller.getByRole('button', { name: 'Enrich', exact: true }).click();
  const dialog = seller.getByRole('dialog', { name: `Enrich ${name}` });
  await expect(dialog.getByLabel('What to find')).toHaveValue('people_for_roles');
  const roles = dialog.getByRole('group', { name: 'Buying roles' });
  await expect(roles.getByRole('checkbox', { name: 'Technical buyer' })).toBeVisible();
  // Every role with no person is picked to start with; keep only Technical buyer.
  const labels = await roles.getByRole('checkbox').evaluateAll((els) => els.map((el) => el.closest('label')?.textContent?.trim() ?? ''));
  for (const label of labels) await roles.getByRole('checkbox', { name: label, exact: true }).setChecked(label === 'Technical buyer');
  await expect(roles.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(dialog.getByText(/^Up to 3 credits, about .+ · Sample$/)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Why is this worth it?' }).fill('No technical buyer yet, and they are hiring engineers.');
  await dialog.getByRole('button', { name: 'Ask for approval' }).click();
  await shows(seller, 'Sent for approval. A leader will see it in Enrichment requests.');
  await shows(seller, 'People for buying roles from Apollo: Waiting for approval');

  // The owner: Enrichment lists the request; Approve.
  await page.goto('/t/taazaa/enrichment');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(row).toContainText('People for buying roles');
  await expect(row).toContainText('Mike');
  await row.getByRole('button', { name: 'Approve' }).click();
  await shows(page, `Approved. Enrichment started for ${name}.`);

  // The run finishes in the worker; the notice refreshes while it runs.
  await page.goto(`/t/taazaa/accounts/${id}`);
  await expect(page.getByText(/^People for buying roles from Apollo: Found [1-9]\d*$/)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  const committee = page.getByRole('region', { name: 'Buying committee' });
  await expect(committee.getByRole('listitem').filter({ hasText: 'Technical buyer' }).first()).toBeVisible();
});
