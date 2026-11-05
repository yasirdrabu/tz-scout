import { and, eq, inArray } from 'drizzle-orm';
import { getAccount, getSummaries, listBuyingRoles, type AccountView, type PersonView } from '@/modules/accounts';
import { getRun } from '@/modules/ai-tasks';
import { PROVIDERS, checkCap, connectionStatus, gateway, getRates, markConnectionFailing, priceCents, priceOf } from '@/modules/integrations';
import { checkArrivalCap, countryCode, ensureVendorSource, findArrivalByRef, normaliseDomain, readSource, submitArrival } from '@/modules/intake';
import { getOffer } from '@/modules/offers';
import { tenantSummary } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { withTenant } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import type { CompanyFacts, EnrichmentAdapter, Paid, Person, Signal, SitePage } from '../contracts/adapter';
import { requestCompleted, requestFailed } from '../contracts/events';
import type { EnrichmentKind, RequestStatus } from '../contracts/types';
import { request } from '../db/schema';
import { classifyError, type ClassifiedError } from '../domain/errors';
import { MAX_PEOPLE, PEOPLE_PER_ROLE } from '../domain/prices';
import { readWebsiteInput, websiteFacts } from '../domain/read-website';
import { nothingFound, searchTitles, type LeadOffer } from '../domain/run';
import { readWebsite } from '../tasks/read-website';
import { fromStoredEstimate } from './requests';

// The run of an approved request (Rulings 8 and 9). State the job must keep when it throws (the wait for a limit,
// `running`, a retry's error) is committed in its own transaction; the end state is written in the job's transaction,
// with the arrival, and the job returns normally, also when the request failed.

type Row = typeof request.$inferSelect;
/** `org_id` is the run's own: a signals refresh's organization id, kept while it waits on a limit. */
type Params = { roles?: string[]; person_ids?: string[]; org_id?: string };
type FactItem = { key: string; value: unknown; url?: string };
type Failure = Pick<ClassifiedError, 'kind' | 'message'>;
type Submitted = { arrivalIds: string[]; found: number };

/** What the run has found so far: kept when it stops early. */
type Found = {
  company: CompanyFacts | null;
  people: Person[];
  signals: Signal[];
  facts: FactItem[];
  credits: number;
  /** Claude's cost for a website read. */
  aiCents: number;
  readByRules: boolean;
  /** A signals refresh's organization id, once looked up: kept on the request if a limit stops the run. */
  orgId?: string;
};

/** A redelivery of a run that crashed finds it `running`; any other status means there is nothing to do. */
const RUNNABLE: RequestStatus[] = ['approved', 'running'];
/** `arrival.v1` takes at most 50 signals. */
const MAX_SIGNALS = 50;

const providerName = (key: string) => PROVIDERS.find((p) => p.key === key)?.name ?? key;
const subject = (id: string) => ({ type: 'enrichment_request', id });

const sourcePaused = (name: string) => `The ${name} source is paused. An owner can turn it back on in Sources.`;
const sourceFull = (name: string) => `The ${name} source reached its daily arrival limit. Try again tomorrow.`;

/** Intake refused the arrival's body, in its own words: its first problem, else its title. */
function storeRefused(name: string, e: ScoutError): string {
  const why = (e.errors?.[0]?.message ?? e.detail ?? e.message).trim().replace(/\.?$/, '.');
  return `Scout couldn't store what ${name} found. ${why}`;
}

/** Intake refused the arrival: the vendor source is paused or archived, at its daily arrival limit, or the body. */
class SubmitRefused extends Error {}

/** Writes `set` in its own committed transaction; false when the request is no longer in one of `from`. */
async function commit(ctx: ModuleContext, id: string, set: Partial<Row>, from: RequestStatus[] = RUNNABLE): Promise<boolean> {
  const rows = await withTenant(ctx.tenantId, (tx) =>
    tx
      .update(request)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, id), inArray(request.status, from)))
      .returning({ id: request.id }),
  );
  return rows.length > 0;
}

/** The refusal the worker waits on (Ruling 8), as the gateway throws it. */
function capWait(name: string, resetsAt: Date | null): ScoutError {
  return new ScoutError({
    slug: 'blocked_by_cap',
    status: 429,
    title: `${name} reached its monthly limit.`,
    detail: 'An owner can raise it in Settings, Integrations.',
    ...(resetsAt ? { extensions: { resets_at: resetsAt.toISOString() } } : {}),
  });
}

