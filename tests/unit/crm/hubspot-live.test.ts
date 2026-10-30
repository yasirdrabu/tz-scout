import { describe, expect, it } from 'vitest';
import { hubspotLive } from '@/modules/crm/adapters/hubspot/live';
import { SCOUT_PROPERTIES } from '@/modules/crm/adapters/hubspot/properties';
import { noteFingerprint } from '@/modules/crm/domain/fingerprint';
import { RateLimitedError } from '@/modules/integrations';

const TOKEN = 'pat-na1-secret-token-1234';

// Request bodies are inspected loosely: the assertions name the fields they care about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = { method: string; path: string; body: Record<string, any> | undefined };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (req: Req) => Reply | undefined;

/** A fake fetch: the first handler that answers wins, and every request is recorded. */
function fake(...handlers: Handler[]) {
  const calls: Req[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const req: Req = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    for (const h of handlers) {
      const r = h(req);
      if (r) return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
    }
    return new Response(JSON.stringify({ message: `unhandled ${req.method} ${req.path}` }), { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const adapter = (f: ReturnType<typeof fake>) => hubspotLive({ kind: 'private_app_token', value: TOKEN, settings: {} }, f.impl, async () => {});
const on =
  (method: string, prefix: string, reply: Reply | ((r: Req) => Reply)): Handler =>
  (r) =>
    r.method === method && r.path.startsWith(prefix) ? (typeof reply === 'function' ? reply(r) : reply) : undefined;
/** An exact path match, for when one path is a prefix of another. */
const exact =
  (method: string, path: string, reply: Reply | ((r: Req) => Reply)): Handler =>
  (r) =>
    r.method === method && r.path === path ? (typeof reply === 'function' ? reply(r) : reply) : undefined;

const obj = (id: string, props: Record<string, string | null>) => ({ id, properties: props });

describe('hubspotLive companies', () => {
  it('finds a company by domain and updates it without taking an owner someone else set', async () => {
    const f = fake(
      on('POST', '/crm/v3/objects/companies/search', { body: { results: [obj('11', { name: 'Acme', domain: 'acme.example', hubspot_owner_id: '999' })] } }),
      on('PATCH', '/crm/v3/objects/companies/11', { body: obj('11', {}) }),
    );
    const out = await adapter(f).upsertCompany({ domain: 'acme.example', name: 'Acme', ownerExternalId: '7001', replaceableOwner: false, properties: { taazaa_tier: 'Act now', taazaa_why_now: null } });
    expect(out).toEqual({ externalId: '11', created: false, ownerExternalId: '999' });
    const patch = f.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body!.properties).toEqual({ taazaa_tier: 'Act now' });
  });

  it('takes a company when the handoff says the owner is replaceable', async () => {
    const f = fake(
      on('POST', '/crm/v3/objects/companies/search', { body: { results: [obj('11', { name: 'Acme', hubspot_owner_id: '999' })] } }),
      on('PATCH', '/crm/v3/objects/companies/11', { body: obj('11', {}) }),
    );
    const out = await adapter(f).upsertCompany({ domain: 'acme.example', name: 'Acme', ownerExternalId: '7001', replaceableOwner: true, properties: {} });
    expect(out.ownerExternalId).toBe('7001');
    expect(f.calls.find((c) => c.method === 'PATCH')!.body!.properties.hubspot_owner_id).toBe('7001');
  });

  it('creates a company when none matches, and reads deals as cents', async () => {
    const f = fake(
      on('POST', '/crm/v3/objects/companies/search', { body: { results: [] } }),
      exact('POST', '/crm/v3/objects/companies', { body: obj('12', {}) }),
    );
    expect(await adapter(f).upsertCompany({ domain: 'new.example', name: 'New', ownerExternalId: '7001', replaceableOwner: false, properties: {} })).toEqual({
      externalId: '12',
      created: true,
      ownerExternalId: '7001',
    });

    const g = fake(
      on('POST', '/crm/v3/objects/companies/search', { body: { results: [obj('13', { name: 'Big', hubspot_owner_id: '5', lifecyclestage: 'customer' })] } }),
      on('POST', '/crm/v3/objects/deals/search', {
        body: { results: [obj('d1', { dealname: 'Deal', dealstage: 'qualified', amount: '1250.50', deal_currency_code: 'USD', createdate: '2026-01-02T00:00:00Z', closedate: null, hs_is_closed: 'false', hs_is_closed_won: 'false' })] },
      }),
    );
    const found = await adapter(g).findCompany({ domain: 'big.example' });
    expect(found).toMatchObject({ externalId: '13', ownerExternalId: '5', lifecycle: 'customer', openDeals: 1 });
    expect(found!.deals[0]).toMatchObject({ externalId: 'd1', companyExternalId: '13', status: 'open', amountCents: 125050, currency: 'USD' });
    expect(g.calls[1]!.body!.filterGroups[0].filters[0]).toMatchObject({ propertyName: 'associations.company', operator: 'EQ', value: '13' });
  });
});

describe('hubspotLive notes and tasks', () => {
  it('adds a new note and keeps the edited one when a person edited it', async () => {
    const f = fake(
      on('GET', '/crm/v3/objects/notes/n1', { body: obj('n1', { hs_note_body: '<p>Edited by a rep</p>' }) }),
      exact('POST', '/crm/v3/objects/notes', { body: obj('n2', {}) }),
      on('GET', '/crm/v3/objects/notes/n2', { body: obj('n2', { hs_note_body: '<p>Two</p>' }) }),
    );
    const out = await adapter(f).upsertNote({ externalId: 'n1', expectedFingerprint: noteFingerprint('<p>One</p>'), companyExternalId: '11', personExternalIds: ['21'], html: '<p>Two</p>', ownerExternalId: null });
    expect(out).toEqual({ externalId: 'n2', fingerprint: noteFingerprint('<p>Two</p>'), kept: true });
    expect(f.calls.some((c) => c.method === 'PATCH')).toBe(false);
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(post.body!.associations).toHaveLength(2);
  });

  it('updates an untouched note in place', async () => {
    const f = fake(
      on('GET', '/crm/v3/objects/notes/n1', { body: obj('n1', { hs_note_body: '<p>One</p>' }) }),
      on('PATCH', '/crm/v3/objects/notes/n1', { body: obj('n1', {}) }),
    );
    const out = await adapter(f).upsertNote({ externalId: 'n1', expectedFingerprint: noteFingerprint('<p>One</p>'), companyExternalId: '11', html: '<p>One</p>', ownerExternalId: null });
    expect(out.kept).toBe(false);
    expect(out.externalId).toBe('n1');
  });

  it('does not patch a completed task, and does not create a second one', async () => {
    const f = fake(on('GET', '/crm/v3/objects/tasks/t1', { body: obj('t1', { hs_task_status: 'COMPLETED' }) }));
    const out = await adapter(f).upsertTask({ externalId: 't1', companyExternalId: '11', subject: 'Call', body: '', ownerExternalId: null, dueAt: null });
    expect(out).toEqual({ externalId: 't1', status: 'completed' });
    expect(f.calls).toHaveLength(1);
  });

  it('closes a task with the completed status', async () => {
    const f = fake(on('PATCH', '/crm/v3/objects/tasks/t1', { body: obj('t1', {}) }));
    expect(await adapter(f).closeTask({ externalId: 't1' })).toEqual({ status: 'completed' });
    expect(f.calls[0]!.body).toEqual({ properties: { hs_task_status: 'COMPLETED' } });
  });
});

describe('hubspotLive errors', () => {
  it('retries a read after a 429, and a write throws RateLimitedError with Retry-After', async () => {
    let n = 0;
    const f = fake(
      on('POST', '/crm/v3/objects/companies/search', () => (n++ === 0 ? { status: 429, headers: { 'Retry-After': '2' }, body: { message: 'slow' } } : { body: { results: [] } })),
    );
    expect(await adapter(f).findCompany({ domain: 'x.example' })).toBeNull();
    expect(f.calls).toHaveLength(2);

    const w = fake(on('PATCH', '/crm/v3/objects/tasks/t1', { status: 429, headers: { 'Retry-After': '2' }, body: { message: 'slow' } }));
    const err = await adapter(w).closeTask({ externalId: 't1' }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(2000);
    expect(w.calls).toHaveLength(1);
  });

  it('gives RateLimitedError when a read stays limited after two retries', async () => {
    const f = fake(on('GET', '/crm/v3/properties/companies', { status: 429, body: {} }));
    await expect(adapter(f).existingProperties({})).rejects.toBeInstanceOf(RateLimitedError);
    expect(f.calls).toHaveLength(3);
  });

  it('retries a read after a 500 but never retries a write', async () => {
    let n = 0;
    const f = fake(on('GET', '/crm/v3/owners', () => (n++ < 2 ? { status: 500, body: { message: 'boom' } } : { body: { results: [] } })));
    expect(await adapter(f).listOwners({})).toEqual([]);
    const w = fake(on('PATCH', '/crm/v3/objects/tasks/t1', { status: 500, body: { message: 'boom' } }));
    await expect(adapter(w).closeTask({ externalId: 't1' })).rejects.toMatchObject({ status: 500 });
    expect(w.calls).toHaveLength(1);
  });

  it('treats a 401 as non-retryable with a plain message', async () => {
    const f = fake(on('POST', '/crm/v3/objects/companies/search', { status: 401, body: { message: 'bad token' } }));
    const err = await adapter(f).findCompany({ domain: 'x.example' }).catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(err.message).toBe('HubSpot refused the token. Enter a new one in Integrations.');
    expect(f.calls).toHaveLength(1);
  });

  it('names the missing permission on a 403', async () => {
    const f = fake(on('PATCH', '/crm/v3/objects/tasks/t1', { status: 403, body: { message: 'no', errors: [{ context: { requiredGranularScopes: ['crm.objects.companies.write'] } }] } }));
    const err = await adapter(f).closeTask({ externalId: 't1' }).catch((e) => e);
    expect(err).toMatchObject({ status: 403 });
    expect(err.message).toBe('HubSpot needs another permission: crm.objects.companies.write.');
  });

  it('never puts the token in a thrown message', async () => {
    const f = fake(on('PATCH', '/crm/v3/objects/tasks/t1', { status: 400, body: { message: `Invalid value ${TOKEN} sent` } }));
    const err = await adapter(f).closeTask({ externalId: 't1' }).catch((e) => e);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('[removed]');
  });

  it('rejects a response that does not match the shape it expects', async () => {
    const f = fake(on('GET', '/crm/v3/owners', { body: { results: [{ nope: true }] } }));
    await expect(adapter(f).listOwners({})).rejects.toThrow(/HubSpot sent an unexpected answer/);
  });
});

describe('hubspotLive test()', () => {
  const scopes = (list: string[]) => on('POST', '/oauth/v2/private-apps/get/access-token-info', { body: { scopes: list } });
  const account = on('GET', '/account-info/v3/details', { body: { portalId: 4242 } });
  const ALL = [
    'crm.objects.companies.read',
    'crm.objects.companies.write',
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
    'crm.objects.deals.read',
    'crm.objects.owners.read',
    'crm.schemas.companies.write',
  ];

  it('passes with facts when every scope is there', async () => {
    const r = await adapter(fake(account, scopes(ALL))).test();
    expect(r).toMatchObject({ ok: true, facts: { portal_id: '4242', portal_name: 'HubSpot portal 4242' } });
    expect(r.missingPermissions).toBeUndefined();
  });

  it('lists missing scopes in plain words', async () => {
    const r = await adapter(fake(account, scopes(['crm.objects.companies.read', 'crm.objects.owners.read']))).test();
    expect(r.ok).toBe(false);
    expect(r.missingPermissions).toEqual([
      'Write companies (also covers notes and tasks)',
      'Read and write contacts (also covers notes and tasks)',
      'Read deals',
      "Create Scout's fields on companies",
    ]);
  });

  it('passes with the owners warning when owners cannot be read', async () => {
    const r = await adapter(fake(account, scopes(ALL.filter((s) => s !== 'crm.objects.owners.read')))).test();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Owner list can't be read, so Scout can't name who owns a company");
    expect(r.facts?.portal_id).toBe('4242');
  });

  it('fails plainly on a refused token', async () => {
    const r = await adapter(fake(on('GET', '/account-info/v3/details', { status: 401, body: {} }))).test();
    expect(r).toMatchObject({ ok: false, message: 'HubSpot refused the token. Enter a new one in Integrations.' });
  });
});

describe('hubspotLive properties', () => {
  it('creates only the properties that are missing, so a second run creates nothing', async () => {
    const have = new Set(['taazaa_tier', 'unrelated']);
    const groups = new Set<string>();
    const f = fake(
      exact('GET', '/crm/v3/properties/companies/groups', () => ({ body: { results: [...groups].map((name) => ({ name })) } })),
      exact('POST', '/crm/v3/properties/companies/groups', (r) => (groups.add(r.body!.name), { body: {} })),
      exact('GET', '/crm/v3/properties/companies', () => ({ body: { results: [...have].map((name) => ({ name })) } })),
      exact('POST', '/crm/v3/properties/companies', (r) => (have.add(r.body!.name), { body: {} })),
    );
    const a = adapter(f);
    const input = { groupName: 'scout_buyer_signals', groupLabel: 'Scout buyer signals', properties: SCOUT_PROPERTIES };
    const first = await a.setUpProperties(input);
    expect(first.created).toHaveLength(SCOUT_PROPERTIES.length - 1);
    expect(first.created).not.toContain('taazaa_tier');
    expect(first.created).toContain('scout_link');
    const posts = f.calls.filter((c) => c.method === 'POST' && c.path === '/crm/v3/properties/companies');
    expect(posts.every((c) => c.body!.groupName === 'scout_buyer_signals')).toBe(true);
    expect(f.calls.find((c) => c.method === 'POST' && c.path.endsWith('/groups'))!.body).toEqual({ name: 'scout_buyer_signals', label: 'Scout buyer signals' });
    const second = await a.setUpProperties(input);
    expect(second.created).toEqual([]);
    expect(await a.existingProperties({})).toContain('scout_link');
  });
});

describe('hubspotLive activities, deals and leads', () => {
  it('reads emails, calls and meetings for a company since a time; an incoming email is a reply', async () => {
    const hit = (type: string, results: unknown[]) => on('POST', `/crm/v3/objects/${type}/search`, { body: { results } });
    const f = fake(
      hit('emails', [
        obj('e1', { hs_timestamp: '2026-03-01T10:00:00Z', hs_email_direction: 'INCOMING_EMAIL', hubspot_owner_id: null }),
        obj('e2', { hs_timestamp: '2026-03-01T09:00:00Z', hs_email_direction: 'EMAIL', hubspot_owner_id: '7001' }),
      ]),
      hit('calls', [obj('c1', { hs_timestamp: '2026-03-02T10:00:00Z', hubspot_owner_id: '7001' })]),
      hit('meetings', [obj('m1', { hs_timestamp: '2026-03-03T10:00:00Z', hubspot_owner_id: '7002' })]),
    );
    const out = await adapter(f).listActivities({ companyExternalId: '11', since: '2026-03-01T00:00:00Z' });
    expect(out.map((a) => [a.externalId, a.kind, a.actorOwnerExternalId])).toEqual([
      ['e2', 'email', '7001'],
      ['e1', 'reply', null],
      ['c1', 'call', '7001'],
      ['m1', 'meeting', '7002'],
    ]);
    const filters = f.calls[0]!.body!.filterGroups[0].filters;
    expect(filters).toContainEqual({ propertyName: 'associations.company', operator: 'EQ', value: '11' });
    expect(filters).toContainEqual({ propertyName: 'hs_timestamp', operator: 'GTE', value: String(Date.parse('2026-03-01T00:00:00Z')) });
  });

  it('lists deals changed since a time with their company, and drops deals with no company', async () => {
    const dealProps = { dealname: 'D', dealstage: 'closedwon', amount: '10', hs_is_closed: 'true', hs_is_closed_won: 'true', closedate: '2026-04-01T00:00:00Z' };
    const f = fake(
      on('POST', '/crm/v3/objects/deals/search', { body: { results: [obj('d1', dealProps), obj('d2', dealProps)] } }),
      on('POST', '/crm/v4/associations/deals/companies/batch/read', { body: { results: [{ from: { id: 'd1' }, to: [{ toObjectId: 11 }] }] } }),
    );
    const out = await adapter(f).listDeals({ changedSince: '2026-03-01T00:00:00Z' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalId: 'd1', companyExternalId: '11', status: 'won', amountCents: 1000, closedAt: '2026-04-01T00:00:00.000Z' });
    expect(f.calls[0]!.body!.filterGroups[0].filters[0]).toMatchObject({ propertyName: 'hs_lastmodifieddate', operator: 'GTE' });
  });

  it('lists qualified leads by the rule with their company, and reads one back', async () => {
    const rule = { property: 'lifecyclestage', value: 'marketingqualifiedlead' };
    const contact = obj('21', {
      firstname: 'Pat',
      lastname: 'Lee',
      email: 'pat@q.example',
      jobtitle: 'CTO',
      phone: null,
      mobilephone: '555',
      hs_linkedin_url: null,
      associatedcompanyid: '11',
      lifecyclestage: 'marketingqualifiedlead',
      hs_lifecyclestage_marketingqualifiedlead_date: '2026-05-01T00:00:00Z',
      lastmodifieddate: '2026-05-02T00:00:00Z',
    });
    const f = fake(
      on('POST', '/crm/v3/objects/contacts/search', { body: { results: [contact] } }),
      on('POST', '/crm/v3/objects/companies/batch/read', {
        body: { results: [obj('11', { name: 'Q', domain: 'q.example', website: null, city: 'Austin', state: 'TX', country: null, numberofemployees: '120', description: null })] },
      }),
      on('GET', '/crm/v3/objects/contacts/22', { body: obj('22', { lifecyclestage: 'customer' }) }),
      on('GET', '/crm/v3/objects/contacts/21', { body: contact }),
    );
    const a = adapter(f);
    const leads = await a.listQualifiedLeads({ changedSince: '2026-01-01T00:00:00Z', rule });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      contact: { externalId: '21', name: 'Pat Lee', email: 'pat@q.example', title: 'CTO', phone: '555' },
      company: { externalId: '11', domain: 'q.example', location: 'Austin, TX', employees: 120 },
      qualifiedAt: '2026-05-01T00:00:00.000Z',
    });
    expect(f.calls[0]!.body!.filterGroups[0].filters).toContainEqual({ propertyName: 'lifecyclestage', operator: 'EQ', value: 'marketingqualifiedlead' });
    // Contacts use `lastmodifieddate`; `hs_lastmodifieddate` is for companies and deals.
    expect(f.calls[0]!.body!.filterGroups[0].filters).toContainEqual({ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(Date.parse('2026-01-01T00:00:00Z')) });
    expect(f.calls[0]!.body!.sorts).toEqual([{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }]);
    expect(f.calls[0]!.body!.properties).toContain('lastmodifieddate');
    expect(f.calls[0]!.body!.properties).not.toContain('hs_lastmodifieddate');
    expect(await a.readQualifiedLead({ contactId: '22', rule })).toBeNull();
    expect((await a.readQualifiedLead({ contactId: '21', rule }))?.contact.email).toBe('pat@q.example');
  });
});

describe('hubspotLive webhooks', () => {
  it('refuses every webhook: the secret is a separate credential, checked by the pure v3 helper', async () => {
    expect(await adapter(fake()).verifyWebhook({ method: 'POST', url: 'https://x.example/h', headers: { 'x-hubspot-signature-v3': 'mock-valid' }, rawBody: '[]' })).toBe(false);
  });

  it('groups events by what changed', async () => {
    const body = JSON.stringify([
      { subscriptionType: 'deal.propertyChange', objectId: 5 },
      { subscriptionType: 'deal.creation', objectId: 5 },
      { subscriptionType: 'contact.propertyChange', propertyName: 'lifecyclestage', objectId: 9 },
      { subscriptionType: 'contact.propertyChange', propertyName: 'jobtitle', objectId: 10 },
      { subscriptionType: 'email.creation', objectId: 77 },
    ]);
    expect(await adapter(fake()).parseWebhook({ rawBody: body })).toEqual([
      { kind: 'deal', externalIds: ['5'] },
      { kind: 'lifecycle', externalIds: ['9'] },
      { kind: 'activity', externalIds: ['77'] },
    ]);
    expect(await adapter(fake()).parseWebhook({ rawBody: 'not json' })).toEqual([]);
  });
});
