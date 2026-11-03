import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestApproved, requestCancelled, requestCompleted, requestDeclined, requestFailed, requestFlagged } from '@/modules/enrichment/contracts/events';
import { listQueue } from '@/modules/routing';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, asPerson, member, routingTenant, type Tenant } from './helpers';

let t: Tenant;
let leader: string;

beforeAll(async () => {
  t = await routingTenant();
  leader = await member(t, 'leader');
});
afterAll(closeDbs);

const AGENT = "Yasir's agent";
const estimate = { credits: 1, costCents: 10 };
const flagged = (accountId: string, requestId: string, label = AGENT) =>
  publishTestEvent(t.tenantId, requestFlagged, { requestId, accountId, kind: 'company_firmographics', requestedBy: 'usr_x', requestedByLabel: label, reason: 'Need it', estimate });
const approved = (accountId: string, requestId: string, label = AGENT) =>
  publishTestEvent(t.tenantId, requestApproved, { requestId, accountId, kind: 'company_firmographics', providerKey: 'apollo', decidedBy: 'usr_y', requestedByLabel: label });
const declined = (accountId: string, requestId: string) => publishTestEvent(t.tenantId, requestDeclined, { requestId, accountId, decidedBy: 'usr_y', reason: 'No' });
const completed = (accountId: string, requestId: string) =>
  publishTestEvent(t.tenantId, requestCompleted, {
    requestId,
    accountId,
    kind: 'company_firmographics',
    providerKey: 'apollo',
    arrivalIds: [],
    found: 0,
    creditsUsed: 0,
    costCents: 0,
    currency: 'USD',
    requestedBy: 'usr_x',
  });

const chip = async (accountId: string) => {
  const rows = (await asPerson(t, (ctx) => listQueue(ctx, {}), { userId: leader })).data;
  const row = rows.find((r) => r.accountId === accountId)!;
  return { on: row.enrichmentRequested, by: row.enrichmentRequestedBy };
};

describe('enrichment requested chip', () => {
  it('a flagged request turns the chip on with the requester, and a decline clears it', async () => {
    const a = await arrivedAccount(t);
    expect(await chip(a)).toEqual({ on: false, by: null });
    const r = newId('enr');
    await flagged(a, r);
    await runOutbox(t.tenantId);
    expect(await chip(a)).toEqual({ on: true, by: AGENT });
    await declined(a, r);
    await runOutbox(t.tenantId);
    expect(await chip(a)).toEqual({ on: false, by: null });
  });

  it('approved after flagged is the same request, and two open requests clear only when both close', async () => {
    const a = await arrivedAccount(t);
    const r1 = newId('enr');
    const r2 = newId('enr');
    await flagged(a, r1, 'Ann');
    await approved(a, r1, 'Ann');
    await flagged(a, r2, 'Bo');
    await runOutbox(t.tenantId);
    expect(await chip(a)).toEqual({ on: true, by: 'Bo' });
    await completed(a, r2);
    await runOutbox(t.tenantId);
    expect(await chip(a)).toEqual({ on: true, by: 'Ann' });
    await publishTestEvent(t.tenantId, requestFailed, { requestId: r1, accountId: a, providerKey: 'apollo', errorKind: 'unknown', message: 'x', creditsUsed: 0, costCents: 0 });
    await runOutbox(t.tenantId);
    expect(await chip(a)).toEqual({ on: false, by: null });
  });

  it('a terminal event that arrives before the approved event leaves nothing behind', async () => {
    const a = await arrivedAccount(t);
    const r = newId('enr');
    await publishTestEvent(t.tenantId, requestCancelled, { requestId: r, accountId: a, reason: 'expired' });
    await runOutbox(t.tenantId);
    await approved(a, r);
    await flagged(a, r);
    await runOutbox(t.tenantId);
    expect(await chip(a)).toEqual({ on: false, by: null });
  });
});