/** The account's lead offer (a person's pick, else Scout's best), or null. */
async function leadOffer(ctx: ModuleContext, accountId: string): Promise<LeadOffer | null> {
  const [s] = await getSummaries(ctx, [accountId]);
  const offerId = s?.leadOfferOverrideId ?? s?.bestOfferId;
  if (!offerId) return null;
  try {
    const o = await getOffer(ctx, offerId);
    return { targetTitles: o.targetTitles, targetBuyingRoles: o.targetBuyingRoles };
  } catch (e) {
    if (e instanceof ScoutError && e.status === 404) return null;
    throw e;
  }
}

const asPerson = (p: PersonView): Person => ({
  name: [p.firstName, p.lastName].filter(Boolean).join(' ') || null,
  first_name: p.firstName,
  last_name: p.lastName,
  title: p.title,
  linkedin_url: p.linkedinUrl,
});

/** Runs the kind's provider operations, adding what each finds to `f` as it goes, so an error keeps the rest. */
async function operate(ctx: ModuleContext, r: Row, domain: string, f: Found): Promise<void> {
  const summary = { requestId: r.id, accountId: r.accountId };
  // Read before the calls: pricing an answer must not need the job's transaction, which a timeout loses.
  const rates = new Map((await getRates(ctx, r.providerKey)).map((x) => [x.item, x.centsPerUnit]));
  /**
   * One gateway call per operation, holding its worst case against the limit and settling what it spent (Pitfall 3).
   * A live call's credits are priced at the provider's rate (R3a Ruling 2); a sample call costs 0.
   */
  const call = async <T>(operation: string, worst: number, fn: (a: EnrichmentAdapter) => Promise<Paid<T>>): Promise<T> => {
    const paid = await gateway.call(ctx, r.providerKey, operation, (a) => fn(a as EnrichmentAdapter), {
      module: 'enrichment',
      unit: 'credits',
      units: worst,
      accountId: r.accountId,
      measure: (p: Paid<T>, { live }) => ({
        units: p.creditsUsed,
        costCents: live ? priceOf(rates, [{ item: 'credit', units: p.creditsUsed }]) : 0,
      }),
      requestSummary: summary,
    });
    f.credits += paid.creditsUsed;
    return paid.value;
  };
  const params = r.params as Params;
  /** An arrival needs a title on every signal: a provider's untitled item (an Apollo article with none) is dropped. */
  const titled = (xs: Signal[]) => xs.filter((s) => s.title?.trim());

  switch (r.kind as EnrichmentKind) {
    case 'company_firmographics':
      f.company = await call('organizations/enrich', 1, (a) => a.companyEnrich({ domain }));
      return;
    case 'people_for_roles': {
      const labels = new Map((await listBuyingRoles(ctx)).map((x) => [x.key, x.label]));
      const offer = await leadOffer(ctx, r.accountId);
      // A person found again for another role is not revealed again; they gain that role too.
      const byRef = new Map<string, Person>();
      for (const role of params.roles ?? []) {
        const max = PEOPLE_PER_ROLE;
        const titles = searchTitles(role, labels.get(role) ?? role, offer);
        const found = await call('mixed_people/api_search', 0, (a) => a.peopleSearch({ domain, titles, max }));
        for (const p of found.slice(0, max)) {
          const ref = p.provider_ref ?? `${p.name}|${p.title}`;
          const known = byRef.get(ref);
          if (known) {
            known.guessed_buying_roles = [...new Set([...(known.guessed_buying_roles ?? []), role])];
            continue;
          }
          // One arrival takes at most 25 people: past that, nothing more is revealed (review I2).
          if (f.people.length >= MAX_PEOPLE) continue;
          const revealed = await call('people/match', 1, (a) => a.revealEmail({ person: p, domain }));
          const person: Person = { ...revealed, guessed_buying_roles: [role] };
          byRef.set(ref, person);
          f.people.push(person);
        }
      }
      return;
    }
    case 'email_reveal': {
      const ids = new Set(params.person_ids ?? []);
      const people = ((await getAccount(ctx, r.accountId))?.people ?? []).filter((p) => ids.has(p.id));
      for (const p of people) f.people.push(await call('people/match', 1, (a) => a.revealEmail({ person: asPerson(p), domain })));
      return;
    }
    case 'signals_refresh': {
      // One lookup for the organization id, so job postings and news need no lookup of their own (3 credits in all).
      // With no such company there is nothing to look for: the run stops and finds nothing new. An id a limit stopped
      // an earlier try after is reused, so waiting for the limit doesn't pay for the lookup again (review M2).
      const orgId = params.org_id ?? (await call('organizations/enrich', 1, (a) => a.companyEnrich({ domain })))?.provider_ref;
      if (!orgId) return;
      f.orgId = orgId;
      f.signals.push(...titled(await call('organizations/job_postings', 1, (a) => a.jobPostings({ domain, orgId }))));
      f.signals.push(...titled(await call('news_articles/search', 1, (a) => a.news({ domain, orgId }))));
      return;
    }
    case 'website_read': {
      const { pages } = await gateway.call(ctx, r.providerKey, 'website.read', (a) => (a as EnrichmentAdapter).readSite({ domain }) as Promise<{ pages: SitePage[] }>, {
        module: 'enrichment',
        requestSummary: summary,
      });
      const read = await readWebsite(ctx, readWebsiteInput(domain, pages), { subject: subject(r.id), accountId: r.accountId });
      f.readByRules = read.mode !== 'live';
      f.aiCents += (await getRun(ctx, read.runId))?.costCents ?? 0;
      f.facts.push(...websiteFacts(read.output));
      return;
    }
  }
}

