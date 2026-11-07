import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// Source trust (R3b-2, screens.md §10, §11): the seed ran the trust backfill, so every source has a reading
// (60, "Not enough data yet" until it has 10 judged arrivals). The Sources page shows that and the legend, the
// Trust filter narrows the tree from the URL, and the source page's Trust card shows "Updated nightly".

const LEADER = 'zach.wiant@taazaa.com';

test('the Sources page shows trust and the Trust filter narrows the tree', async ({ page }) => {
  await signInAs(page, LEADER);

  // The seed's backfill computed trust: a person source has a reading time and the not-enough-data words.
  const person = await page.evaluate(async () => {
    const res = await fetch('/api/v1/sources?kind=person', { credentials: 'include', headers: { 'x-scout-tenant': 'taazaa' } });
    const body = (await res.json()) as { data: { id: string; name: string; trust: number; trust_label: string | null; trust_updated_at: string | null }[] };
    return body.data[0]!;
  });
  expect(person.trust_updated_at).not.toBeNull();

  await page.goto('/t/taazaa/sources');
  await expect(page.getByText(/^Trust is learned nightly from what each source's accounts became\./)).toBeVisible();
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: person.name, exact: true }) });
  await expect(row).toContainText(person.trust_label ?? String(person.trust));

  // Nothing seeded has 80 or more; "Not enough data" keeps the seeded sources.
  await page.goto('/t/taazaa/sources?trust=high');
  await expect(page.getByText('No sources match. Clear the filters, or add a source.')).toBeVisible();
  await page.goto('/t/taazaa/sources?trust=not_enough');
  await expect(page.getByRole('row').filter({ has: page.getByRole('link', { name: person.name, exact: true }) })).toBeVisible();

  // The source page's Trust card.
  await page.getByRole('link', { name: person.name, exact: true }).first().click();
  const card = page.getByRole('region', { name: 'Trust' });
  await expect(card).toContainText('Updated nightly');
  await expect(card).toContainText(/Based on \d+ accounts?/);
});
