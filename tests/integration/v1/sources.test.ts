import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATCH as patchReviewStatus } from '@/http/routes/v1/accounts/[id]/review-status/route';
import { GET as accountsRoute } from '@/http/routes/v1/accounts/route';
import { POST as postBatch } from '@/http/routes/v1/batches/route';
import { GET as feedbackRoute } from '@/http/routes/v1/feedback/route';
import { GET as directoryRoute } from '@/http/routes/v1/members/directory/route';
import { DELETE as deleteKey, POST as keyAction } from '@/http/routes/v1/sources/[id]/keys/[keyId]/route';
import { POST as postKey } from '@/http/routes/v1/sources/[id]/keys/route';
import { DELETE as deleteSource, GET as getSource, PATCH as patchSource, POST as sourceAction } from '@/http/routes/v1/sources/[id]/route';
import { GET as listRoute, POST as postSource } from '@/http/routes/v1/sources/route';
import { GET as statsRoute } from '@/http/routes/v1/sources/stats/route';
import { setDisabled } from '@/modules/integrations';
import { personSourceFor } from '@/modules/intake';
import { source } from '@/modules/intake/db/schema';
import { addMember } from '@/modules/tenancy';
import { apiKey } from '@/modules/tenancy/db/schema';
import { authenticateKey, setKeyCacheTtl } from '@/modules/tenancy/services/api-keys';
import { adminDb, closeDbs } from '@/platform/db/client';
import { auditLog, idempotencyKey } from '@/platform/db/schema';
import { seedUser } from '../tenancy/helpers';
import { workspace, type Workspace } from './review-helpers';
import { call, freshTenant, keyFor, type Tenant } from './intake-helpers';

let w: Workspace;
let other: Workspace;
let operator: string;
let seller: string;
let personSource: string;

const json = async (p: Promise<Response>, status = 200) => {
  const res = await p;
  const body = res.status === 204 ? null : await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
};

beforeAll(async () => {
  w = await workspace('Sources Co');
  other = await workspace('Other Sources Co');
  operator = await w.person('operator', { name: 'Riley Op' });
  seller = await w.person('seller', { name: 'Sam Seller' });
  // The operator's person source is made the first time they act.
  await w.as(operator, listRoute, 'sources');
  personSource = (await w.run((ctx) => personSourceFor(ctx, operator)))!;
  setKeyCacheTtl(60_000);
});
afterAll(closeDbs);

const addList = async (name: string) => json(w.as(operator, postSource, 'sources', 'POST', { kind: 'list', name, parent_id: personSource }), 201);

describe('GET /api/v1/sources', () => {
  it('lists the tree with labels, how each sends, trust words and the kind counts', async () => {
    const body = await json(w.as(operator, listRoute, 'sources'));
    const agent = body.data.find((s: { id: string }) => s.id === w.source.agentId);
    expect(agent).toMatchObject({
      kind: 'agent',
      kind_label: 'Agent',
      status_label: 'Active',
      method: 'through_parent',
      method_label: 'Through Sources Co Ash',
      parent: { id: w.source.personId, name: 'Sources Co Ash', kind: 'person' },
      trust: null,
      trust_label: 'Not enough data yet',
      children_count: 0,
    });
    const person = body.data.findIndex((s: { id: string }) => s.id === w.source.personId);
    expect(body.data[person + 1].id).toBe(w.source.agentId);
    // A person without a key of their own sends through their agents.
    expect(body.data[person]).toMatchObject({ method: 'through_children', method_label: 'Through Sources Co Ash agent' });
    expect(body.meta.counts_by_kind.agent).toBeGreaterThanOrEqual(1);
    expect(body.meta.counts_by_kind.list).toBe(0);
    expect(body.meta.kind_labels.vendor).toBe('Data vendor');
    // The seeded HubSpot source is the one Scout polls (Ruling 5).
    expect(body.meta.can_add_crm).toBe(false);
  });

  it('filters by kind and name, keeping the counts of every kind', async () => {
    const body = await json(w.as(operator, listRoute, 'sources?kind=vendor&q=apol'));
    expect(body.data.map((s: { name: string }) => s.name)).toEqual(['Apollo']);
    expect(body.meta.counts_by_kind.person).toBe(0);
    expect(body.meta.counts_by_kind.vendor).toBe(1);
    // A % in the search is a character, not a wildcard.
    await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'vendor', name: 'Grow 100% Co' }), 201);
    expect((await json(w.as(operator, listRoute, 'sources?q=0%25'))).data.map((x: { name: string }) => x.name)).toEqual(['Grow 100% Co']);
  });

  it('refuses a kind it does not know with 400, and a seller with 403', async () => {
    const bad = await json(w.as(operator, listRoute, 'sources?kind=robot'), 400);
    expect(bad.errors[0].path).toBe('kind');
    await json(w.as(seller, listRoute, 'sources'), 403);
  });

  it("never lists another tenant's sources", async () => {
    const body = await json(w.as(operator, listRoute, 'sources'));
    expect(body.data.map((s: { id: string }) => s.id)).not.toContain(other.source.agentId);
  });
});

