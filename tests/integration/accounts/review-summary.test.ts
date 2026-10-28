import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAccount, getSummaries, mergeAccounts, search, upsertFromArrival, countAccounts, type ArrivalForAccounts } from '@/modules/accounts';
import { accountSummary } from '@/modules/accounts/db/schema';
import { reviewChanged } from '@/modules/routing/contracts/events';
import type { ReviewSnapshot } from '@/modules/routing/contracts/types';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

type Changed = z.infer<typeof reviewChanged.data>;

let t: Awaited<ReturnType<typeof freshTenant>>;

afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: {},
    account: {},
    people: [],
    signals: [],
    facts: [],
    research: {},
    soleProprietor: false,
    externalIds: [],
    ...over,
  };
}

const seed = async (name: string) => {
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name, domain: domain() } })));
  await runOutbox(t.tenantId);
  return out.accountId;
};

const snap = (over: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  reviewStatusKey: 'needs_review',
  ownerUserId: null,
  ownerHistoryUserIds: [],
  hasOpenAssignment: false,
  stage: 'arrived',
  reviewFlags: [],
  ...over,
});

const changed = (accountId: string, version: number, snapshot: ReviewSnapshot = snap()) =>
  publishTestEvent<Changed>(t.tenantId, reviewChanged, { accountId, version, snapshot });

const summaryOf = async (accountId: string) => {
  const [row] = await t.run((ctx) => ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, accountId)));
  return row!;
};

const deliver = () => runOutbox(t.tenantId);
const ownAccess = (userId: string) => ({ userId, dataLimit: { kind: 'own_accounts' as const } });

describe('account summary from routing.review.changed', () => {
  it('fills every review column', async () => {
    const id = await seed('Fill Co');
    await changed(id, 1, snap({ reviewStatusKey: 'reviewed', ownerUserId: 'usr_a', ownerHistoryUserIds: ['usr_a', 'usr_b'], hasOpenAssignment: true, stage: 'assigned', reviewFlags: ['new_from'] }));
    await deliver();
    expect(await summaryOf(id)).toMatchObject({
      reviewStatusKey: 'reviewed',
      ownerUserId: 'usr_a',
      ownerHistoryUserIds: ['usr_a', 'usr_b'],
      hasOpenAssignment: true,
      stage: 'assigned',
      reviewFlags: ['new_from'],
      reviewVersion: 1,
    });
  });

  it('leaves version 5 in place after 3, 5, 4, and a replay changes nothing', async () => {
    const id = await seed('Order Co');
    await changed(id, 3, snap({ ownerUserId: 'usr_three' }));
    await changed(id, 5, snap({ ownerUserId: 'usr_five' }));
    await changed(id, 4, snap({ ownerUserId: 'usr_four' }));
    await deliver();
    const after = await summaryOf(id);
    expect(after).toMatchObject({ ownerUserId: 'usr_five', reviewVersion: 5 });
    await changed(id, 5, snap({ ownerUserId: 'usr_replay', stage: 'declined' }));
    await deliver();
    expect(await summaryOf(id)).toEqual(after);
  });

  it('ignores an event for an account that was merged away', async () => {
    const survivor = await seed('Survivor Co');
    const gone = await seed('Gone Co');
    await t.run((ctx) => mergeAccounts({ ...ctx, access: { userId: 'usr_x', dataLimit: { kind: 'all' } } }, survivor, gone));
    await deliver();
    await changed(gone, 9, snap({ ownerUserId: 'usr_ghost' }));
    await deliver();
    expect((await summaryOf(gone)).reviewVersion).toBeNull();
    expect((await summaryOf(survivor)).reviewVersion).toBeNull();
  });

  it('shows a seller limited to own_accounts the accounts they own now or owned before', async () => {
    const past = await seed('Past Owner Co');
    const current = await seed('Current Owner Co');
    const other = await seed('Other Owner Co');
    await changed(past, 1, snap({ ownerUserId: 'usr_new', ownerHistoryUserIds: ['usr_seller'] }));
    await changed(current, 1, snap({ ownerUserId: 'usr_seller', hasOpenAssignment: true }));
    await changed(other, 1, snap({ ownerUserId: 'usr_new', ownerHistoryUserIds: ['usr_else'] }));
    await deliver();
    const ids = [past, current, other];
    const found = (await t.run((ctx) => search({ ...ctx, access: ownAccess('usr_seller') }, { accountIds: ids }))).data.map((r) => r.accountId).sort();
    expect(found).toEqual([past, current].sort());
    expect(await t.run((ctx) => countAccounts({ ...ctx, access: ownAccess('usr_seller') }, { accountIds: ids }))).toBe(2);
    expect((await t.run((ctx) => getSummaries({ ...ctx, access: ownAccess('usr_seller') }, ids))).map((r) => r.accountId).sort()).toEqual([past, current].sort());
    expect(await t.run((ctx) => getAccount({ ...ctx, access: ownAccess('usr_seller') }, past))).not.toBeNull();
    expect(await t.run((ctx) => getAccount({ ...ctx, access: ownAccess('usr_seller') }, other))).toBeNull();
  });
});
