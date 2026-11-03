import { and, eq, inArray } from 'drizzle-orm';
import { getAccount, getSummaries, isKnownFactKey, listBuyingRoles, type PersonView } from '@/modules/accounts';
import { getRun } from '@/modules/ai-tasks';
import { PROVIDERS, checkCap, connectionStatus, gateway, markConnectionFailing } from '@/modules/integrations';
import { ensureVendorSource, normaliseDomain, submitArrival } from '@/modules/intake';
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
import { PEOPLE_PER_ROLE } from '../domain/prices';
import { readWebsiteInput } from '../domain/read-website';
import { nothingFound, searchTitles } from '../domain/run';
import { readWebsite } from '../tasks/read-website';
import { fromStoredEstimate } from './requests';

// The run of an approved request (Rulings 8 and 9). State the job must keep when it throws (the wait for a limit,
// `running`, a retry's error) is committed in its own transaction; the end state is written in the job's transaction,
// with the arrival, and the job returns normally, also when the request failed.

type Row = typeof request.$inferSelect;
type FactItem = { key: string; value: unknown; url?: string };

/** What the run has found so far: kept when it stops early. */
type Found = { company: CompanyFacts | null; people: Person[]; signals: Signal[]; facts: FactItem[]; credits: number; costCents: number; readByRules: boolean };

/** A redelivery of a run that crashed finds it `running`; any other status means there is nothing to do. */
const RUNNABLE: RequestStatus[] = ['approved', 'running'];
/** `arrival.v1` takes at most 50 signals. */
const MAX_SIGNALS = 50;

const providerName = (key: string) => PROVIDERS.find((p) => p.key === key)?.name ?? key;
const subject = (id: string) => ({ type: 'enrichment_request', id });

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

