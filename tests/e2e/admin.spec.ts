import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { e2eEnv } from './env';
import { shows, signInAs } from './helpers';

test.beforeEach(async ({ page }) => {
  await signInAs(page, 'yasir@taazaa.com');
});

test('Tenants: create a tenant, then suspend it', async ({ page }) => {
  const slug = `e2e-${Date.now().toString(36)}`;
  const name = `E2E Co ${slug}`;
  await page.goto('/admin/tenants');
  await page.getByRole('button', { name: 'New tenant' }).first().click();
  const panel = page.getByRole('dialog', { name: 'New tenant' });
  await panel.getByLabel('Company name').fill(name);
  await panel.getByLabel('Slug').fill(slug);
  await panel.getByLabel('Owner email').fill(`owner@${slug}.example`);
  await panel.getByRole('button', { name: 'Create tenant' }).click();
  const ready = page.getByRole('dialog', { name: `${name} is ready` });
  await expect(ready).toBeVisible();
  await ready.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name }).click();
  const drawer = page.getByRole('dialog', { name });
  await drawer.getByRole('button', { name: 'Suspend tenant' }).click();
  await page.getByRole('dialog', { name: `Suspend ${name}?` }).getByRole('button', { name: 'Suspend' }).click();
  await shows(page, `${name} suspended.`);
  await expect(drawer.getByRole('button', { name: 'Resume tenant' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row).toContainText('Suspended');
});

test('System health: loads, retries a dead job and sends a test event', async ({ page }) => {
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', 'dead-job'], {
    stdio: 'inherit',
    env: { ...process.env, ...e2eEnv },
  });
  await page.goto('/admin/health');
  await expect(page.getByRole('heading', { level: 1, name: 'System health' })).toBeVisible();
  await expect(page.getByText('Relay lag')).toBeVisible();
  await expect(page.getByText('integrations.credentials.cleanup').first()).toBeVisible();

  const dead = page.getByRole('listitem').filter({ hasText: 'e2e: forced failure' }).first();
  await expect(dead).toBeVisible();
  const retry = dead.getByRole('button', { name: /^Retry / });
  const label = (await retry.getAttribute('aria-label'))!;
  await retry.click();
  await shows(page, /sent back to platform\.ping/);
  await expect(page.getByRole('button', { name: label })).toHaveCount(0);

  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(page.getByText(/^Round trip \d+ ms\. Relay, queue and worker all answered\.$/)).toBeVisible({ timeout: 20_000 });
});

test('System health: runs a schedule now', async ({ page }) => {
  await page.goto('/admin/health');
  const run = page.getByRole('button', { name: /^Run integrations\.credentials\.cleanup for .* now$/ }).first();
  await expect(run).toBeVisible();
  await run.click();
  await shows(page, 'integrations.credentials.cleanup started');
});
