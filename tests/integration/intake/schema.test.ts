import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { arrival, source } from '@/modules/intake/db/schema';
import { newId } from '@/platform/ids';
import { freshTenant } from '../integrations/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
});

describe('intake.arrival', () => {
  it('rejects a payload change, allows a status change', async () => {
    const sourceId = newId('src');
    const arrivalId = newId('arr');
    await t.run(async (ctx) => {
      await ctx.tx.insert(source).values({ id: sourceId, tenantId: ctx.tenantId, kind: 'person', name: 'Ash' });
      await ctx.tx.insert(arrival).values({
        id: arrivalId,
        tenantId: ctx.tenantId,
        personSourceId: sourceId,
        closestSourceId: sourceId,
        principal: 'user:test',
        channel: 'api',
        payload: { raw: { account: { name: 'Acme' } } },
        payloadHash: 'h1',
      });
    });

    await expect(
      t.run((ctx) =>
        ctx.tx.update(arrival).set({ payload: { raw: { account: { name: 'Other' } } } }).where(eq(arrival.id, arrivalId)),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/immutable/i) } });
    await expect(
      t.run((ctx) => ctx.tx.update(arrival).set({ payloadHash: 'h2' }).where(eq(arrival.id, arrivalId))),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/immutable/i) } });

    await t.run((ctx) => ctx.tx.update(arrival).set({ status: 'resolving' }).where(eq(arrival.id, arrivalId)));
    const [row] = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, arrivalId)));
    expect(row!.status).toBe('resolving');
    expect(row!.payloadHash).toBe('h1');
  });

  it('keeps one arrival per source and external_ref, but not for rows without a ref', async () => {
    const sourceId = newId('src');
    const insert = (externalRef: string | null) =>
      t.run((ctx) =>
        ctx.tx.insert(arrival).values({
          id: newId('arr'),
          tenantId: ctx.tenantId,
          personSourceId: sourceId,
          closestSourceId: sourceId,
          principal: 'user:test',
          channel: 'api',
          payload: {},
          payloadHash: 'h',
          externalRef,
        }),
      );
    await insert('ref-1');
    await expect(insert('ref-1')).rejects.toThrow();
    await insert(null);
    await insert(null);
  });
});