/** The target titles of the account's lead offer (a person's pick, else Scout's best), or none. */
async function offerTitles(ctx: ModuleContext, accountId: string): Promise<string[]> {
  const [s] = await getSummaries(ctx, [accountId]);
  const offerId = s?.leadOfferOverrideId ?? s?.bestOfferId;
  if (!offerId) return [];
  try {
    return (await getOffer(ctx, offerId)).targetTitles;
  } catch (e) {
    if (e instanceof ScoutError && e.status === 404) return [];
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
  /** One gateway call per operation, holding its worst case against the limit and settling what it spent (Pitfall 3). */
  const call = async <T>(operation: string, worst: number, fn: (a: EnrichmentAdapter) => Promise<Paid<T>>): Promise<T> => {
    const paid = await gateway.call(ctx, r.providerKey, operation, (a) => fn(a as EnrichmentAdapter), {
      module: 'enrichment',
      unit: 'credits',
      units: worst,
      measure: (p: Paid<T>) => ({ units: p.creditsUsed }),
      requestSummary: summary,
    });
    f.credits += paid.creditsUsed;
    return paid.value;
  };
  const params = r.params as { roles?: string[]; person_ids?: string[] };

  switch (r.kind as EnrichmentKind) {
    case 'company_firmographics':
      f.company = await call('organizations/enrich', 1, (a) => a.companyEnrich({ domain }));
      return;
    case 'people_for_roles': {
      const labels = new Map((await listBuyingRoles(ctx)).map((x) => [x.key, x.label]));
      const titles = await offerTitles(ctx, r.accountId);
      const seen = new Set<string>();
      for (const role of params.roles ?? []) {
        const max = PEOPLE_PER_ROLE;
        const found = await call('mixed_people/api_search', 0, (a) => a.peopleSearch({ domain, titles: searchTitles(role, labels.get(role) ?? role, titles), max }));
        for (const p of found.slice(0, max)) {
          const ref = p.provider_ref ?? `${p.name}|${p.title}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          const revealed = await call('people/match', 1, (a) => a.revealEmail({ person: p, domain }));
          f.people.push({ ...revealed, buying_role: role });
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
      // One lookup for the organization id, so job postings and news need no lookup of their own.
      const company = await call('organizations/enrich', 1, (a) => a.companyEnrich({ domain }));
      const orgId = company?.provider_ref ?? undefined;
      const worst = orgId ? 1 : 2;
      f.signals.push(...(await call('organizations/job_postings', worst, (a) => a.jobPostings({ domain, orgId }))));
      f.signals.push(...(await call('news_articles/search', worst, (a) => a.news({ domain, orgId }))));
      return;
    }
    case 'website_read': {
      const { pages } = await gateway.call(ctx, r.providerKey, 'website.read', (a) => (a as EnrichmentAdapter).readSite({ domain }) as Promise<{ pages: SitePage[] }>, {
        module: 'enrichment',
        requestSummary: summary,
      });
      const read = await readWebsite(ctx, readWebsiteInput(domain, pages), { subject: subject(r.id) });
      f.readByRules = read.mode !== 'live';
      f.costCents += (await getRun(ctx, read.runId))?.costCents ?? 0;
      const o = read.output;
      if (o.description) f.facts.push({ key: 'description', value: o.description.text, url: o.description.url });
      if (o.industry_guess) f.facts.push({ key: 'industry', value: o.industry_guess.text, url: o.industry_guess.url });
      if (o.technologies.length) f.facts.push({ key: 'technologies', value: o.technologies.map((x) => x.name), url: o.technologies[0]!.url });
      for (const x of o.facts) if (isKnownFactKey(x.key)) f.facts.push({ key: x.key, value: x.value, url: x.url });
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

const hasResults = (f: Found) => !!f.company || f.people.length + f.signals.length + f.facts.length > 0;

/** Sends what was found as one targeted arrival from the provider's vendor source (Ruling 8, step 3). */
async function submit(ctx: ModuleContext, r: Row, f: Found): Promise<{ arrivalIds: string[]; found: number }> {
  if (!hasResults(f)) return { arrivalIds: [], found: 0 };
  const vendorSourceId = await ensureVendorSource(ctx, r.providerKey, providerName(r.providerKey));
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
  const out = await submitArrival(sending, body, { channel: 'enrichment', inline: true, vendorSourceId });
  const i = out.inlineResult;
  const facts = Object.keys(company).length + f.facts.length;
  return { arrivalIds: [out.arrivalId], found: (i ? i.personIds.length + i.signalIds.length : people.length + signals.length) + facts };
}

async function roleLabels(ctx: ModuleContext, r: Row): Promise<string[]> {
  const labels = new Map((await listBuyingRoles(ctx)).map((x) => [x.key, x.label]));
  return ((r.params as { roles?: string[] }).roles ?? []).map((k) => labels.get(k) ?? k);
}

/** Submits what was found and writes `completed` or `partial` with the result; publishes `completed`. */
async function finish(ctx: ModuleContext, r: Row, f: Found, stopped?: ClassifiedError): Promise<void> {
  const { arrivalIds, found } = await submit(ctx, r, f);
  const name = providerName(r.providerKey);
  const message = stopped ? stopped.message : found === 0 ? nothingFound(name, r.kind as EnrichmentKind, await roleLabels(ctx, r)) : f.readByRules ? 'Read by rules' : undefined;
  const result = {
    arrival_ids: arrivalIds,
    credits_used: f.credits,
    cost_cents: f.costCents,
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
      costCents: f.costCents,
      currency,
      requestedBy: r.requestedBy,
      ...(r.requestingSourceId ? { requestingSourceId: r.requestingSourceId } : {}),
    },
    subject(r.id),
  );
}

/** Submits anything found, writes `failed` and publishes `failed`. The job then returns normally: no retry. */
async function fail(ctx: ModuleContext, r: Row, f: Found, c: ClassifiedError): Promise<void> {
  const { arrivalIds, found } = await submit(ctx, r, f);
  const now = new Date();
  await ctx.tx
    .update(request)
    .set({
      status: 'failed',
      error: { kind: c.kind, message: c.message },
      result: arrivalIds.length ? { arrival_ids: arrivalIds, credits_used: f.credits, cost_cents: f.costCents, found } : null,
      waitingReason: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, r.id)));
  await publish(
    ctx,
    requestFailed,
    { requestId: r.id, accountId: r.accountId, providerKey: r.providerKey, errorKind: c.kind, message: c.message, creditsUsed: f.credits, costCents: f.costCents },
    subject(r.id),
  );
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

  const f: Found = { company: null, people: [], signals: [], facts: [], credits: 0, costCents: 0, readByRules: false };
  const account = await getAccount(ctx, r.accountId);
  const domain = normaliseDomain(account?.domain) ?? normaliseDomain(account?.websiteUrl);
  if (!domain) return fail(ctx, r, f, { kind: 'bad_request', message: 'Add the company’s website first.', retry: false });

  // 2. The provider's operations.
  try {
    await operate(ctx, r, domain, f);
  } catch (e) {
    const c = classifyError(e, name);
    if (c.kind === 'cap_reached') {
      if (hasResults(f)) return finish(ctx, r, f, c);
      await commit(ctx, r.id, { waitingReason: waiting });
      throw e;
    }
    if (c.kind === 'out_of_credits') return finish(ctx, r, f, c);
    if (c.retry) {
      // Kept for the request's status while the job backs off; the last try leaves it (dead-job handling is PLT's).
      await commit(ctx, r.id, { error: { kind: c.kind, message: c.message } });
      throw e;
    }
    if (c.kind === 'auth') await markConnectionFailing(ctx, r.providerKey, c.message);
    return fail(ctx, r, f, c);
  }

  // 3 and 4. The arrival, then the end state.
  return finish(ctx, r, f);
}