describe('How a person sends', () => {
  it('names one agent, counts several, and is Not sending yet with none', async () => {
    const person = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'person', name: 'Agentless Pat' }), 201);
    expect(person).toMatchObject({ method: 'none', method_label: 'Not sending yet' });
    for (const name of ['Pat agent one', 'Pat agent two']) {
      await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'agent', name, parent_id: person.id }), 201);
    }
    expect(await json(w.as(operator, getSource, `sources/${person.id}`))).toMatchObject({ method: 'through_children', method_label: 'Runs 2 agents' });
  });
});

describe('GET /api/v1/sources/{id}', () => {
  it('opens a source with its breadcrumb, owner and limits', async () => {
    const list = await addList('Read me list');
    const body = await json(w.as(operator, getSource, `sources/${list.id}`));
    expect(body).toMatchObject({
      kind: 'list',
      kind_label: 'List',
      method: 'file_upload',
      method_label: 'File upload',
      owner: { user_id: operator, name: 'Riley Op' },
      breadcrumb: [
        { id: personSource, name: 'Riley Op' },
        { id: list.id, name: 'Read me list' },
      ],
      daily_arrival_cap: 500,
      initial_review_status_key: 'needs_review',
      sync: null,
      has_sent: false,
      can_remove: true,
      can_archive: false,
      is_new: true,
    });
  });

  it("is 403 for a seller and 404 for another tenant's source", async () => {
    await json(w.as(seller, getSource, `sources/${w.source.agentId}`), 403);
    await json(w.as(operator, getSource, `sources/${other.source.agentId}`), 404);
  });

  it('shows the HubSpot sync and its connection', async () => {
    const list = await json(w.as(operator, listRoute, 'sources?kind=crm'));
    const body = await json(w.as(operator, getSource, `sources/${list.data[0].id}`));
    expect(body).toMatchObject({ method: 'hubspot_sync', method_label: 'HubSpot sync', sync: { last_polled_at: null, last_error: null, connected: true } });
  });
});

