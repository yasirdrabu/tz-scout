import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { e2eEnv } from './env';
import { sendAccount, shows, signInAs } from './helpers';

// Playbook rates and What worked (R3c-2, screens.md §20): a seller accepts an account onto a one-step playbook and
// ticks the step, which finishes the plan. HubSpot (the mock) then has a reply from the account; after Check
// follow-through the Playbooks list reads Reply rate 100%, and the playbook's page shows the Replied tile at 100% of
// 1 account and What worked credits the Email step with 1 reply. The test makes its own offer, playbook and account,
// and retires the offer and the playbook at the end. The mock reply comes from the `mock-reply` mode of prepare-db.ts.

const OWNER = 'zach.wiant@taazaa.com';
const SELLER = 'ash@taazaa.com';

const api = (page: Page, path: string, method: string, body?: unknown) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(`/api/v1/${path}`, {
        method,
        credentials: 'include',
        headers: { 'x-scout-tenant': 'taazaa', ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'idempotency-key': crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    },
    { path, method, body },
  );

test('a finished plan with a CRM reply shows 100% on the list, the tile and What worked', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const offerName = `E2E Rates Offer ${stamp}`;
  const playbookName = `E2E Rates Playbook ${stamp}`;
  const accountName = `E2E Rates Account ${stamp}`;
  let offerId = '';
  let playbookId = '';

  const seller = await (await browser.newContext()).newPage();
  await signInAs(seller, SELLER);
  await signInAs(page, OWNER);

  try {
    // An offer of our own and an active one-step playbook on its Good fit tier.
    const practices = await api(page, 'practices', 'GET');
    const practiceId = ((practices.body as { data: unknown }).data as { id: string }[])[0]!.id;
    const offer = await api(page, 'offers', 'POST', {
      name: offerName,
      promise: 'Prove the playbook rates end to end.',
      practice_id: practiceId,
      target_titles: ['Director of Operations'],
      industries: [`e2e-rates-${stamp}`],
      typical_deal_cents: 5_000_000,
      sales_cycle_days: 60,
    });
    expect(offer.status).toBe(201);
    offerId = offer.body!.id as string;
    expect((await api(page, `offers/${offerId}:approve`, 'POST')).status).toBe(200);
    const playbook = await api(page, 'playbooks', 'POST', {
      name: playbookName,
      status: 'active',
      stop_when: 'never',
      steps: [{ day: 0, channel: 'email', owner_role: 'seller', title: 'Intro email', subject: `Hello ${stamp}`, body: 'Hi {person.first_name}.' }],
    });
    expect(playbook.status).toBe(201);
    playbookId = playbook.body!.id as string;
    expect((await api(page, `offers/${offerId}/playbooks/good_fit`, 'PUT', { playbook_id: playbookId })).status).toBe(200);

    // A Good fit account of that offer, assigned to the seller, who accepts.
    await sendAccount(page, accountName);
    const queue = await api(page, 'review-queue?limit=200', 'GET');
    const row = ((queue.body as { data: unknown }).data as { name: string; account_id?: string; id?: string }[]).find((a) => a.name === accountName)!;
    const accountId = (row.account_id ?? row.id)!;
    expect((await api(page, `accounts/${accountId}/lead-offer`, 'PUT', { offer_id: offerId })).status).toBe(200);
    await expect
      .poll(async () => (await api(page, `accounts/${accountId}/tier`, 'PUT', { tier: 'good_fit' })).status, { timeout: 60_000 })
      .toBe(200);
    await page.goto('/t/taazaa/queue');
    await page.getByRole('button', { name: accountName, exact: true }).click();
    await page.getByRole('dialog', { name: accountName }).getByRole('button', { name: 'Approve and assign' }).click();
    const dialog = page.getByRole('dialog', { name: `Assign ${accountName}` });
    await dialog.getByRole('radio', { name: /^Ash/ }).check();
    await expect(dialog.getByRole('radio', { name: new RegExp(playbookName) })).toBeChecked();
    await dialog.getByRole('button', { name: /^Assign to / }).click();
    await shows(page, `Sending ${accountName} to HubSpot.`);

    await seller.goto('/t/taazaa/my');
    await seller.getByRole('region', { name: 'New assignments' }).getByRole('button', { name: `Accept ${accountName}` }).click();
    await shows(seller, `Accepted. ${playbookName} starts today.`);

    // Tick the only step: the plan is finished.
    const active = seller.getByRole('region', { name: 'Active' });
    await expect(async () => {
      await seller.reload();
      await expect(active.getByRole('link', { name: accountName })).toBeVisible();
    }).toPass({ timeout: 60_000 });
    await active.getByRole('link', { name: accountName }).click();
    await seller.getByRole('checkbox', { name: 'Mark Intro email done' }).click();
    await shows(seller, 'Step updated.');
    await expect(seller.getByText('1 of 1 done')).toBeVisible();

    // HubSpot has a reply from the account; Check follow-through reads it.
    await expect(async () => {
      execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', 'mock-reply', accountId], { stdio: 'pipe', env: { ...process.env, ...e2eEnv } });
    }).toPass({ timeout: 90_000 });
    expect((await api(page, `accounts/${accountId}:check-follow-through`, 'POST')).status).toBe(202);

    // The list: Reply rate 100%.
    await expect(async () => {
      await page.goto('/t/taazaa/playbooks');
      const listRow = page.getByRole('row').filter({ has: page.getByRole('link', { name: playbookName, exact: true }) });
      await expect(listRow.getByRole('cell').nth(5)).toHaveText('100%', { timeout: 3_000 });
    }).toPass({ timeout: 90_000 });

    // The playbook page: the Replied tile and What worked.
    await page.getByRole('link', { name: playbookName, exact: true }).click();
    const tiles = page.getByRole('list', { name: 'Playbook numbers' });
    await expect(tiles.getByRole('listitem').filter({ hasText: 'Replied' })).toContainText('100%1 account');
    const worked = page.getByRole('region', { name: 'What worked' });
    await expect(async () => {
      await page.reload();
      const email = worked.getByRole('row').filter({ hasText: 'Email' });
      await expect(email.getByRole('cell').nth(2)).toHaveText(/^1/, { timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
  } finally {
    // Leave the playbook and the offer retired so later specs see the seeded data.
    if (playbookId) await api(page, `playbooks/${playbookId}:archive`, 'POST');
    if (offerId) await api(page, `offers/${offerId}:archive`, 'POST');
  }
});
