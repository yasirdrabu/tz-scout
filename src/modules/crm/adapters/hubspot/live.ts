import { z } from 'zod';
import { RateLimitedError, type LiveCredentials, type TestResult } from '@/modules/integrations';
import { webhookEventSchema, type CrmAdapter, type CrmDeal, type QualifiedLead } from '../../contracts/adapter';
import { noteFingerprint } from '../../domain/fingerprint';

// Live HubSpot over the CRM v3/v4 REST API with a private app token, ported from v1 and held to the same
// ownership rules as the mock. Scopes used: companies and contacts read/write (notes and tasks ride on
// these), deals read, owners read (optional) and company schema write (Scout's own properties).
// Credentials come only from `LiveCredentials`; this file reads no environment variables.

const BASE = 'https://api.hubapi.com';
const TIMEOUT_MS = 15_000;
const READ_RETRIES = 2;
const MAX_SEARCH_RESULTS = 1000;

// HubSpot-defined association type ids.
const ASSOC = { noteToCompany: 190, noteToContact: 202, taskToCompany: 192, taskToContact: 204 } as const;

const TOKEN_REFUSED = 'HubSpot refused the token. Enter a new one in Integrations.';
export const OWNERS_WARNING = "Owner list can't be read, so Scout can't name who owns a company";

/** What failed, with the HTTP status when HubSpot answered. 401, 403 and other 4xx are not retryable. */
export class HubSpotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HubSpotError';
  }
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Response shapes. Everything HubSpot sends is parsed before use.
const props = z.record(z.string(), z.string().nullable().optional());
const objSchema = z.object({ id: z.coerce.string(), properties: props.default({}) });
type Obj = z.infer<typeof objSchema>;
const pageSchema = z.object({
  results: z.array(objSchema),
  paging: z.object({ next: z.object({ after: z.string() }).optional() }).optional(),
});
const anySchema = z.unknown();
const namesSchema = z.object({ results: z.array(z.object({ name: z.string() })) });
const ownersSchema = z.object({
  results: z.array(z.object({ id: z.coerce.string(), firstName: z.string().nullish(), lastName: z.string().nullish(), email: z.string().nullish(), archived: z.boolean().nullish() })),
  paging: z.object({ next: z.object({ after: z.string() }).optional() }).optional(),
});
const companyAssocSchema = objSchema.extend({
  associations: z.record(z.string(), z.object({ results: z.array(z.object({ id: z.coerce.string() })) })).optional(),
});
const dealAssocSchema = z.object({ results: z.array(z.object({ from: z.object({ id: z.coerce.string() }), to: z.array(z.object({ toObjectId: z.coerce.string() })) })) });
const accountSchema = z.object({ portalId: z.coerce.string(), companyName: z.string().optional() });
const tokenInfoSchema = z.object({ scopes: z.array(z.string()), hubId: z.coerce.string().optional() });

type Filter = { propertyName: string; operator: string; value: string };

const COMPANY_PROPS = ['name', 'domain', 'website', 'city', 'state', 'country', 'numberofemployees', 'description', 'hubspot_owner_id', 'lifecyclestage'];
const DEAL_PROPS = ['dealname', 'dealstage', 'amount', 'deal_currency_code', 'createdate', 'closedate', 'hs_is_closed', 'hs_is_closed_won'];
const CONTACT_PROPS = ['firstname', 'lastname', 'email', 'jobtitle', 'phone', 'mobilephone', 'hs_linkedin_url', 'associatedcompanyid', 'lifecyclestage', 'hs_lastmodifieddate', 'createdate', 'hubspot_owner_id'];

const clean = (o: Record<string, string | number | null | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));