describe('POST /api/v1/sources', () => {
  it('adds a list under a person, owned by that person (Ruling 1, Ruling 3)', async () => {
    const list = await addList('Conference list');
    expect(list).toMatchObject({ kind: 'list', parent_id: personSource, owner: { user_id: operator, name: 'Riley Op' }, has_sent: false });
  });

  it('refuses a list with no person over it, at parent_id', async () => {
    const body = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'list', name: 'Orphan list' }), 400);
    expect(body.title).toBe('A list needs an owner. Pick the person who uploads it.');
    expect(body.errors[0].path).toBe('parent_id');
  });

  it('refuses an empty name and a duplicate one at name', async () => {
    const empty = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'vendor', name: '  ' }), 400);
    expect(empty).toMatchObject({ title: 'Give the source a name so its batches can be traced back to it.', errors: [{ path: 'name' }] });
    const dup = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'vendor', name: 'APOLLO' }), 409);
    expect(dup).toMatchObject({ title: 'A source called APOLLO already exists. Pick another name.', errors: [{ path: 'name' }] });
  });

  it('refuses a second HubSpot source (Ruling 5)', async () => {
    const body = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'crm', name: 'Another HubSpot' }), 409);
    expect(body.title).toBe('This workspace already syncs from HubSpot.');
  });

  it('refuses an owner who is not a member', async () => {
    const outsider = await seedUser();
    const body = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'vendor', name: 'Owned vendor', owner_user_id: outsider.id }), 400);
    expect(body.title).toBe('That person is not a member of this workspace.');
  });

  it('gives an agent its key once, and a replay does not hand it out again', async () => {
    const headers = { 'idempotency-key': 'add-agent-1' };
    const req = (body: unknown) =>
      w.as(operator, async (r) => postSource(new Request(r, { headers: { ...Object.fromEntries(r.headers), ...headers } })), 'sources', 'POST', body);
    const first = await json(req({ kind: 'agent', name: 'Keyed agent', parent_id: personSource, create_key: true }), 201);
    expect(first.api_key.secret).toMatch(/^scout_live_/);
    expect(first.method).toBe('through_parent');
    // The same request again is not a stored replay: it runs, and the name is taken.
    const again = await json(req({ kind: 'agent', name: 'Keyed agent', parent_id: personSource, create_key: true }), 409);
    expect(again.errors[0].path).toBe('name');
    expect(JSON.stringify(again)).not.toContain(first.api_key.secret);
    const stored = await adminDb.select().from(idempotencyKey).where(and(eq(idempotencyKey.tenantId, w.tenantId), eq(idempotencyKey.key, 'add-agent-1')));
    expect(stored).toEqual([]);
  });

  it('revokes the key when the source is not kept: no working key without its source (D35)', async () => {
    // Fails the workspace transaction at commit, after the key committed on the control plane.
    await adminDb.execute(sql`create or replace function intake.test_doomed() returns trigger language plpgsql as $$
      begin if new.name = 'Doomed agent' then raise exception 'doomed'; end if; return new; end $$`);
    await adminDb.execute(sql`create constraint trigger test_doomed after insert on intake.source deferrable initially deferred for each row execute function intake.test_doomed()`);
    try {
      const res = await w.as(operator, postSource, 'sources', 'POST', { kind: 'agent', name: 'Doomed agent', parent_id: personSource, create_key: true });
      expect(res.status).toBe(500);
    } finally {
      await adminDb.execute(sql`drop trigger if exists test_doomed on intake.source`);
      await adminDb.execute(sql`drop function if exists intake.test_doomed()`);
    }
    expect(await adminDb.select().from(source).where(and(eq(source.tenantId, w.tenantId), eq(source.name, 'Doomed agent')))).toEqual([]);
    const keys = await adminDb.select().from(apiKey).where(and(eq(apiKey.tenantId, w.tenantId), eq(apiKey.name, 'Doomed agent key')));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.revokedAt).not.toBeNull();
  });

  it('refuses a key for a list', async () => {
    const body = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'list', name: 'Keyed list', parent_id: personSource, create_key: true }), 400);
    expect(body.title).toBe('A list gets its accounts from files, not the API.');
  });

  it('is 403 for a seller', async () => {
    await json(w.as(seller, postSource, 'sources', 'POST', { kind: 'vendor', name: 'Seller vendor' }), 403);
  });
});

describe('PATCH /api/v1/sources/{id}', () => {
  it('changes the owner, audited, and refuses a duplicate name', async () => {
    const list = await addList('Owner list');
    const body = await json(w.as(operator, patchSource, `sources/${list.id}`, 'PATCH', { owner_user_id: w.owner }));
    expect(body.owner).toEqual({ user_id: w.owner, name: 'Sources Co Owner' });
    const [row] = await adminDb.select().from(auditLog).where(and(eq(auditLog.action, 'intake.source.owner_changed'), eq(auditLog.subjectId, list.id)));
    expect(row).toBeDefined();
    expect((await json(w.as(operator, patchSource, `sources/${list.id}`, 'PATCH', { owner_user_id: null }))).owner).toBeNull();
    const dup = await json(w.as(operator, patchSource, `sources/${list.id}`, 'PATCH', { name: 'conference LIST' }), 409);
    expect(dup.errors[0].path).toBe('name');
  });

  it('will not archive a source with live sources under it', async () => {
    const body = await json(w.as(operator, patchSource, `sources/${w.source.personId}`, 'PATCH', { status: 'archived' }), 409);
    expect(body).toMatchObject({ type: expect.stringContaining('source-has-children'), title: 'Remove or archive the sources under Sources Co Ash first.' });
  });

  it("is 400 for a bad owner type and 404 for another tenant's source", async () => {
    await json(w.as(operator, patchSource, `sources/${personSource}`, 'PATCH', { owner_user_id: 7 }), 400);
    await json(w.as(operator, patchSource, `sources/${other.source.agentId}`, 'PATCH', { name: 'Taken over' }), 404);
  });
});

