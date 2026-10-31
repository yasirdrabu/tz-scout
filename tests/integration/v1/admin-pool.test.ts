import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as health } from '@/http/routes/v1/admin/health/route';
import { GET as aiRuns } from '@/http/routes/v1/admin/ai-runs/route';
import { GET as listAdmins } from '@/http/routes/v1/admin/platform-admins/route';
import { GET as listTenants } from '@/http/routes/v1/admin/tenants/route';
import { POST as tenantAction } from '@/http/routes/v1/admin/tenants/[id]/route';
import { POST as testEvent } from '@/http/routes/v1/admin/test-event/route';
import { config } from '@/platform/config';
import '@/platform/diagnostics';
import { seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person } from './session-helpers';

// adminDb's pool holds 10 connections (the postgres.js default).
const POOL = 10;

let admin: Person;
let cookies: Headers;
let tenantIds: string[];
// The stand-in relay and worker use their own connection, so they are not queued behind the requests.
const worker = postgres(config.databaseAdminUrl, { max: 1, onnotice: () => {} });
let stop = false;
let answering: Promise<void>;

beforeAll(async () => {
  admin = await seedUser({ admin: true, signedIn: true });
  cookies = await signedIn(admin.id);
  tenantIds = [];
  for (let i = 0; i < 4; i++) tenantIds.push((await tenantOwnedBy(admin, (await seedUser()).email, `Pool ${i}`)).tenantId);
  // Answer every ping as soon as it is in the outbox.
  answering = (async () => {
    while (!stop) {
      await worker`
        insert into platform.ping_result (id, tenant_id, sent_at)
        select o.id, o.tenant_id, now() from platform.outbox o
        where o.tenant_id = 't_platform' and o.payload->>'type' = 'jobs.platform.ping'
        on conflict do nothing`;
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
});

afterAll(async () => {
  stop = true;
  await answering;
  await worker.end({ timeout: 1 });
});

const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

describe('admin requests and the admin connection pool', () => {
  it(`more concurrent admin requests than the pool's ${POOL} connections all complete`, async () => {
    const as = { cookies };
    const calls: Promise<Response>[] = [];
    for (let i = 0; i < POOL + 2; i++) calls.push(testEvent(v1Req('/admin/test-event', { ...as, method: 'POST' })));
    for (let i = 0; i < POOL; i++) {
      calls.push(listTenants(v1Req('/admin/tenants', as)));
      calls.push(listAdmins(v1Req('/admin/platform-admins', as)));
      calls.push(aiRuns(v1Req('/admin/ai-runs', as)));
    }
    for (let i = 0; i < 3; i++) calls.push(health(v1Req('/admin/health', as)));
    for (const id of tenantIds) calls.push(tenantAction(v1Req(`/admin/tenants/${id}:suspend`, { ...as, method: 'POST' })));

    const results = await within(25_000, Promise.all(calls));
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
  });
});