/** HubSpot sends dates as ISO strings or epoch milliseconds. */
function toIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(/^\d{10,}$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const toMs = (iso: string): string => String(new Date(iso).getTime());
const text = (v: string | null | undefined): string | null => (v && v.trim() ? v : null);
const toInt = (v: string | null | undefined): number | null => {
  const n = v == null || v === '' ? NaN : Math.round(Number(v));
  return Number.isNaN(n) ? null : n;
};

function dealOut(o: Obj, companyExternalId: string): CrmDeal {
  const p = o.properties;
  const closed = p.hs_is_closed === 'true' || p.dealstage === 'closedwon' || p.dealstage === 'closedlost';
  const won = p.hs_is_closed_won === 'true' || p.dealstage === 'closedwon';
  const status = won ? 'won' : closed ? 'lost' : 'open';
  const amount = p.amount == null || p.amount === '' ? NaN : Number(p.amount);
  return {
    externalId: o.id,
    companyExternalId,
    name: p.dealname ?? 'Deal',
    stage: text(p.dealstage),
    status,
    amountCents: Number.isNaN(amount) ? null : Math.round(amount * 100),
    currency: text(p.deal_currency_code),
    openedAt: toIso(p.createdate),
    closedAt: status === 'open' ? null : toIso(p.closedate),
  };
}

const ownerName = (o: { firstName?: string | null; lastName?: string | null; email?: string | null; id: string }) =>
  [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || o.id;

/** What each scope Scout needs is for, in plain words. Notes and tasks ride on companies and contacts. */
function missingPermissions(have: Set<string>): { missing: string[]; ownersReadable: boolean } {
  const missing: string[] = [];
  const pair = (object: string, noun: string, covers: string) => {
    const read = have.has(`crm.objects.${object}.read`);
    const write = have.has(`crm.objects.${object}.write`);
    if (read && write) return;
    missing.push(`${read ? 'Write' : write ? 'Read' : 'Read and write'} ${noun}${covers}`);
  };
  pair('companies', 'companies', ' (also covers notes and tasks)');
  pair('contacts', 'contacts', ' (also covers notes and tasks)');
  if (!have.has('crm.objects.deals.read')) missing.push('Read deals');
  if (!have.has('crm.schemas.companies.write')) missing.push("Create Scout's fields on companies");
  return { missing, ownersReadable: have.has('crm.objects.owners.read') };
}

export function hubspotLive(creds: LiveCredentials, fetchImpl: typeof fetch = fetch, sleep: Sleep = defaultSleep): CrmAdapter {
  const scrub = (s: string) => (creds.value.length >= 4 ? s.split(creds.value).join('[removed]') : s);
  const backoff = (attempt: number) => 300 * 2 ** attempt + Math.floor(Math.random() * 200);

  /**
   * One HubSpot call. `read` marks calls that are safe to repeat (GETs, searches, batch reads): they retry twice
   * with jitter on a 429, a 5xx or a timeout. Writes never retry; the job runner does that with its own backoff.
   */
  async function call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, read = method === 'GET'): Promise<T> {
    const label = `${method} ${path.split('?')[0]}`;
    for (let attempt = 0; ; attempt++) {
      const canRetry = read && attempt < READ_RETRIES;
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}${path}`, {
          method,
          headers: { Authorization: `Bearer ${creds.value}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        if (canRetry) {
          await sleep(backoff(attempt));
          continue;
        }
        const name = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'TimeoutError' : 'Error';
        throw Object.assign(new Error(scrub(`HubSpot did not answer ${label}: ${e instanceof Error ? e.message : String(e)}`)), { name });
      }
      const raw = await res.text();
      let json: unknown = {};
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        json = {};
      }
      const obj = (json && typeof json === 'object' ? json : {}) as { message?: unknown; errors?: { context?: Record<string, unknown> }[] };
      if (res.status === 429) {
        const header = Number(res.headers.get('Retry-After'));
        const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
        if (canRetry) {
          await sleep(Math.min(retryAfterMs ?? backoff(attempt), 10_000));
          continue;
        }
        throw new RateLimitedError('HubSpot asked us to slow down.', retryAfterMs);
      }
      if (res.status >= 500) {
        if (canRetry) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new HubSpotError(res.status, scrub(`HubSpot ${label} failed (${res.status}).`));
      }
      if (res.status === 401) throw new HubSpotError(401, TOKEN_REFUSED);
      if (res.status === 403) {
        const scopes = (obj.errors ?? []).flatMap((e) => [e.context?.requiredGranularScopes, e.context?.requiredScopes].flat()).filter((s): s is string => typeof s === 'string');
        const named = scopes.length ? [...new Set(scopes)].join(', ') : scrub(String(obj.message ?? 'a scope this call needs'));
        throw new HubSpotError(403, `HubSpot needs another permission: ${named}.`);
      }
      if (!res.ok) throw new HubSpotError(res.status, scrub(`HubSpot ${label} failed (${res.status}): ${String(obj.message ?? res.statusText)}`));
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new Error(`HubSpot sent an unexpected answer to ${label}.`);
      return parsed.data;
    }
  }

  /** A read that treats "not found" as no record, and fails on anything else (a 429 must not look like a missing note). */
  const getOrNull = async <T>(schema: z.ZodType<T>, path: string): Promise<T | null> => {
    try {
      return await call(schema, 'GET', path);
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  };

  const searchPage = (object: string, filters: Filter[], properties: string[], extra: Record<string, unknown> = {}) =>
    call(pageSchema, 'POST', `/crm/v3/objects/${object}/search`, { filterGroups: [{ filters }], properties, limit: 100, ...extra }, true);

  /** Every match, up to `max`, following the paging cursor. */
  async function searchAll(object: string, filters: Filter[], properties: string[], max = MAX_SEARCH_RESULTS, sorts?: { propertyName: string; direction: string }[]): Promise<Obj[]> {
    const out: Obj[] = [];
    let after: string | undefined;
    do {
      const page = await searchPage(object, filters, properties, { ...(sorts ? { sorts } : {}), ...(after ? { after } : {}) });
      out.push(...page.results);
      after = page.paging?.next?.after;
    } while (after && out.length < max);
    return out.slice(0, max);
  }

  const searchOne = async (object: string, filters: Filter[], properties: string[]) => (await searchPage(object, filters, properties, { limit: 1 })).results[0] ?? null;

  const associate = (from: string, fromId: string, to: string, toId: string) =>
    call(anySchema, 'PUT', `/crm/v4/objects/${from}/${fromId}/associations/default/${to}/${toId}`);

  const companyById = (id: string) => getOrNull(objSchema, `/crm/v3/objects/companies/${id}?properties=${COMPANY_PROPS.join(',')}`);
  const companyByDomain = (domain: string) => searchOne('companies', [{ propertyName: 'domain', operator: 'EQ', value: domain.trim().toLowerCase() }], COMPANY_PROPS);

  async function dealsForCompany(companyId: string): Promise<CrmDeal[]> {
    const rows = await searchAll('deals', [{ propertyName: 'associations.company', operator: 'EQ', value: companyId }], DEAL_PROPS);
    return rows.map((d) => dealOut(d, companyId));
  }

  async function readBatch(object: string, ids: string[], properties: string[]): Promise<Map<string, Obj>> {
    const out = new Map<string, Obj>();
    for (let i = 0; i < ids.length; i += 100) {
      const r = await call(z.object({ results: z.array(objSchema) }), 'POST', `/crm/v3/objects/${object}/batch/read`, { inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties }, true);
      for (const o of r.results) out.set(o.id, o);
    }
    return out;
  }

  async function personByEmailOrName(input: { email: string } | { name: string; companyExternalId: string }) {
    if ('email' in input) return searchOne('contacts', [{ propertyName: 'email', operator: 'EQ', value: input.email }], ['hubspot_owner_id']);
    const [first = '', ...rest] = input.name.trim().split(/\s+/);
    return searchOne(
      'contacts',
      [
        { propertyName: 'firstname', operator: 'EQ', value: first },
        { propertyName: 'lastname', operator: 'EQ', value: rest.join(' ') },
        { propertyName: 'associatedcompanyid', operator: 'EQ', value: input.companyExternalId },
      ],
      ['hubspot_owner_id'],
    );
  }

  function leadOut(contact: Obj, company: Obj | undefined, rule: { property: string; value: string }): QualifiedLead {
    const p = contact.properties;
    const cp = company?.properties ?? {};
    const qualifiedProp = rule.property === 'lifecyclestage' ? `hs_lifecyclestage_${rule.value}_date` : null;
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
    return {
      contact: {
        externalId: contact.id,
        name: name || null,
        email: text(p.email),
        title: text(p.jobtitle),
        phone: text(p.phone) ?? text(p.mobilephone),
        linkedin: text(p.hs_linkedin_url),
      },
      company: company
        ? {
            externalId: company.id,
            name: cp.name ?? company.id,
            domain: text(cp.domain),
            website: text(cp.website),
            location: [cp.city, cp.state, cp.country].filter(Boolean).join(', ') || null,
            employees: toInt(cp.numberofemployees),
            description: text(cp.description),
          }
        : null,
      lifecycleStage: p.lifecyclestage ?? '',
      qualifiedAt: toIso(qualifiedProp ? p[qualifiedProp] : null) ?? toIso(p.hs_lastmodifieddate) ?? toIso(p.createdate) ?? new Date().toISOString(),
      raw: Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)),
    };
  }

  const leadProps = (rule: { property: string; value: string }) => [
    ...new Set([...CONTACT_PROPS, rule.property, ...(rule.property === 'lifecyclestage' ? [`hs_lifecyclestage_${rule.value}_date`] : [])]),
  ];

  async function withCompanies(contacts: Obj[], rule: { property: string; value: string }): Promise<QualifiedLead[]> {
    const ids = [...new Set(contacts.map((c) => c.properties.associatedcompanyid).filter((id): id is string => !!id))];
    const companies = ids.length ? await readBatch('companies', ids, COMPANY_PROPS) : new Map<string, Obj>();
    return contacts.map((c) => leadOut(c, companies.get(c.properties.associatedcompanyid ?? ''), rule));
  }

  async function activitiesOf(object: 'emails' | 'calls' | 'meetings', companyId: string, since: string) {
    const rows = await searchAll(
      object,
      [
        { propertyName: 'associations.company', operator: 'EQ', value: companyId },
        { propertyName: 'hs_timestamp', operator: 'GTE', value: toMs(since) },
      ],
      object === 'emails' ? ['hs_timestamp', 'hubspot_owner_id', 'hs_email_direction'] : ['hs_timestamp', 'hubspot_owner_id'],
      500,
      [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }],
    );
    return rows.flatMap((r) => {
      const occurredAt = toIso(r.properties.hs_timestamp);
      if (!occurredAt) return [];
      const kind = object === 'emails' ? (r.properties.hs_email_direction === 'INCOMING_EMAIL' ? 'reply' : 'email') : object === 'calls' ? 'call' : 'meeting';
      return [{ externalId: r.id, kind: kind as 'email' | 'reply' | 'call' | 'meeting', occurredAt, actorOwnerExternalId: text(r.properties.hubspot_owner_id) }];
    });
  }

  const adapter: CrmAdapter = {
    capabilities: { webhooks: { deals: true, activities: true, lifecycle: true }, customProperties: true, taskDueDates: true, noteFingerprint: true, ownerRoster: true },

    async test(): Promise<TestResult> {
      let account: z.infer<typeof accountSchema> | null = null;
      try {
        account = await call(accountSchema, 'GET', '/account-info/v3/details');
      } catch (e) {
        if (e instanceof HubSpotError && e.status === 401) return { ok: false, message: TOKEN_REFUSED };
        // Without the account details scope the portal id still comes from the token's own info below.
        if (!(e instanceof HubSpotError && (e.status === 403 || e.status === 404))) throw e;
      }
      const info = await call(tokenInfoSchema, 'POST', '/oauth/v2/private-apps/get/access-token-info', { tokenKey: creds.value }, true);
      const portalId = account?.portalId ?? info.hubId;
      const facts = portalId ? { portal_id: portalId, portal_name: account?.companyName ?? `HubSpot portal ${portalId}` } : undefined;
      const { missing, ownersReadable } = missingPermissions(new Set(info.scopes));
      if (missing.length) return { ok: false, message: 'HubSpot needs more permissions for this token.', missingPermissions: missing, ...(facts ? { facts } : {}) };
      const connected = facts ? `Connected to ${facts.portal_name}.` : 'Connected to HubSpot.';
      return { ok: true, message: ownersReadable ? connected : `${connected} ${OWNERS_WARNING}`, ...(facts ? { facts } : {}) };
    },

    async findCompany({ domain }) {
      const c = await companyByDomain(domain);
      if (!c) return null;
      const deals = await dealsForCompany(c.id);
      return {
        externalId: c.id,
        name: c.properties.name ?? domain,
        ownerExternalId: text(c.properties.hubspot_owner_id),
        lifecycle: text(c.properties.lifecyclestage),
        openDeals: deals.filter((d) => d.status === 'open').length,
        deals,
      };
    },

    async upsertCompany(input) {
      const existing = input.externalId ? await companyById(input.externalId) : await companyByDomain(input.domain);
      const ours = clean(input.properties);
      if (existing) {
        // Fill gaps and refresh Scout's fields; never take a company from the owner it already has.
        const ex = existing.properties;
        const mayOwn = !ex.hubspot_owner_id || input.replaceableOwner || ex.hubspot_owner_id === input.ownerExternalId;
        const owner = mayOwn && input.ownerExternalId ? input.ownerExternalId : text(ex.hubspot_owner_id);
        const patch = clean({
          website: ex.website ? null : input.website,
          city: ex.city ? null : input.location,
          numberofemployees: ex.numberofemployees ? null : input.employees,
          description: ex.description ? null : input.description,
          ...ours,
          ...(mayOwn && input.ownerExternalId ? { hubspot_owner_id: input.ownerExternalId } : {}),
        });
        if (Object.keys(patch).length) await call(anySchema, 'PATCH', `/crm/v3/objects/companies/${existing.id}`, { properties: patch });
        return { externalId: existing.id, created: false, ownerExternalId: owner };
      }
      const created = await call(
        objSchema,
        'POST',
        '/crm/v3/objects/companies',
        {
          properties: clean({
            name: input.name,
            domain: input.domain.trim().toLowerCase(),
            website: input.website,
            city: input.location,
            numberofemployees: input.employees,
            description: input.description,
            hubspot_owner_id: input.ownerExternalId,
            ...ours,
          }),
        },
      );
      return { externalId: created.id, created: true, ownerExternalId: input.ownerExternalId };
    },

    async findPerson(input) {
      const p = await personByEmailOrName(input);
      return p ? { externalId: p.id, ownerExternalId: text(p.properties.hubspot_owner_id) } : null;
    },

    async upsertPerson(input) {
      const existing = input.externalId
        ? await getOrNull(objSchema, `/crm/v3/objects/contacts/${input.externalId}?properties=hubspot_owner_id`)
        : input.email
          ? await personByEmailOrName({ email: input.email })
          : await personByEmailOrName({ name: input.name, companyExternalId: input.companyExternalId });
      const [first = '', ...rest] = input.name.trim().split(/\s+/);
      const p = clean({
        email: input.email,
        firstname: first,
        lastname: rest.join(' '),
        jobtitle: input.title,
        phone: input.phones?.[0],
        mobilephone: input.phones?.[1],
        hs_linkedin_url: input.linkedin,
      });
      let id: string;
      let created = false;
      if (existing) {
        id = existing.id;
        // Same rule as companies: keep an owner that is already set unless the handoff says to take it over.
        const currentOwner = text(existing.properties.hubspot_owner_id);
        if (input.ownerExternalId && (input.takeOverOwner || (!currentOwner && !input.externalId))) p.hubspot_owner_id = input.ownerExternalId;
        await call(anySchema, 'PATCH', `/crm/v3/objects/contacts/${id}`, { properties: p });
      } else {
        if (input.ownerExternalId) p.hubspot_owner_id = input.ownerExternalId;
        id = (await call(objSchema, 'POST', '/crm/v3/objects/contacts', { properties: p })).id;
        created = true;
      }
      await associate('contacts', id, 'companies', input.companyExternalId);
      return { externalId: id, created };
    },

    async upsertNote(input) {
      const stored = async (id: string) => (await getOrNull(objSchema, `/crm/v3/objects/notes/${id}?properties=hs_note_body`))?.properties.hs_note_body ?? null;
      const personIds = input.personExternalIds ?? [];
      if (input.externalId) {
        const current = await stored(input.externalId);
        // Update in place only when the note is still exactly what Scout last wrote (or Scout has no record of it).
        const untouched = current != null && (!input.expectedFingerprint || noteFingerprint(current) === input.expectedFingerprint);
        if (untouched) {
          await call(anySchema, 'PATCH', `/crm/v3/objects/notes/${input.externalId}`, { properties: { hs_note_body: input.html, hs_timestamp: new Date().toISOString() } });
          for (const pid of personIds) await associate('notes', input.externalId, 'contacts', pid);
          return { externalId: input.externalId, fingerprint: noteFingerprint((await stored(input.externalId)) ?? input.html), kept: false };
        }
      }
      const associations = [
        { to: { id: input.companyExternalId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.noteToCompany }] },
        ...personIds.map((id) => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.noteToContact }] })),
      ];
      const created = await call(objSchema, 'POST', '/crm/v3/objects/notes', {
        properties: clean({ hs_note_body: input.html, hs_timestamp: new Date().toISOString(), hubspot_owner_id: input.ownerExternalId }),
        associations,
      });
      // kept: an earlier note existed but had been edited in the CRM, so it was left as is.
      return { externalId: created.id, fingerprint: noteFingerprint((await stored(created.id)) ?? input.html), kept: !!input.externalId };
    },

    async upsertTask(input) {
      const due = input.dueAt ?? new Date(Date.now() + 86_400_000).toISOString();
      const p = clean({ hs_task_subject: input.subject, hs_task_body: input.body, hubspot_owner_id: input.ownerExternalId, hs_timestamp: due });
      if (input.externalId) {
        const current = await getOrNull(objSchema, `/crm/v3/objects/tasks/${input.externalId}?properties=hs_task_status`);
        if (current) {
          // A completed task is left as it is: not reopened, and no second one is made.
          if (current.properties.hs_task_status === 'COMPLETED') return { externalId: current.id, status: 'completed' as const };
          await call(anySchema, 'PATCH', `/crm/v3/objects/tasks/${input.externalId}`, { properties: p });
          return { externalId: input.externalId, status: 'open' as const };
        }
      }
      const associations = [
        { to: { id: input.companyExternalId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.taskToCompany }] },
        ...(input.personExternalId ? [{ to: { id: input.personExternalId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.taskToContact }] }] : []),
      ];
      const created = await call(objSchema, 'POST', '/crm/v3/objects/tasks', {
        properties: { ...p, hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_task_type: 'TODO' },
        associations,
      });
      return { externalId: created.id, status: 'open' as const };
    },

    async closeTask({ externalId }) {
      await call(anySchema, 'PATCH', `/crm/v3/objects/tasks/${externalId}`, { properties: { hs_task_status: 'COMPLETED' } });
      return { status: 'completed' as const };
    },

    async listOwners() {
      const out: { externalId: string; name: string; email: string | null; active: boolean }[] = [];
      // HubSpot lists active owners by default; former ones need `archived=true`.
      for (const archived of [false, true]) {
        let after: string | undefined;
        do {
          const r = await call(ownersSchema, 'GET', `/crm/v3/owners?limit=100${archived ? '&archived=true' : ''}${after ? `&after=${after}` : ''}`);
          for (const o of r.results) out.push({ externalId: o.id, name: ownerName(o), email: o.email ?? null, active: !archived });
          after = r.paging?.next?.after;
        } while (after && out.length < 2000);
      }
      return out;
    },

    async readFollowThrough({ companyExternalId, taskExternalIds }) {
      const c = await call(
        companyAssocSchema,
        'GET',
        `/crm/v3/objects/companies/${companyExternalId}?properties=lifecyclestage,hubspot_owner_id,hs_last_sales_activity_timestamp,notes_last_contacted,hs_num_open_deals&associations=emails,calls,meetings,deals`,
      );
      const n = (k: string) => c.associations?.[k]?.results.length ?? 0;
      const tasks = taskExternalIds.length ? [...(await readBatch('tasks', taskExternalIds, ['hs_task_status', 'hs_timestamp'])).values()] : [];
      const p = c.properties;
      return {
        tasks: tasks.map((t) => ({ externalId: t.id, status: t.properties.hs_task_status === 'COMPLETED' ? ('completed' as const) : ('open' as const), dueAt: toIso(t.properties.hs_timestamp) })),
        emails: n('emails'),
        calls: n('calls'),
        meetings: n('meetings'),
        deals: n('deals'),
        openDeals: toInt(p.hs_num_open_deals) ?? 0,
        stage: text(p.lifecyclestage),
        ownerExternalId: text(p.hubspot_owner_id),
        lastActivityAt: toIso(p.hs_last_sales_activity_timestamp) ?? toIso(p.notes_last_contacted),
      };
    },

    async listActivities({ companyExternalId, since }) {
      const all = (await Promise.all((['emails', 'calls', 'meetings'] as const).map((o) => activitiesOf(o, companyExternalId, since)))).flat();
      return all.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.externalId.localeCompare(b.externalId));
    },

    async listDeals(input) {
      if ('companyExternalId' in input) return dealsForCompany(input.companyExternalId);
      const rows = await searchAll('deals', [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: toMs(input.changedSince) }], DEAL_PROPS, MAX_SEARCH_RESULTS, [
        { propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' },
      ]);
      // A deal belongs to its first associated company; one with no company cannot be linked to an account.
      const companyOf = new Map<string, string>();
      for (let i = 0; i < rows.length; i += 100) {
        const r = await call(dealAssocSchema, 'POST', '/crm/v4/associations/deals/companies/batch/read', { inputs: rows.slice(i, i + 100).map((d) => ({ id: d.id })) }, true);
        for (const x of r.results) if (x.to[0]) companyOf.set(x.from.id, x.to[0].toObjectId);
      }
      return rows.flatMap((d) => {
        const companyId = companyOf.get(d.id);
        return companyId ? [dealOut(d, companyId)] : [];
      });
    },

    async listQualifiedLeads({ changedSince, rule }) {
      const contacts = await searchAll(
        'contacts',
        [
          { propertyName: rule.property, operator: 'EQ', value: rule.value },
          { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: toMs(changedSince) },
        ],
        leadProps(rule),
        200,
        [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      );
      return withCompanies(contacts, rule);
    },

    async readQualifiedLead({ contactId, rule }) {
      const c = await getOrNull(objSchema, `/crm/v3/objects/contacts/${contactId}?properties=${leadProps(rule).join(',')}`);
      if (!c || c.properties[rule.property] !== rule.value) return null;
      return (await withCompanies([c], rule))[0] ?? null;
    },

    async existingProperties() {
      return (await call(namesSchema, 'GET', '/crm/v3/properties/companies')).results.map((p) => p.name);
    },

    async setUpProperties({ groupName, properties }) {
      const have = new Set(await adapter.existingProperties({}));
      const missing = properties.filter((p) => !have.has(p.name));
      if (!missing.length) return { created: [] };
      const groups = await call(namesSchema, 'GET', '/crm/v3/properties/companies/groups');
      if (!groups.results.some((g) => g.name === groupName)) {
        await call(anySchema, 'POST', '/crm/v3/properties/companies/groups', { name: groupName, label: groupName.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) });
      }
      const fieldTypes = { string: 'text', number: 'number', date: 'date', enumeration: 'select' } as const;
      const created: string[] = [];
      for (const p of missing) {
        await call(anySchema, 'POST', '/crm/v3/properties/companies', {
          name: p.name,
          label: p.label,
          type: p.type,
          fieldType: p.fieldType ?? fieldTypes[p.type],
          groupName,
          description: p.description,
          ...(p.options ? { options: p.options.map((o, i) => ({ label: o, value: o, displayOrder: i })) } : {}),
        });
        created.push(p.name);
      }
      return { created };
    },

    // The client secret is a separate credential this adapter is not built from, so it cannot check a signature.
    // Fail closed: the pure `verifyHubSpotV3` check (Task 12) runs in the inbound route before the adapter is asked.
    async verifyWebhook() {
      return false;
    },

    async parseWebhook({ rawBody }) {
      let events: unknown;
      try {
        events = JSON.parse(rawBody);
      } catch {
        return [];
      }
      const eventSchema = z.object({ subscriptionType: z.string(), objectId: z.union([z.number(), z.string()]), propertyName: z.string().optional() });
      const grouped = new Map<z.infer<typeof webhookEventSchema>['kind'], Set<string>>();
      for (const raw of Array.isArray(events) ? events : []) {
        const e = eventSchema.safeParse(raw);
        if (!e.success) continue;
        const [object = ''] = e.data.subscriptionType.split('.');
        const kind =
          object === 'deal'
            ? 'deal'
            : object === 'contact' && e.data.propertyName === 'lifecyclestage'
              ? 'lifecycle'
              : ['email', 'call', 'meeting', 'engagement'].includes(object)
                ? 'activity'
                : null;
        if (!kind) continue;
        grouped.set(kind, (grouped.get(kind) ?? new Set()).add(String(e.data.objectId)));
      }
      return [...grouped].map(([kind, ids]) => ({ kind, externalIds: [...ids] }));
    },
  };
  return adapter;
}