describe('Remove vs Archive (Decision 13, Ruling 2)', () => {
  it('removes a list that sent nothing: it is a 404 and leaves the list', async () => {
    const list = await addList('Remove me');
    await json(w.as(operator, deleteSource, `sources/${list.id}`, 'DELETE'), 204);
    await json(w.as(operator, getSource, `sources/${list.id}`), 404);
    const all = await json(w.as(operator, listRoute, 'sources?status=active,paused,archived'));
    expect(all.data.map((s: { id: string }) => s.id)).not.toContain(list.id);
    // Its name is free again.
    await addList('Remove me');
  });

  it('archives a source that has sent: delete is 409, archive hides it and its keys stop working', async () => {
    const agent = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'agent', name: 'Sent agent', parent_id: personSource, create_key: true }), 201);
    await w.sent({ name: 'Sent Agent Co' }, agent.id);
    const refused = await json(w.as(operator, deleteSource, `sources/${agent.id}`, 'DELETE'), 409);
    expect(refused).toMatchObject({ title: 'Sent agent has sent accounts, so it can only be archived.', type: expect.stringContaining('source-has-sent') });
    const read = await json(w.as(operator, getSource, `sources/${agent.id}`));
    expect(read).toMatchObject({ has_sent: true, can_remove: false, can_archive: true });
    expect(read.last_sent_at).not.toBeNull();

    await json(w.as(operator, patchSource, `sources/${agent.id}`, 'PATCH', { status: 'archived' }));
    const listed = await json(w.as(operator, listRoute, 'sources'));
    expect(listed.data.map((s: { id: string }) => s.id)).not.toContain(agent.id);
    const archived = await json(w.as(operator, listRoute, 'sources?status=archived'));
    expect(archived.data.find((s: { id: string }) => s.id === agent.id)).toMatchObject({ status_label: 'Archived', can_archive: false, can_remove: false });
    expect((await json(w.as(operator, getSource, `sources/${agent.id}`))).status).toBe('archived');
    await expect(authenticateKey(agent.api_key.secret, null)).rejects.toMatchObject({ slug: 'key-revoked' });
  });

  it("is 403 for a seller and 404 for another tenant's source", async () => {
    await json(w.as(seller, deleteSource, `sources/${personSource}`, 'DELETE'), 403);
    await json(w.as(operator, deleteSource, `sources/${other.source.agentId}`, 'DELETE'), 404);
  });

  it('will not remove a source with live sources under it', async () => {
    const vendorBody = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'vendor', name: 'Parent vendor' }), 201);
    await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'scheduled_pull', name: 'Weekly pull', parent_id: vendorBody.id }), 201);
    const body = await json(w.as(operator, deleteSource, `sources/${vendorBody.id}`, 'DELETE'), 409);
    expect(body.title).toBe('Remove or archive the sources under Parent vendor first.');
  });
});

