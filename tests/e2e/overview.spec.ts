import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// Overview (R3c-1, screens.md §9): a leader opens the Overview and sees the four tiles, clicks the first pipeline
// band and gets the detail drawer, then switches the scorecard to By offer and the URL keeps the tab. The seed may
// have few accounts this quarter, so this checks the structure, not counts.

const LEADER = 'zach.wiant@taazaa.com';

test('the Overview shows the tiles, a band opens the drawer and the scorecard tab is kept in the URL', async ({ page }) => {
  await signInAs(page, LEADER);
  await page.goto('/t/taazaa/overview');

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  const tiles = page.getByRole('list', { name: 'Overview totals' });
  await expect(tiles.getByRole('listitem')).toHaveCount(4);
  await expect(tiles.getByText('Pipeline value')).toBeVisible();
  await expect(tiles.getByText('Won value')).toBeVisible();
  await expect(tiles.getByText('Days to win')).toBeVisible();

  await page.getByRole('region', { name: 'Pipeline' }).getByRole('button').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Pipeline stage · this quarter')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await expect(page.getByRole('tab', { name: 'By seller' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'By offer' }).click();
  await expect(page).toHaveURL(/tab=offers/);
  await expect(page.getByRole('tab', { name: 'By offer' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText("Won value and pipeline use deal amounts, or the offer's price when a deal has none.")).toBeVisible();
});
