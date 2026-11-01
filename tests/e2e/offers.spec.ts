import { expect, test, type Page } from '@playwright/test';
import { shows, signInAs } from './helpers';

// An owner edits an offer (§19): a content edit keeps it Active, a change to who it is for moves it
// back to Draft, and making it Active again approves it. Every field it changes is put back at the end
// through the page's fetch, so later specs see the seeded offer.

const OWNER = 'zach.wiant@taazaa.com';

const api = (page: Page, path: string, method: string, body?: unknown) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(`/api/v1/${path}`, {
        method,
        credentials: 'include',
        headers: { 'x-scout-tenant': 'taazaa', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    },
    { path, method, body },
  );

test('an owner edits an offer', async ({ page }) => {
  await signInAs(page, OWNER);
  const whyUs = `E2E why us ${Date.now()}`;
  const industry = `e2e-industry-${Date.now()}`;

  await page.goto('/t/taazaa/offers');
  const tree = page.getByRole('navigation', { name: 'Practices' });
  await tree.getByRole('link').first().click();
  await tree.getByRole('link', { name: / Active$/ }).first().click();
  await page.waitForURL(/\/offers\/prc_\w+\/off_\w+/);
  const offerId = page.url().split('/').pop()!.split('?')[0]!;
  const heading = page.locator('#offer-name');
  await expect(heading).toBeVisible();
  const title = (await heading.textContent())!;
  const before = await api(page, `offers/${offerId}`, 'GET');
  const b = before.body!;
  // Every field this test changes, as seeded, to put back at the end.
  const restore = { why_us: b.why_us, price_model: b.price_model, price_min_cents: b.price_min_cents, price_max_cents: b.price_max_cents, length_weeks: b.length_weeks, industries: b.industries };

  try {
    // A content edit: Why us, pricing and length. It stays Active.
    await page.getByRole('button', { name: 'Edit offer' }).click();
    let drawer = page.getByRole('dialog', { name: 'Edit offer' });
    await drawer.getByLabel('Why us').fill(whyUs);
    await drawer.getByLabel('Pricing').selectOption({ label: 'Fixed fee' });
    await drawer.getByLabel('Length (weeks)').fill('6');
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await shows(page, `Changes to ${title} saved.`);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('region', { name: 'Why us' }).getByText(whyUs)).toBeVisible();
    await expect(page.getByText(/^Fixed fee · .*6 weeks$/).first()).toBeVisible();
    await expect(page.locator('section[aria-labelledby="offer-name"]').getByText('Active', { exact: true })).toBeVisible();

    // Who it is for: back to Draft with the warning; then Active again.
    await page.getByRole('button', { name: 'Edit offer' }).click();
    drawer = page.getByRole('dialog', { name: 'Edit offer' });
    await drawer.getByLabel('Industries').fill(industry);
    await drawer.getByLabel('Industries').press('Enter');
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer.getByText("This offer is back in Draft. Make it active again when you're ready.")).toBeVisible();
    await drawer.getByRole('radio', { name: /Active/ }).check();
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await shows(page, `${title} is active.`);
    await expect(drawer).toBeHidden();

    // Reload: the edits stay.
    await page.reload();
    await expect(page.getByRole('region', { name: 'Why us' }).getByText(whyUs)).toBeVisible();
    await expect(page.getByText(/^Fixed fee · .*6 weeks$/).first()).toBeVisible();
    await expect(page.locator('section[aria-labelledby="offer-name"]').getByText('Active', { exact: true })).toBeVisible();
    const after = await api(page, `offers/${offerId}`, 'GET');
    expect(after.body).toMatchObject({ why_us: whyUs, price_model: 'fixed', length_weeks: 6, status: 'approved' });
    expect(after.body!.industries).toContain(industry);
  } finally {
    // Put back every field this test changed, and make it Active again (the industries edit sent it to Draft).
    const put = await api(page, `offers/${offerId}`, 'PATCH', restore);
    expect(put.status).toBe(200);
    if (b.status === 'approved') expect((await api(page, `offers/${offerId}:approve`, 'POST')).status).toBe(200);
    expect((await api(page, `offers/${offerId}`, 'GET')).body).toMatchObject({ ...restore, status: b.status });
  }
});