describe('GET /api/v1/sources/stats', () => {
  it("rolls a list's accounts up to its person, with the API's percentages and stage labels (Ruling 4)", async () => {
    const list = await addList('Stats list');
    await w.sent({ name: 'Stats One' }, list.id);
    await w.sent({ name: 'Stats Two' }, list.id);
    const body = await json(w.as(operator, statsRoute, 'sources/stats'));
    const ofList = body.data.find((s: { source_id: string }) => s.source_id === list.id);
    expect(ofList).toMatchObject({ sent: 2, reviewed: 0, assigned: 0, won: 0, reviewed_pct: 0, assigned_pct: null, won_pct: null, is_new: true });
    expect(ofList.by_stage[0]).toEqual({ key: 'arrived', label: 'Sent', count: 2 });
    expect(ofList.by_stage.map((b: { key: string }) => b.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won', 'declined', 'back_to_nurture', 'lost']);
    const ofPerson = body.data.find((s: { source_id: string }) => s.source_id === personSource);
    expect(ofPerson.sent).toBeGreaterThanOrEqual(2);
    // The account's chain names the list and its person, so the account rolls up (Ruling 1).
    const accounts = await json(w.as(operator, accountsRoute, `accounts?source_id=${personSource}`));
    expect(accounts.data.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(['Stats One', 'Stats Two']));
  });

  it('counts a reviewed account as reviewed', async () => {
    const list = await addList('Reviewed list');
    const a = await w.sent({ name: 'Reviewed Co' }, list.id);
    await json(w.as(w.owner, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'declined', reason_key: 'duplicate' }));
    await w.deliver();
    const body = await json(w.as(operator, statsRoute, 'sources/stats'));
    expect(body.data.find((s: { source_id: string }) => s.source_id === list.id)).toMatchObject({ sent: 1, reviewed: 1, reviewed_pct: 100, assigned: 0, assigned_pct: 0 });
  });

  it("is 403 for a seller and leaves out another tenant's sources", async () => {
    await json(w.as(seller, statsRoute, 'sources/stats'), 403);
    const body = await json(w.as(operator, statsRoute, 'sources/stats'));
    expect(body.data.map((s: { source_id: string }) => s.source_id)).not.toContain(other.source.agentId);
  });
});

describe('keys under a source (Decision 14, Ruling 7)', () => {
  const newKey = async (sourceId: string) => json(w.as(operator, postKey, `sources/${sourceId}/keys`, 'POST', { name: 'Rotating key' }), 201);

  it('rotates a key: the new one works, the old one fails on this instance at once, and the name and scopes stay', async () => {
    const agent = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'partner', name: 'Rotate partner' }), 201);
    expect(agent.method).toBe('none');
    const old = await newKey(agent.id);
    expect(await authenticateKey(old.secret, null)).toMatchObject({ id: old.id });
    const rotated = await json(w.as(operator, keyAction, `sources/${agent.id}/keys/${old.id}:rotate`, 'POST'), 201);
    expect(rotated.secret).toMatch(/^scout_live_/);
    expect(rotated.secret).not.toBe(old.secret);
    await expect(authenticateKey(old.secret, null)).rejects.toMatchObject({ slug: 'key-revoked' });
    const principal = await authenticateKey(rotated.secret, null);
    expect(principal).toMatchObject({ id: rotated.id, sourceId: agent.id });
    expect([...principal!.permissions].sort()).toEqual([...old.scopes].sort());
    const audited = await adminDb.select().from(auditLog).where(and(eq(auditLog.action, 'tenancy.api_key.rotated'), eq(auditLog.subjectId, old.id)));
    expect(audited).toHaveLength(1);
    // The partner now sends with a key (Ruling 6).
    expect(await json(w.as(operator, getSource, `sources/${agent.id}`))).toMatchObject({ method: 'api_key', method_label: 'API key', active_key: { id: rotated.id, prefix: rotated.prefix } });
  });

  it('a rotate whose request does not commit leaves the old key working and the new one revoked (D35)', async () => {
    const partner = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'partner', name: 'Doomed rotate' }), 201);
    const old = await newKey(partner.id);
    // Fails the workspace transaction at commit, after the rotation committed on the control plane.
    await adminDb.execute(sql`create or replace function platform.test_doomed_rotate() returns trigger language plpgsql as $$
      begin if new.action = 'tenancy.api_key.rotated' then raise exception 'doomed'; end if; return new; end $$`);
    await adminDb.execute(sql`create constraint trigger test_doomed_rotate after insert on platform.audit_log deferrable initially deferred for each row execute function platform.test_doomed_rotate()`);
    try {
      const res = await w.as(operator, keyAction, `sources/${partner.id}/keys/${old.id}:rotate`, 'POST');
      expect(res.status).toBe(500);
    } finally {
      await adminDb.execute(sql`drop trigger if exists test_doomed_rotate on platform.audit_log`);
      await adminDb.execute(sql`drop function if exists platform.test_doomed_rotate()`);
    }
    const keys = await adminDb.select().from(apiKey).where(and(eq(apiKey.tenantId, w.tenantId), eq(apiKey.sourceId, partner.id)));
    expect(keys).toHaveLength(2);
    expect(keys.find((k) => k.id === old.id)!.revokedAt).toBeNull();
    expect(keys.find((k) => k.id !== old.id)!.revokedAt).not.toBeNull();
    expect(await authenticateKey(old.secret, null)).toMatchObject({ id: old.id });
  });

  it("is 404 for a key of another source, and the rotate response is never stored for a replay", async () => {
    const a = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'partner', name: 'Partner A' }), 201);
    const b = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'partner', name: 'Partner B' }), 201);
    const key = await newKey(a.id);
    await json(w.as(operator, keyAction, `sources/${b.id}/keys/${key.id}:rotate`, 'POST'), 404);
    await json(w.as(operator, deleteKey, `sources/${b.id}/keys/${key.id}`, 'DELETE'), 404);
    const replay = (r: Request) => keyAction(new Request(r, { headers: { ...Object.fromEntries(r.headers), 'idempotency-key': 'rot-1' } }));
    await json(w.as(operator, replay, `sources/${a.id}/keys/${key.id}:rotate`, 'POST'), 201);
    // The old key is gone, so the same request again finds nothing to rotate.
    await json(w.as(operator, replay, `sources/${a.id}/keys/${key.id}:rotate`, 'POST'), 404);
  });

  it('revokes a key, audited, and refuses a key principal and a seller', async () => {
    const p = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'partner', name: 'Revoke partner' }), 201);
    const key = await newKey(p.id);
    await json(w.as(seller, deleteKey, `sources/${p.id}/keys/${key.id}`, 'DELETE'), 403);
    const manager = await keyFor(w.tenant as Tenant, ['sources:manage']);
    expect((await call(deleteKey, manager, `sources/${p.id}/keys/${key.id}`, { method: 'DELETE' })).status).toBe(403);
    await json(w.as(operator, deleteKey, `sources/${p.id}/keys/${key.id}`, 'DELETE'), 204);
    await expect(authenticateKey(key.secret, null)).rejects.toMatchObject({ slug: 'key-revoked' });
  });

  it("refuses a key for a list with 400 and another tenant's source with 404", async () => {
    const list = await addList('No keys list');
    const body = await json(w.as(operator, postKey, `sources/${list.id}/keys`, 'POST', { name: 'k' }), 400);
    expect(body.title).toBe('A list gets its accounts from files, not the API.');
    await json(w.as(operator, keyAction, `sources/${other.source.agentId}/keys/key_x:rotate`, 'POST'), 404);
  });
});

