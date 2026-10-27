import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  archivePractice,
  approveOffer,
  createOffer,
  createPractice,
  listPractices,
  resolvePractice,
  updatePractice,
} from '@/modules/offers';
import { adminDb } from '@/platform/db/client';
import { completeOffer, freshTenant } from './helpers';

type T = Awaited<ReturnType<typeof freshTenant>>;
let t: T;

beforeAll(async () => {
  t = await freshTenant();
});

const events = async (tenantId: string, type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${tenantId} and payload->>'type' = ${type} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

describe('OFF-E1-S1 manage practices', () => {
  it('creates a practice with a slug taken from the name, and publishes offers.practice.changed', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Cloud Migration', keywords: ['cloud'] }));
    expect(p.id).toMatch(/^prc_/);
    expect(p.slug).toBe('cloud-migration');
    expect(p.status).toBe('active');
    const evs = await events(t.tenantId, 'offers.practice.changed');
    expect(evs.some((e) => e.payload.data.practiceId === p.id)).toBe(true);
  });

  it('AC1: a duplicate slug throws "That short name is taken."', async () => {
    await t.run((ctx) => createPractice(ctx, { name: 'Dup One', slug: 'dup' }));
    await expect(t.run((ctx) => createPractice(ctx, { name: 'Dup Two', slug: 'dup' }))).rejects.toMatchObject({
      status: 409,
      message: 'That short name is taken.',
    });
    const other = await t.run((ctx) => createPractice(ctx, { name: 'Dup Three', slug: 'dup-three' }));
    await expect(t.run((ctx) => updatePractice(ctx, other.id, { slug: 'dup' }))).rejects.toMatchObject({
      message: 'That short name is taken.',
    });
  });

  it('AC2: archiving a practice with an approved offer is blocked and names the offer', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Has Offers' }));
    const o = await t.run((ctx) => createOffer(ctx, { name: 'Pilot Package', practiceId: p.id, ...completeOffer }));
    await t.run((ctx) => approveOffer(ctx, o.id));
    await expect(t.run((ctx) => archivePractice(ctx, p.id))).rejects.toMatchObject({
      status: 409,
      message: 'Move or archive these offers first: Pilot Package.',
    });
  });

  it('archives a practice with no approved offers and hides it from the default list', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Empty Practice' }));
    await t.run((ctx) => archivePractice(ctx, p.id));
    const active = await t.run((ctx) => listPractices(ctx));
    expect(active.map((x) => x.id)).not.toContain(p.id);
    const all = await t.run((ctx) => listPractices(ctx, { includeArchived: true }));
    expect(all.find((x) => x.id === p.id)?.status).toBe('archived');
  });
});

describe('practice and offer consistency', () => {
  it('a draft offer in an archived practice cannot be approved', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Archived With Draft' }));
    const o = await t.run((ctx) => createOffer(ctx, { name: 'Stranded Draft', practiceId: p.id, ...completeOffer }));
    await t.run((ctx) => archivePractice(ctx, p.id));
    await expect(t.run((ctx) => approveOffer(ctx, o.id))).rejects.toMatchObject({ status: 404 });
  });

  it('a concurrent duplicate slug gets the friendly error, not a 500', async () => {
    const results = await Promise.allSettled([
      t.run((ctx) => createPractice(ctx, { name: 'Race One', slug: 'race' })),
      t.run((ctx) => createPractice(ctx, { name: 'Race Two', slug: 'race' })),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ status: 409, message: 'That short name is taken.' });
  });
});

describe('OFF-E1-S2 resolvePractice', () => {
  let ops: string;
  let longKw: string;

  beforeAll(async () => {
    const tt = await freshTenant();
    t = tt;
    ops = (
      await t.run((ctx) =>
        createPractice(ctx, { name: 'AI Operating Platforms', slug: 'ai-operating-platforms', keywords: ['ai operating platform'] }),
      )
    ).id;
    await t.run((ctx) => createPractice(ctx, { name: 'Short', keywords: ['platform'], sort: 1 }));
    longKw = (await t.run((ctx) => createPractice(ctx, { name: 'Long', keywords: ['platform agent list'], sort: 2 }))).id;
  });

  it('AC1: id, slug, name and keyword hints give the same id', async () => {
    // The last hint also contains the shorter keyword "platform"; the longer keyword wins.
    for (const hint of [ops, 'ai-operating-platforms', 'AI Operating Platforms', 'ai operating platforms', 'Yasir AI Operating Platform agent']) {
      expect(await t.run((ctx) => resolvePractice(ctx, hint))).toBe(ops);
    }
  });

  it('a keyword inside a longer hint resolves', async () => {
    expect(await t.run((ctx) => resolvePractice(ctx, 'Q3 AI Operating Platform sheet'))).toBe(ops);
  });

  it('null, unknown and unmatched hints give null', async () => {
    expect(await t.run((ctx) => resolvePractice(ctx, null))).toBeNull();
    expect(await t.run((ctx) => resolvePractice(ctx, undefined))).toBeNull();
    expect(await t.run((ctx) => resolvePractice(ctx, 'null'))).toBeNull();
    expect(await t.run((ctx) => resolvePractice(ctx, 'unknown'))).toBeNull();
    expect(await t.run((ctx) => resolvePractice(ctx, 'something else entirely'))).toBeNull();
  });

  it('a hint matching two practices gives the one with the longer keyword', async () => {
    expect(await t.run((ctx) => resolvePractice(ctx, 'the platform agent list'))).toBe(longKw);
  });

  it('equal keyword lengths fall back to sort', async () => {
    const a = (await t.run((ctx) => createPractice(ctx, { name: 'Tie A', keywords: ['zebra'], sort: 9 }))).id;
    const b = (await t.run((ctx) => createPractice(ctx, { name: 'Tie B', keywords: ['zebra'], sort: 3 }))).id;
    expect(await t.run((ctx) => resolvePractice(ctx, 'zebra crossing'))).toBe(b);
    expect(a).not.toBe(b);
  });

  it('archived practices never match', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Gone Fishing', keywords: ['fishing'] }));
    await t.run((ctx) => archivePractice(ctx, p.id));
    expect(await t.run((ctx) => resolvePractice(ctx, p.id))).toBeNull();
    expect(await t.run((ctx) => resolvePractice(ctx, 'gone-fishing'))).toBeNull();
    expect(await t.run((ctx) => resolvePractice(ctx, 'Gone Fishing'))).toBeNull();
    expect(await t.run((ctx) => resolvePractice(ctx, 'fishing trip'))).toBeNull();
  });
});

describe('isolation', () => {
  it('another tenant cannot see or resolve these practices', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const p = await a.run((ctx) => createPractice(ctx, { name: 'Only Mine', keywords: ['mine'] }));
    expect((await b.run((ctx) => listPractices(ctx))).map((x) => x.id)).not.toContain(p.id);
    expect(await b.run((ctx) => resolvePractice(ctx, p.id))).toBeNull();
    // Same slug is fine in another tenant.
    await expect(b.run((ctx) => createPractice(ctx, { name: 'Only Mine' }))).resolves.toMatchObject({ slug: 'only-mine' });
  });
});
