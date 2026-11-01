import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { shows, signInAs } from './helpers';

// Main flow 3 (screens.md): an operator adds a list source, imports a list into it, watches it
// resolve and resolves a waiting row by adding a website. fixtures/list.csv has four companies, two
// of them without a website. The worker runs in the background (global-setup.ts).

const OPERATOR = 'riley@taazaa.com';

test('an operator adds a list source, imports a list into it and resolves a waiting row', async ({ page }) => {
  await signInAs(page, OPERATOR);
  const name = `E2E list ${Date.now()}`;

  await page.goto('/t/taazaa/sources');
  await page.getByRole('button', { name: 'Add a source' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /List or research sheet/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('combobox', { name: 'Under' }).selectOption({ label: 'Riley' });
  await dialog.getByRole('button', { name: 'Add source' }).click();
  await shows(page, `Added ${name}.`);
  await dialog.getByRole('link', { name: 'Upload the first list' }).click();

  // Upload: the new list is preselected.
  await page.waitForURL(/\/batches\/import\?/);
  await expect(page.getByRole('combobox', { name: 'Source' })).toHaveValue(/^src_/);
  await expect(page.getByRole('combobox', { name: 'Source' }).locator('option:checked')).toHaveText(new RegExp(`^${name}`));
  await page.getByLabel('File to import').setInputFiles(join(__dirname, 'fixtures/list.csv'));
  await page.getByRole('textbox', { name: 'Batch notes' }).fill('E2E import');
  await page.getByRole('button', { name: 'Upload' }).click();

  // Match: Company and Website are suggested.
  await expect(page.getByText('Match your columns')).toBeVisible();
  for (const header of ['Company', 'Website']) {
    const row = page.getByRole('row').filter({ has: page.getByRole('combobox', { name: `Scout field for ${header}` }) });
    await expect(row.getByText('Suggested')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Continue' }).click();

  // Confirm: two rows are held.
  await expect(page.getByText('2 rows have no website')).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows and hold 2' }).click();

  // Resolve.
  await expect(page.getByText(/^Batch bat_\w+ created$/)).toBeVisible();
  await expect(page.getByText(/^Done\. /)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/2 rows need you\.$/)).toBeVisible();
  await page.getByRole('link', { name: 'Open the 2 waiting rows' }).click();

  // Batch detail, Waiting tab: add a website to the first row.
  await page.waitForURL(/\/batches\/bat_\w+\?tab=waiting/);
  const batchUrl = page.url();
  const input = page.getByRole('textbox', { name: /^Website for / }).first();
  const company = (await page.locator(`label[for="${await input.getAttribute('id')}"]`).textContent())!.replace(/^Website for /, '');
  await input.fill(`${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example`);
  await input.locator('xpath=ancestor::form').getByRole('button', { name: 'Resolve' }).click();
  await shows(page, `${company} resolved.`);
  // The worker resolves the row; the Waiting tab then counts one.
  await expect(async () => {
    await page.goto(batchUrl);
    await expect(page.getByRole('tab', { name: 'Waiting 1' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  // Back on the source page: the Batches tab lists the batch, and Sent counts the resolved accounts.
  const batchId = new URL(batchUrl).pathname.split('/').pop()!;
  await page.goto('/t/taazaa/sources');
  await page.getByRole('link', { name }).click();
  await page.getByRole('tab', { name: /^Batches/ }).click();
  await expect(page.getByRole('link', { name: batchId })).toBeVisible();
  await expect(async () => {
    await page.reload();
    const sent = page.getByRole('list', { name: 'Source numbers' }).getByRole('listitem').filter({ hasText: 'Sent' });
    const value = Number((await sent.locator('span').nth(1).textContent()) ?? '0');
    expect(value).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 60_000 });
});