describe('POST /api/v1/sources/{id}:sync', () => {
  it('queues the poll for HubSpot, refuses another kind, and needs HubSpot connected', async () => {
    const crm = (await json(w.as(operator, listRoute, 'sources?kind=crm'))).data[0];
    expect(await json(w.as(operator, sourceAction, `sources/${crm.id}:sync`, 'POST'), 202)).toEqual({ queued: true });
    const bad = await json(w.as(operator, sourceAction, `sources/${w.source.agentId}:sync`, 'POST'), 400);
    expect(bad.title).toBe('Only the HubSpot source syncs.');
    const t = await freshTenantWithOperator();
    const tcrm = (await json(t.as(t.op, listRoute, 'sources?kind=crm'))).data[0];
    await t.run((ctx) => setDisabled(ctx, 'hubspot', true));
    const off = await json(t.as(t.op, sourceAction, `sources/${tcrm.id}:sync`, 'POST'), 409);
    expect(off.title).toBe('Connect HubSpot first');
  });

  it("is 403 for a seller and 404 for another tenant's source", async () => {
    const crm = (await json(w.as(operator, listRoute, 'sources?kind=crm'))).data[0];
    await json(w.as(seller, sourceAction, `sources/${crm.id}:sync`, 'POST'), 403);
    await json(w.as(operator, sourceAction, `sources/${other.source.agentId}:sync`, 'POST'), 404);
  });
});

async function freshTenantWithOperator() {
  const t = await workspace('Sync Off Co');
  const op = await t.person('operator');
  return { ...t, op };
}

describe('GET /api/v1/members/directory', () => {
  it('gives an operator, who cannot read Members, the active members by name', async () => {
    const body = await json(w.as(operator, directoryRoute, 'members/directory'));
    expect(body.data).toEqual(expect.arrayContaining([{ user_id: operator, name: 'Riley Op' }, { user_id: w.owner, name: 'Sources Co Owner' }]));
    expect(Object.keys(body.data[0]).sort()).toEqual(['name', 'user_id']);
    expect(body.data.map((d: { user_id: string }) => d.user_id)).not.toContain(other.owner);
  });

  it('is 403 for a seller', async () => {
    await json(w.as(seller, directoryRoute, 'members/directory'), 403);
  });
});

describe('GET /api/v1/feedback?source_id', () => {
  it('lists what was sent back to a source and the ones under it, with the reason and who did it', async () => {
    const a = await w.sent({ name: 'Sent Back Co' });
    await json(w.as(w.owner, patchReviewStatus, `accounts/${a}/review-status`, 'PATCH', { to: 'sent_back', reason_key: 'wrong_practice' }));
    await w.deliver();
    const body = await json(w.as(operator, feedbackRoute, `feedback?source_id=${w.source.personId}`));
    expect(body.data.find((f: { account_id: string }) => f.account_id === a)).toMatchObject({
      kind: 'sent_back',
      reason_label: 'Wrong practice',
      by_name: 'Sources Co Owner',
      account_name: 'Sent Back Co',
      summary: 'Sent back by Sources Co Owner: Wrong practice',
    });
  });

  it("needs sources:manage for source_id, and is 404 for another tenant's source", async () => {
    const reader = await keyFor(w.tenant as Tenant, ['arrivals:read'], { dataLimit: { kind: 'all' } });
    expect((await call(feedbackRoute, reader, `feedback?source_id=${w.source.personId}`)).status).toBe(403);
    await json(w.as(operator, feedbackRoute, `feedback?source_id=${other.source.agentId}`), 404);
    await json(w.as(operator, feedbackRoute, 'feedback?since=yesterday'), 400);
  });
});

