import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companyLink, getLinks, linkExternalIds, recordLink } from '@/modules/crm';
import { closeDbs } from '@/platform/db/client';
import { arrivedAccount, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
beforeAll(async () => {
  t = await routingTenant();
});
afterAll(closeDbs);

describe('links', () => {
  it('recordLink upserts one row per (system, type, id, external id)', async () => {
    const accountId = await arrivedAccount(t);
    await t.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: accountId, system: 'hubspot', externalId: 'mock-co-1' }));
    await t.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: accountId, system: 'hubspot', externalId: 'mock-co-1', fingerprint: 'f1' }));
    const links = await t.run((ctx) => getLinks(ctx, accountId));
    expect(links.company).toMatchObject({ externalId: 'mock-co-1', fingerprint: 'f1' });
    expect(links.conflict).toBe(false);
    expect(await t.run((ctx) => companyLink(ctx, accountId, 'hubspot'))).toBe('mock-co-1');
    expect(await t.run((ctx) => companyLink(ctx, accountId, 'salesforce'))).toBeNull();
  });

  it('getLinks reports a conflict with two company links', async () => {
    const accountId = await arrivedAccount(t);
    await t.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: accountId, system: 'hubspot', externalId: 'mock-co-8' }));
    await t.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: accountId, system: 'hubspot', externalId: 'mock-co-9' }));
    const links = await t.run((ctx) => getLinks(ctx, accountId));
    expect(links.conflict).toBe(true);
    expect(links.company).not.toBeNull();
  });

  it('linkExternalIds links the account and a person', async () => {
    const accountId = await arrivedAccount(t);
    await t.run((ctx) => linkExternalIds(ctx, { accountId, externalIds: [{ system: 'hubspot', id: 'mock-co-5' }] }));
    await t.run((ctx) => linkExternalIds(ctx, { accountId, personId: 'per_x', externalIds: [{ system: 'hubspot', id: 'mock-ct-5' }] }));
    const links = await t.run((ctx) => getLinks(ctx, accountId));
    expect(links.company?.externalId).toBe('mock-co-5');
  });
});
