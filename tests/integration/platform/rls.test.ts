import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb, appDb } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';

describe('row level security', () => {
  beforeAll(async () => {
    await adminDb.execute(sql`drop table if exists platform.rls_probe`);
    await adminDb.execute(sql`create table platform.rls_probe (id text primary key, tenant_id text not null)`);
    await adminDb.execute(sql`alter table platform.rls_probe enable row level security`);
    await adminDb.execute(sql`alter table platform.rls_probe force row level security`);
    await adminDb.execute(sql`create policy tenant_isolation on platform.rls_probe
      using (tenant_id = current_setting('app.tenant_id', true))
      with check (tenant_id = current_setting('app.tenant_id', true))`);
  });
  afterAll(async () => {
    await adminDb.execute(sql`drop table if exists platform.rls_probe`);
  });

  it('shows a tenant only its own rows', async () => {
    await withTenant('t_A', (tx) => tx.execute(sql`insert into platform.rls_probe values ('r1', 't_A')`));
    const a = await withTenant('t_A', (tx) => tx.execute(sql`select * from platform.rls_probe`));
    const b = await withTenant('t_B', (tx) => tx.execute(sql`select * from platform.rls_probe`));
    expect(a.length).toBe(1);
    expect(b.length).toBe(0);
  });

  it('returns 0 rows for a query outside withTenant', async () => {
    const rows = await appDb.execute(sql`select * from platform.rls_probe`);
    expect(rows.length).toBe(0);
  });

  it('still returns 0 rows outside withTenant after a tenant transaction ran', async () => {
    await withTenant('t_A', (tx) => tx.execute(sql`select 1`));
    const rows = await appDb.execute(sql`select * from platform.rls_probe`);
    expect(rows.length).toBe(0);
  });

  it('rejects inserting a row for another tenant', async () => {
    await expect(
      withTenant('t_A', (tx) => tx.execute(sql`insert into platform.rls_probe values ('r2', 't_B')`)),
    ).rejects.toThrow();
  });

  it('adminDb bypasses row level security', async () => {
    const rows = await adminDb.execute(sql`select * from platform.rls_probe`);
    expect(rows.length).toBe(1);
  });
});