describe('GET /api/v1/accounts?source_id first_arrival', () => {
  it('names the batch and the child source an account first came in through', async () => {
    const key = await keyFor(w.tenant as Tenant, ['arrivals:write', 'arrivals:read'], { sourceId: w.source.agentId, dataLimit: { kind: 'own_source' } });
    const domain = `first-${Date.now().toString(36)}.example`;
    const res = await call(postBatch, key, 'batches', { body: { name: 'Week 44 run', items: [{ account: { name: 'First Arrival Co', domain } }] } });
    expect(res.status).toBe(202);
    await w.deliver();
    const body = await json(w.as(operator, accountsRoute, `accounts?source_id=${w.source.personId}&q=First Arrival`));
    expect(body.data[0].first_arrival).toMatchObject({ batch_name: 'Week 44 run', source_id: w.source.agentId, source_name: 'Sources Co Ash agent' });
  });
});

describe('owner backfill (intake 0004)', () => {
  it('owns each person source by its person and each agent and list by its parent person', async () => {
    const t = await freshTenant();
    const u = await seedUser();
    await t.run((ctx) => addMember(ctx, { email: u.email, role: 'operator' }));
    const ids = await t.run(async (ctx) => {
      const p = await (await import('@/modules/intake')).registerSource(ctx, { kind: 'person', name: 'Backfill person', userId: u.id });
      const agent = await (await import('@/modules/intake')).registerSource(ctx, { kind: 'agent', name: 'Backfill agent', parentId: p.id });
      return { p: p.id, agent: agent.id };
    });
    await adminDb.update(source).set({ ownerUserId: null }).where(eq(source.tenantId, t.tenantId));
    const { readFileSync } = await import('node:fs');
    const sqlText = readFileSync('src/modules/intake/db/migrations/0004_source_owner.sql', 'utf8');
    for (const stmt of sqlText.split('--> statement-breakpoint').filter((s) => /^\s*(--.*\r?\n)*\s*UPDATE/i.test(s))) await adminDb.execute(sql.raw(stmt));
    const rows = await adminDb.select({ id: source.id, owner: source.ownerUserId }).from(source).where(eq(source.tenantId, t.tenantId));
    const owner = new Map(rows.map((r) => [r.id, r.owner]));
    expect(owner.get(ids.p)).toBe(u.id);
    expect(owner.get(ids.agent)).toBe(u.id);
  });
});