/** The company fields the provider gave, without its own id. */
function companyFields(c: CompanyFacts | null): Record<string, unknown> {
  if (!c) return {};
  const { provider_ref: _ref, ...rest } = c;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0)));
}

/** What the account already holds for each field `found` counts. Name, domain and website only identify the company. */
const HELD: Record<string, (a: AccountView) => unknown> = {
  linkedin_url: (a) => a.linkedinUrl,
  industry: (a) => a.industry,
  employees: (a) => a.employees,
  employees_range: (a) => a.employeesMin ?? a.employees,
  revenue_cents: (a) => a.revenueCents,
  revenue_range: (a) => a.revenueMinCents ?? a.revenueCents,
  city: (a) => a.hqCity,
  region: (a) => a.hqState,
  country: (a) => a.hqCountry,
  description: (a) => a.description,
  technologies: (a) => a.technologies,
  keywords: (a) => a.keywords,
  parent_domain: (a) => a.parentDomain,
};

const word = (v: unknown) => String(v).trim().toLowerCase();

/** Whether the provider's value differs from what the account holds. A range is new only to an account with no figure. */
function isNew(key: string, value: unknown, held: unknown): boolean {
  if (held == null || held === '' || (Array.isArray(held) && held.length === 0)) return true;
  if (key.endsWith('_range')) return false;
  if (key === 'country') return word(countryCode(String(value)) ?? value) !== word(held);
  if (Array.isArray(value)) {
    const have = new Set((held as unknown[]).map(word));
    return value.some((v) => !have.has(word(v)));
  }
  return typeof value === 'number' ? value !== held : word(value) !== word(held);
}

/** How many of the company fields differ from what the account held before the run. */
function newCompanyFields(company: Record<string, unknown>, before: AccountView | null): number {
  return Object.entries(company).filter(([k, v]) => HELD[k] && (!before || isNew(k, v, HELD[k](before)))).length;
}

const hasResults = (f: Found) => !!f.company || f.people.length + f.signals.length + f.facts.length > 0;

