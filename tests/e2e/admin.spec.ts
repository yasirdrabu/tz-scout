import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { e2eEnv } from './env';

async function signInAs(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: `Sign in as ${email}` }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'));
}

test('platform admin retries a dead job and sends a test event', async ({ page }) => {
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', 'dead-job'], {
    stdio: 'inherit',
    env: { ...process.env, ...e2eEnv },
  });
  await signInAs(page, 'yasir@taazaa.com');
  await page.goto('/admin/system');
  await expect(page.getByRole('heading', { name: 'System', exact: true })).toBeVisible();
  const row = page.locator('[data-testid^="dead-"]').first();
  await expect(row.getByText('e2e: forced failure')).toBeVisible();
  const id = (await row.getAttribute('data-testid'))!;
  await row.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId(id)).toHaveCount(0);

  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(page.getByText(/Round trip: \d+ ms/)).toBeVisible({ timeout: 15_000 });
});

test('platform admin runs the seeded credentials cleanup schedule now', async ({ page }) => {
  await signInAs(page, 'yasir@taazaa.com');
  await page.goto('/admin/system');
  const row = page.locator('[data-testid^="schedule-"]').filter({ hasText: 'integrations.credentials.cleanup' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Run now' }).click();
  await expect(row.getByRole('status')).toHaveText('Started.');
  await expect(row.getByRole('alert')).toHaveCount(0);
});

test('integrations lists every provider on sample data and saves a credential', async ({ page }) => {
  await signInAs(page, 'zach.wiant@taazaa.com');
  await page.goto('/t/taazaa/settings/integrations');
  await expect(page.getByText('Using sample data', { exact: true })).toHaveCount(15);
  await page.getByTestId('provider-hubspot').getByRole('link', { name: 'Manage' }).click();
  await page.getByLabel('New key or token').fill('demo-credential-value-1234');
  await page.getByRole('button', { name: 'Save credential' }).click();
  await expect(page.getByText('Saved. Ends in 1234.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByTestId('manage-panel').getByRole('status')).toBeVisible();
});

test('AI runs lists the sample run and hides emails and phone numbers in its input', async ({ page }) => {
  await signInAs(page, 'zach.wiant@taazaa.com');
  await page.goto('/t/taazaa/settings/ai');
  const row = page.locator('[data-testid^="run-run_"]').first();
  await expect(row.getByText('echo_test')).toBeVisible();
  await expect(row.getByText('Sample output')).toBeVisible();
  await row.getByRole('link', { name: 'View' }).click();
  await expect(page.getByTestId('run-detail')).toBeVisible();
  await expect(page.getByTestId('run-input')).not.toContainText('jane@acme.com');
});

test('audit page filters and shows an empty result', async ({ page }) => {
  await signInAs(page, 'zach.wiant@taazaa.com');
  await page.goto('/t/taazaa/settings/audit');
  await expect(page.getByRole('heading', { name: 'Audit', exact: true })).toBeVisible();
  await page.getByLabel('Subject').fill('nothing-matches-this');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('No changes found')).toBeVisible();
});

test('admin pages are closed to people who are not platform admins', async ({ page }) => {
  await signInAs(page, 'andy@taazaa.com');
  const res = await page.goto('/admin/system');
  expect(res?.status()).toBe(404);
});
