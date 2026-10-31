import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as postSource } from '@/http/routes/v1/sources/route';
import { personSourceFor } from '@/modules/intake';
import { addMember } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { seedUser } from '../tenancy/helpers';
import { call, freshTenant, keyFor, type Tenant } from './intake-helpers';

let t: Tenant;
let key: string;

beforeAll(async () => {
  t = await freshTenant();
  key = await keyFor(t, ['sources:manage']);
});
afterAll(closeDbs);

describe('POST /api/v1/sources with user_id (SRC-E1-S1-AC2)', () => {
  it('links a person source to a member', async () => {
    const seller = await seedUser();
    await t.run((ctx) => addMember(ctx, { email: seller.email, role: 'seller' }));
    const res = await call(postSource, key, 'sources', { body: { kind: 'person', name: 'Seller', user_id: seller.id } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(await t.run((ctx) => personSourceFor(ctx, seller.id))).toBe(body.id);
  });

  it('refuses a user who is not a member', async () => {
    const outsider = await seedUser();
    const res = await call(postSource, key, 'sources', { body: { kind: 'person', name: 'Out', user_id: outsider.id } });
    expect(res.status).toBe(400);
    expect((await res.json()).title).toBe('That person is not a member of this workspace.');
  });
});