/** Sends what was found as one targeted arrival from the provider's vendor source (Ruling 8, step 3). */
async function submit(ctx: ModuleContext, r: Row, f: Found, before: AccountView | null): Promise<Submitted> {
  if (!hasResults(f)) return { arrivalIds: [], found: 0 };
  const name = providerName(r.providerKey);
  const vendorSourceId = await ensureVendorSource(ctx, r.providerKey, name);
  const sending: ModuleContext = { ...ctx, actor: { kind: 'system', id: 'enrichment' }, access: { sourceId: vendorSourceId, dataLimit: { kind: 'all' } } };
  const company = companyFields(f.company);
  const people = f.people.map(({ provider_ref: _ref, ...p }) => p);
  const signals = f.signals.slice(0, MAX_SIGNALS);
  const body = {
    target_account_id: r.accountId,
    // The request id makes a redelivery's arrival a duplicate of the first (Review Focus 2).
    account: { ...company, external_ref: r.id, notes: `Requested by ${r.requestedByLabel ?? 'a teammate'}` },
    people,
    signals,
    facts: f.facts,
  };
  // A redelivery whose first try sent the arrival is answered with it, even if the source was paused since:
  // intake checks the sender before its own `external_ref` check.
  const earlier = await findArrivalByRef(ctx, vendorSourceId, r.id);
  let out;
  try {
    out = earlier
      ? { arrivalId: earlier.id, inlineResult: undefined }
      : await submitArrival(sending, body, { channel: 'enrichment', inline: true, vendorSourceId });
  } catch (e) {
    // Intake checks the sender and its daily limit before it writes anything, so this transaction can record the failure.
    if (e instanceof ScoutError && e.status === 403) throw new SubmitRefused(sourcePaused(name));
    if (e instanceof ScoutError && e.slug === 'cap-reached') throw new SubmitRefused(sourceFull(name));
    // Any other refusal (a body intake won't take) is the same on every try: fail once, don't spend again (review I2).
    if (e instanceof ScoutError && e.status >= 400 && e.status < 500) throw new SubmitRefused(storeRefused(name, e));
    throw e;
  }
  const i = out.inlineResult;
  const facts = newCompanyFields(company, before) + f.facts.length;
  return { arrivalIds: [out.arrivalId], found: (i ? i.personIds.length + i.signalIds.length : people.length + signals.length) + facts };
}

async function roleLabels(ctx: ModuleContext, r: Row): Promise<string[]> {
  const labels = new Map((await listBuyingRoles(ctx)).map((x) => [x.key, x.label]));
  return ((r.params as { roles?: string[] }).roles ?? []).map((k) => labels.get(k) ?? k);
}

/** Credits at the provider's rate (R3a Ruling 2), plus Claude's cost for a website read. */
async function costOf(ctx: ModuleContext, r: Row, f: Found): Promise<number> {
  return (await priceCents(ctx, r.providerKey, [{ item: 'credit', units: f.credits }])) + f.aiCents;
}

/** Submits what was found and writes `completed` or `partial` with the result; publishes `completed`. */
async function finish(ctx: ModuleContext, r: Row, f: Found, before: AccountView | null, stopped?: ClassifiedError): Promise<void> {
  let submitted: Submitted;
  try {
    submitted = await submit(ctx, r, f, before);
  } catch (e) {
    if (e instanceof SubmitRefused) return writeFailed(ctx, r, f, { kind: 'bad_request', message: e.message }, null);
    throw e;
  }
  const { arrivalIds, found } = submitted;
  const name = providerName(r.providerKey);
  const message = stopped ? stopped.message : found === 0 ? nothingFound(name, r.kind as EnrichmentKind, await roleLabels(ctx, r)) : f.readByRules ? 'Read by rules' : undefined;
  const costCents = await costOf(ctx, r, f);
  const result = {
    arrival_ids: arrivalIds,
    credits_used: f.credits,
    cost_cents: costCents,
    found,
    ...(message ? { message } : {}),
    ...(f.readByRules ? { read_by: 'rules' } : {}),
  };
  const now = new Date();
  await ctx.tx
    .update(request)
    .set({ status: stopped ? 'partial' : 'completed', result, error: null, waitingReason: null, finishedAt: now, updatedAt: now })
    .where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, r.id)));
  const { currency } = await tenantSummary(ctx);
  await publish(
    ctx,
    requestCompleted,
    {
      requestId: r.id,
      accountId: r.accountId,
      kind: r.kind as EnrichmentKind,
      providerKey: r.providerKey,
      arrivalIds,
      found,
      creditsUsed: f.credits,
      costCents,
      currency,
      requestedBy: r.requestedBy,
      ...(r.requestingSourceId ? { requestingSourceId: r.requestingSourceId } : {}),
    },
    subject(r.id),
  );
}

/** Writes `failed` and publishes `failed`. The job then returns normally: no retry. */
async function writeFailed(ctx: ModuleContext, r: Row, f: Found, c: Failure, submitted: Submitted | null): Promise<void> {
  const costCents = await costOf(ctx, r, f);
  const now = new Date();
  await ctx.tx
    .update(request)
    .set({
      status: 'failed',
      error: { kind: c.kind, message: c.message },
      result: submitted?.arrivalIds.length ? { arrival_ids: submitted.arrivalIds, credits_used: f.credits, cost_cents: costCents, found: submitted.found } : null,
      waitingReason: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, r.id)));
  await publish(
    ctx,
    requestFailed,
    { requestId: r.id, accountId: r.accountId, providerKey: r.providerKey, errorKind: c.kind, message: c.message, creditsUsed: f.credits, costCents },
    subject(r.id),
  );
}

