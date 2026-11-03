import { expect, test, type Page } from '@playwright/test';
import { shows, signInAs } from './helpers';

// Warm intros (warm-intros.md SRC-E5-S1-AC2, SRC-E5-S2-AC1; screens.md §4a, §21i): an intro a vendor
// declared counts half until a person confirms it, and changing a relationship's points rescores
// the accounts whose intros move.

const OWNER = 'zach.wiant@taazaa.com';
const LABEL = 'Someone on our team knows them'; // employee_network, 8 points by default

/** Adds an agent source (under the first person source) with a key as the signed-in person, and returns the key's secret. */
async function agentKey(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const headers = { 'content-type': 'application/json', 'x-scout-tenant': 'taazaa', 'idempotency-key': crypto.randomUUID() };
    const people = (await (await fetch('/api/v1/sources?kind=person', { credentials: 'include', headers })).json()) as { data: { id: string; kind: string }[] };
    const parent = people.data.find((x) => x.kind === 'person');
    const res = await fetch('/api/v1/sources', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ kind: 'agent', name, parent_id: parent?.id, create_key: true }),
    });
    const body = (await res.json()) as { api_key?: { secret: string } };
    if (!body.api_key) throw new Error(res.status + ' ' + JSON.stringify(body));
    return body.api_key.secret;
  }, name);
}

test('an unconfirmed intro is confirmed, then its relationship is repriced', async ({ page, request }) => {
  await signInAs(page, OWNER);
  const name = 'E2E Warm Intro';
  const domain = `e2e-warm-${Date.now()}.com`;
  const secret = await agentKey(page, `E2E warm agent ${Date.now()}`);
  const sent = await request.post('/api/v1/arrivals', {
    headers: { authorization: `Bearer ${secret}`, 'idempotency-key': crypto.randomUUID() },
    data: { account: { name, domain }, warm_intro: { introducer_name: 'Ash Patel', relationship_key: 'employee_network' } },
  });
  expect(sent.status()).toBe(202);

  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(async () => {
    await page.goto('/t/taazaa/queue');
    await expect(row).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name }).getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  await shows(page, /Warm intro from Ash Patel \(someone on our team knows them\) · Unconfirmed, \+4 of 8/);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await shows(page, 'Warm intro confirmed. It now counts all 8 points.');
  await shows(page, 'Warm intro from Ash Patel (someone on our team knows them), +8');
  await expect(page.getByText('Unconfirmed')).toHaveCount(0);

  await page.goto('/t/taazaa/settings/warm-intros');
  await page.getByRole('spinbutton', { name: `Points for ${LABEL}` }).fill('10');
  await page.getByRole('button', { name: 'Save warm intros' }).click();
  await shows(page, 'Warm intros saved. Rescoring 1 account.');
});
