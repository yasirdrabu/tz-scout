import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, accountSummary, fact, person } from '@/modules/accounts/db/schema';
import { confirmImport, createImport, registerSource, submitArrival, submitBatch } from '@/modules/intake';
import { closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, type Tenant } from './helpers';

let t: Tenant;
afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

const fixture = (name: string) => readFileSync(join(__dirname, '../../fixtures/imports', name));

describe('one path (SRC-E3-S1-AC1)', () => {
  it('the same company from four sources and four channels is one account with four source_ids', async () => {
    const domain = `onepath-${Date.now().toString(36)}.com`;
    const jane = { name: 'Jane Cole', title: 'CIO', email: `jane@${domain}` };
    const sources = await t.run(async (ctx) => {
      const ids: string[] = [];
      for (const name of ['Single', 'Batch', 'File', 'Targeted']) ids.push((await registerSource(ctx, { kind: 'person', name })).id);
      return ids as [string, string, string, string];
    });
    const [single, batchSender, file, targeted] = sources;
    const company = { name: 'One Path Co', domain, employees: 2400 };

    // 1. A single /api/v1 arrival.
    const first = await asSource(t, single, (ctx) =>
      submitArrival(ctx, { account: company, people: [jane] }, { channel: 'api', canDeclareWarmIntro: false }),
    );
    await runOutbox(t.tenantId);

    // 2. A /api/v1 batch item.
    await asSource(t, batchSender, (ctx) =>
      submitBatch(ctx, { name: 'One path batch', items: [{ external_ref: 'row-1', account: company, people: [jane] }] }, { channel: 'api' }),
    );
    await runOutbox(t.tenantId);

    // 3. A CSV row.
    const csv = `Company,Website,Name,Email,Title,Employees\nOne Path Co,${domain},Jane Cole,jane@${domain},CIO,2400\n`;
    const made = await asSource(t, file, (ctx) =>
      createImport(ctx, { fileName: 'one-path.csv', contentType: 'text/csv', bytes: Buffer.from(csv) }),
    );
    if (made.status === 'needs_sheet') throw new Error('unexpected sheet prompt');
    if (made.status === 'needs_confirm') await asSource(t, file, (ctx) => confirmImport(ctx, made.id, made.mapping));
    await runOutbox(t.tenantId);

    // 4. An inline targeted arrival, which carries people and facts for a known account.
    const accountId = (await asSource(t, single, (ctx) => ctx.tx.select().from(account).where(eq(account.domain, domain)).then((r) => r[0]!.id)));
    // A key that can see all accounts, as targeting an account needs; the sending source is still `targeted`.
    const inline = await t.run((ctx) =>
      submitArrival({ ...ctx, access: { sourceId: targeted, dataLimit: { kind: 'all' } } }, { target_account_id: accountId, people: [jane], facts: { employees: 2400 } }, { channel: 'api', inline: true }),
    );
    expect(inline.inlineResult).toMatchObject({ accountId });
    await runOutbox(t.tenantId);

    expect(first.status).toBe('received');
    const read = () =>
      t.run(async (ctx) => {
        const accounts = await ctx.tx.select().from(account).where(and(eq(account.domain, domain), isNull(account.archivedAt)));
        const [summary] = await ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, accountId));
        const people = await ctx.tx.select().from(person).where(and(eq(person.accountId, accountId), isNull(person.archivedAt)));
        const facts = await ctx.tx.select().from(fact).where(and(eq(fact.accountId, accountId), eq(fact.status, 'current')));
        return { accounts, summary, people, facts };
      });
    const r = await read();
    expect(r.accounts).toHaveLength(1);
    expect([...r.summary!.sourceIds].sort()).toEqual([...sources].sort());
    expect(r.people.map((p) => p.email)).toEqual([`jane@${domain}`]);
    expect(r.facts.filter((f) => f.key === 'employees').map((f) => f.value)).toEqual([2400]);
  }, 60_000);

  it('the Miami-Dade example from the spec is accepted as a strict /api/v1 arrival', async () => {
    const body = JSON.parse(fixture('miami-dade-arrival.json').toString());
    const source = await t.run(async (ctx) => (await registerSource(ctx, { kind: 'person', name: 'Miami sender' })).id);
    const r = await asSource(t, source, (ctx) => submitArrival(ctx, body, { channel: 'api' }));
    expect(r.status).toBe('received');
    await runOutbox(t.tenantId);
  }, 60_000);
});