/** Submits anything found (Ruling 9), then fails with `c`. A refused submit keeps `c` and drops the arrival. */
async function fail(ctx: ModuleContext, r: Row, f: Found, before: AccountView | null, c: Failure): Promise<void> {
  let submitted: Submitted | null = null;
  try {
    submitted = await submit(ctx, r, f, before);
  } catch (e) {
    if (!(e instanceof SubmitRefused)) throw e;
  }
  return writeFailed(ctx, r, f, c, submitted);
}

/** Why the provider's vendor source can't take the arrival, or null. Read before any paid call. */
async function sourceRefusal(ctx: ModuleContext, r: Row): Promise<string | null> {
  const name = providerName(r.providerKey);
  // In its own transaction: the cap check takes the source's lock, which must not be held through the provider calls.
  // A source made here (the website's, on first use) is committed with it, so the check can see it.
  return withTenant(ctx.tenantId, async (tx) => {
    const own = { ...ctx, tx };
    const id = await ensureVendorSource(own, r.providerKey, name);
    const status = (await readSource(own, id))?.status;
    if (status === 'paused' || status === 'archived') return sourcePaused(name);
    return (await checkArrivalCap(own, id)).allowed ? null : sourceFull(name);
  });
}

/** Carries out one approved request (Ruling 8). Throws only for the worker to wait (a limit) or retry. */
export async function runRequest(ctx: ModuleContext, requestId: string): Promise<void> {
  const [r] = await ctx.tx.select().from(request).where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, requestId)));
  if (!r || !RUNNABLE.includes(r.status as RequestStatus)) return;
  const name = providerName(r.providerKey);
  const waiting = `Waiting for budget: ${name} monthly limit reached`;

  // 1. The estimate against the limit. The wait is committed: the throw rolls this transaction back.
  const cap = await checkCap(ctx, r.providerKey, fromStoredEstimate(r.estimate).credits);
  if (cap.status === 'blocked') {
    await commit(ctx, r.id, { waitingReason: waiting });
    throw capWait(name, cap.resetsAt);
  }
  const mode = (await connectionStatus(ctx, r.providerKey)).mode === 'live' ? 'live' : 'mock';
  if (!(await commit(ctx, r.id, { status: 'running', startedAt: r.startedAt ?? new Date(), waitingReason: null, connectionMode: mode }))) return;

  const f: Found = { company: null, people: [], signals: [], facts: [], credits: 0, aiCents: 0, readByRules: false };
  const before = await getAccount(ctx, r.accountId);
  const domain = normaliseDomain(before?.domain) ?? normaliseDomain(before?.websiteUrl);
  if (!domain) return writeFailed(ctx, r, f, { kind: 'bad_request', message: 'Add the company’s website first.' }, null);
  // Nothing is spent on results intake would refuse. A redelivery (already running) may have its arrival already:
  // intake answers that by `external_ref` before its source checks, and the submit-time catch handles a real refusal.
  if (r.status !== 'running') {
    const refused = await sourceRefusal(ctx, r);
    if (refused) return writeFailed(ctx, r, f, { kind: 'bad_request', message: refused }, null);
  }

  // 2. The provider's operations.
  try {
    await operate(ctx, r, domain, f);
  } catch (e) {
    const c = classifyError(e, name);
    if (c.kind === 'cap_reached') {
      if (hasResults(f)) return finish(ctx, r, f, before, c);
      const orgId = f.orgId && f.orgId !== (r.params as Params).org_id ? { params: { ...(r.params as Params), org_id: f.orgId } } : {};
      await commit(ctx, r.id, { waitingReason: waiting, ...orgId });
      throw e;
    }
    // Partial means it kept something: out of credits before anything was found is a failure.
    if (c.kind === 'out_of_credits') return hasResults(f) ? finish(ctx, r, f, before, c) : fail(ctx, r, f, before, c);
    if (c.retry) {
      // Kept for the request's status while the job backs off; the last try leaves it (dead-job handling is PLT's).
      await commit(ctx, r.id, { error: { kind: c.kind, message: c.message } });
      throw e;
    }
    if (c.kind === 'auth') await markConnectionFailing(ctx, r.providerKey, c.message);
    return fail(ctx, r, f, before, c);
  }

  // 3 and 4. The arrival, then the end state.
  return finish(ctx, r, f, before);
}