describe('POST /api/v1/sources with user_id (SRC-E1-S1-AC2)', () => {
  it('links a person source to a member', async () => {
    const t = await freshTenant();
    const key = await keyFor(t, ['sources:manage']);
    const member = await seedUser();
    await t.run((ctx) => addMember(ctx, { email: member.email, role: 'seller' }));
    const res = await call(postSource, key, 'sources', { body: { kind: 'person', name: 'Seller', user_id: member.id } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(await t.run((ctx) => personSourceFor(ctx, member.id))).toBe(body.id);
    expect(body.owner_user_id).toBe(member.id);
  });

  it('refuses a user who is not a member', async () => {
    const t = await freshTenant();
    const key = await keyFor(t, ['sources:manage']);
    const outsider = await seedUser();
    const res = await call(postSource, key, 'sources', { body: { kind: 'person', name: 'Out', user_id: outsider.id } });
    expect(res.status).toBe(400);
    expect((await res.json()).title).toBe('That person is not a member of this workspace.');
  });
});

describe('the Source page reads: batches of a source, and tier names for the Accounts tab', () => {
  it('GET /batches?source_id lists the batches of the source and the ones under it only', async () => {
    const { GET: batchesRoute } = await import('@/http/routes/v1/batches/route');
    const key = await keyFor(w.tenant as Tenant, ['arrivals:write', 'arrivals:read'], { sourceId: w.source.agentId, dataLimit: { kind: 'own_source' } });
    const res = await call(postBatch, key, 'batches', { body: { name: 'Tab batch', items: [{ account: { name: 'Tab Co', domain: `tab-${Date.now().toString(36)}.example` } }] } });
    const batchId = (await res.json()).batch_id;
    const mine = await json(w.as(operator, batchesRoute, `batches?source_id=${w.source.personId}`));
    expect(mine.data.map((b: { id: string }) => b.id)).toContain(batchId);
    const others = await json(w.as(operator, batchesRoute, `batches?source_id=${personSource}`));
    expect(others.data.map((b: { id: string }) => b.id)).not.toContain(batchId);
  });

  it('GET /accounts/facets names the tiers and rows carry tier_label', async () => {
    const { GET: facetsRoute } = await import('@/http/routes/v1/accounts/facets/route');
    const facets = await json(w.as(operator, facetsRoute, `accounts/facets?source_id=${w.source.personId}`));
    expect(facets.tiers.map((t: { value: string; label: string }) => [t.value, t.label])).toEqual([
      ['act_now', 'Act now'],
      ['good_fit', 'Good fit'],
      ['watch', 'Watch'],
      ['nurture', 'Nurture'],
      ['not_fit', 'Not a fit'],
    ]);
    const rows = await json(w.as(operator, accountsRoute, `accounts?source_id=${w.source.personId}`));
    expect(rows.data[0]).toHaveProperty('tier_label');
  });
});

describe('fix round: keys, members and sync', () => {
  it('rotate refuses a key that holds more than the caller does, and the old key keeps working', async () => {
    const { SYSTEM_GRANTOR, createApiKey } = await import('@/modules/tenancy');
    const p = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'partner', name: 'Owner keyed partner' }), 201);
    const big = await w.run((ctx) => createApiKey(ctx, { name: 'Big key', environment: 'live', scopes: ['arrivals:write', 'keys:manage'], sourceId: p.id, dataLimit: { kind: 'all' } }, SYSTEM_GRANTOR));
    const res = await json(w.as(operator, keyAction, `sources/${p.id}/keys/${big.id}:rotate`, 'POST'), 403);
    expect(res.type).toContain('scope-not-available');
    expect(await authenticateKey(big.secret, null)).toMatchObject({ id: big.id });
  });

  it('POST /sources with create_key refuses an API key', async () => {
    const manager = await keyFor(w.tenant as Tenant, ['sources:manage'], { dataLimit: { kind: 'all' } });
    const res = await call(postSource, manager, 'sources', { body: { kind: 'partner', name: 'Key made partner', create_key: true } });
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe('Only a person can do this.');
    const plain = await call(postSource, manager, 'sources', { body: { kind: 'partner', name: 'Key made partner' } });
    expect(plain.status).toBe(201);
  });

  it("will not remove a member's own person source", async () => {
    const { intakeSourceAccess } = await import('@/modules/intake');
    const member = await w.person('seller', { name: 'Remove Me Not' });
    const own = (await w.run((ctx) => intakeSourceAccess.personSourceFor(ctx, member)))!;
    expect((await json(w.as(operator, getSource, `sources/${own}`))).can_remove).toBe(false);
    const body = await json(w.as(operator, deleteSource, `sources/${own}`, 'DELETE'), 409);
    expect(body.title).toBe("Remove Me Not's own source can't be removed. Archive it instead, or remove the member.");
  });

  it('POST /api-keys refuses binding a key to a list (Ruling 1)', async () => {
    const { POST: postApiKey } = await import('@/http/routes/v1/api-keys/route');
    const list = await addList('Generic key list');
    const body = await json(w.as(w.owner, postApiKey, 'api-keys', 'POST', { name: 'k', source_id: list.id, access: 'send_and_status' }), 400);
    expect(body.title).toBe('A list gets its accounts from files, not the API.');
  });

  it('a poll skips while another poll of the tenant holds the lock', async () => {
    const { pollQualifiedLeads } = await import('@/modules/intake');
    let held: { submitted: number; skipped?: boolean } | undefined;
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'intake.qualified_leads.poll:' + w.tenantId}))`);
      held = await w.run((ctx) => pollQualifiedLeads(ctx));
    });
    expect(held).toEqual({ submitted: 0, skipped: true });
    expect((await w.run((ctx) => pollQualifiedLeads(ctx))).skipped).toBeUndefined();
  });

  it('GET /batches?source_id carries the total for the Batches tab count (C8)', async () => {
    const { GET: batchesRoute } = await import('@/http/routes/v1/batches/route');
    const body = await json(w.as(operator, batchesRoute, `batches?source_id=${w.source.personId}&limit=1`));
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.data).toHaveLength(1);
  });
});
