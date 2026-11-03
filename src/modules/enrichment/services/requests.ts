import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { accountNames, filterVisibleAccountIds, getAccount, listBuyingRoles } from '@/modules/accounts';
import { PROVIDERS, connectionSettings, connectionStatus } from '@/modules/integrations';
import { readSource, recordSourceFeedback } from '@/modules/intake';
import { apiKeyNames, can, requirePermission, tenantSummary, userNames, type Principal } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { requestApproved, requestCancelled, requestDeclined, requestFlagged } from '../contracts/events';
import { runRequestJob } from '../contracts/jobs';
import { KINDS, type EnrichmentKind, type Estimate, type RequestStatus } from '../contracts/types';
import { request } from '../db/schema';
import { seedEnrichmentDefaults } from '../defaults';
import { estimate, estimateText } from '../domain/estimate';
import { kindLabel, operationsFor } from '../domain/kinds';
import { WEBSITE_READ_WORST_CENTS } from '../domain/prices';
import { canTransition, statusText } from '../domain/status';

type Row = typeof request.$inferSelect;

export const REASON_NEEDED = 'Say why this is worth the spend.';
export const DECLINE_REASON_NEEDED = "Say why you're declining.";
export const PEOPLE_ONLY = 'Only a person can approve spend.';
const MAX_REASON = 500;
const OPEN: RequestStatus[] = ['flagged', 'approved', 'running'];

export type RequestInput = { kind: EnrichmentKind; providerKey: string; roles?: string[]; personIds?: string[]; reason?: string };

export type RequestView = {
  id: string;
  accountId: string;
  accountName: string | null;
  kind: EnrichmentKind;
  kindLabel: string;
  providerKey: string;
  providerName: string;
  status: RequestStatus;
  statusText: string;
  requestedByLabel: string;
  reason: string | null;
  estimate: Estimate & { text: string };
  createdAt: Date;
  decidedByLabel: string | null;
  decidedAt: Date | null;
  declineReason: string | null;
  result: { arrivalIds: string[]; creditsUsed: number; costCents: number; found: number; message?: string } | null;
  error: { kind: string; message: string } | null;
  waitingReason: string | null;
  sample: boolean;
};

// ---- The stored estimate (snake case in the row) and the domain `Estimate` (camel case): the one mapping. ----

type StoredEstimate = { credits: number; cost_cents: number; sample: boolean };
export const toStoredEstimate = (e: Estimate, sample: boolean): StoredEstimate => ({ credits: e.credits, cost_cents: e.costCents, sample });
export function fromStoredEstimate(json: unknown): Estimate & { sample: boolean } {
  const s = (json ?? {}) as Partial<StoredEstimate>;
  return { credits: s.credits ?? 0, costCents: s.cost_cents ?? 0, sample: s.sample ?? true };
}

type StoredResult = { arrival_ids?: string[]; credits_used?: number; cost_cents?: number; found?: number; message?: string };
const resultView = (json: unknown): RequestView['result'] => {
  if (!json) return null;
  const r = json as StoredResult;
  return {
    arrivalIds: r.arrival_ids ?? [],
    creditsUsed: r.credits_used ?? 0,
    costCents: r.cost_cents ?? 0,
    found: r.found ?? 0,
    ...(r.message ? { message: r.message } : {}),
  };
};

const textOf = (r: Row) =>
  statusText({
    status: r.status,
    waitingReason: r.waitingReason,
    result: r.result as { found: number; message?: string } | null,
    error: r.error as { kind: string; message: string } | null,
    declineReason: r.declineReason,
  });

// ---- Errors ----

const invalid = (path: string, title: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That enrichment request was not found.' });
const accountNotFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
const STATUS_WORD: Record<RequestStatus, string> = {
  flagged: 'waiting for approval',
  approved: 'approved',
  running: 'running',
  declined: 'declined',
  cancelled: 'cancelled',
  completed: 'done',
  partial: 'done',
  failed: 'failed',
};
const statusWord = (r: Row) => (r.status === 'cancelled' && r.declineReason === 'expired' ? 'expired' : STATUS_WORD[r.status as RequestStatus]);
const already = (r: Row) => new ScoutError({ slug: 'conflict', status: 409, title: `This request is already ${statusWord(r)}.` });
const OLD_CURSOR = 'That page link is out of date. Start from the first page.';

/** Ruling 1: approving and declining spend is for people, whatever a key's scopes say. */
function requireApprover(p: Principal): void {
  if (p.kind !== 'user') throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Forbidden', detail: PEOPLE_ONLY });
  requirePermission(p, 'enrichment:approve');
}

const mayApprove = (p: Principal) => p.kind === 'user' && can(p, 'enrichment:approve');

/** The principal as `requested_by` and in `watchers`: a user id, `key:<id>` or `oauth:<id>`. */
const principalRef = (p: Principal) => (p.kind === 'user' ? p.id : p.kind === 'api_key' ? `key:${p.id}` : `oauth:${p.id}`);

const providerName = (key: string) => PROVIDERS.find((p) => p.key === key)?.name ?? key;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

async function personName(ctx: ModuleContext, userId: string): Promise<string | undefined> {
  return (await userNames(ctx, [userId])).get(userId);
}

/** "Dana Ruiz" for a person; "Yasir's agent" for a key whose source has an owner, else the source's or key's name. */
async function requesterLabel(ctx: ModuleContext, p: Principal): Promise<string> {
  if (p.kind === 'user') return (await personName(ctx, p.id)) ?? 'A teammate';
  const src = p.sourceId ? await readSource(ctx, p.sourceId) : undefined;
  const owner = src?.ownerUserId ? await personName(ctx, src.ownerUserId) : undefined;
  if (owner) return `${firstName(owner)}'s agent`;
  if (src) return src.name;
  return (p.kind === 'api_key' ? (await apiKeyNames(ctx, [p.id])).get(p.id) : undefined) ?? 'An API key';
}

// ---- Checking a request and its estimate ----

/** The connection's money per credit and whether it answers with sample data. An unknown provider is sample data. */
export async function connectionFacts(ctx: ModuleContext, provider: string): Promise<{ sample: boolean; centsPerCredit?: number }> {
  if (!PROVIDERS.some((p) => p.key === provider)) return { sample: true };
  const { mode } = await connectionStatus(ctx, provider);
  const cents = (await connectionSettings(ctx, provider)).cents_per_credit;
  return { sample: mode !== 'live', ...(typeof cents === 'number' && Number.isInteger(cents) && cents >= 0 ? { centsPerCredit: cents } : {}) };
}

type Checked = { accountId: string; params: { roles?: string[]; person_ids?: string[] }; estimate: Estimate; sample: boolean };

/** 404 for an account the principal can't see; 400 for a kind, provider, role or person that doesn't fit. */
async function check(ctx: ModuleContext, accountId: string, input: RequestInput): Promise<Checked> {
  const account = await getAccount(ctx, accountId);
  if (!account) throw accountNotFound();
  if (!KINDS.includes(input.kind)) throw invalid('kind', 'Pick what to find.');
  if (operationsFor(input.providerKey, input.kind).length === 0) throw invalid('provider_key', `${providerName(input.providerKey)} can't do that.`);
  const params: Checked['params'] = {};
  if (input.kind === 'people_for_roles') {
    const roles = [...new Set(input.roles ?? [])];
    if (roles.length === 0) throw invalid('roles', 'Pick at least one buying role.');
    const known = new Set((await listBuyingRoles(ctx)).map((r) => r.key));
    const unknown = roles.find((r) => !known.has(r));
    if (unknown) throw invalid('roles', `"${unknown}" isn't a buying role.`);
    params.roles = roles;
  }
  if (input.kind === 'email_reveal') {
    const ids = [...new Set(input.personIds ?? [])];
    if (ids.length === 0) throw invalid('person_ids', 'Pick at least one person.');
    const onAccount = new Set(account.people.map((p) => p.id));
    if (ids.some((id) => !onAccount.has(id))) throw invalid('person_ids', "That person isn't on this account.");
    params.person_ids = ids;
  }
  const conn = await connectionFacts(ctx, input.providerKey);
  const est = estimate({
    provider: input.providerKey,
    kind: input.kind,
    roles: params.roles,
    personIds: params.person_ids,
    centsPerCredit: conn.centsPerCredit,
    aiWorstCents: WEBSITE_READ_WORST_CENTS,
  });
  return { accountId: account.id, params, estimate: est, sample: conn.sample };
}

/** The most a request would cost, in the tenant's currency, with the dialog's line (Ruling 5). */
export async function estimateFor(
  ctx: ModuleContext,
  accountId: string,
  input: RequestInput,
): Promise<{ credits: number; costCents: number; currency: string; sample: boolean; text: string }> {
  const c = await check(ctx, accountId, input);
  const { currency } = await tenantSummary(ctx);
  return { ...c.estimate, currency, sample: c.sample, text: estimateText(c.estimate, currency, c.sample) };
}

// ---- Reading ----

async function views(ctx: ModuleContext, rows: Row[]): Promise<RequestView[]> {
  if (rows.length === 0) return [];
  const { currency } = await tenantSummary(ctx);
  const names = await accountNames(ctx, [...new Set(rows.map((r) => r.accountId))]);
  return rows.map((r) => {
    const est = fromStoredEstimate(r.estimate);
    const sample = r.connectionMode ? r.connectionMode !== 'live' : est.sample;
    return {
      id: r.id,
      accountId: r.accountId,
      accountName: names.get(r.accountId) ?? null,
      kind: r.kind as EnrichmentKind,
      kindLabel: kindLabel(r.kind as EnrichmentKind),
      providerKey: r.providerKey,
      providerName: providerName(r.providerKey),
      status: r.status as RequestStatus,
      statusText: textOf(r),
      requestedByLabel: r.requestedByLabel ?? '',
      reason: r.reason,
      estimate: { credits: est.credits, costCents: est.costCents, text: estimateText(est, currency, sample) },
      createdAt: r.createdAt,
      decidedByLabel: r.decidedByLabel,
      decidedAt: r.decidedAt,
      declineReason: r.declineReason,
      result: resultView(r.result),
      error: (r.error as RequestView['error']) ?? null,
      waitingReason: r.waitingReason,
      sample,
    };
  });
}

const viewOf = async (ctx: ModuleContext, r: Row) => (await views(ctx, [r]))[0]!;

const isVisible = async (ctx: ModuleContext, r: Row) => (await filterVisibleAccountIds(ctx, [r.accountId])).length > 0;

/** The request, or null when it doesn't exist or its account is outside the principal's data limit. */
export async function getRequest(ctx: ModuleContext, id: string): Promise<RequestView | null> {
  const [r] = await ctx.tx.select().from(request).where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, id)));
  return r && (await isVisible(ctx, r)) ? viewOf(ctx, r) : null;
}

/**
 * Newest first, within the principal's data limits. The cursor is the last request's id; its position is read from
 * its row. Pages are refilled past requests the principal can't see, so a page is short only at the end.
 */
export async function listRequests(
  ctx: ModuleContext,
  f: { status?: RequestStatus; accountId?: string; cursor?: string; limit?: number } = {},
): Promise<{ data: RequestView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 100);
  if (f.cursor) {
    // An unknown id would match nothing and read as the end of the list.
    const [known] = await ctx.tx.select({ id: request.id }).from(request).where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, f.cursor)));
    if (!known) throw invalid('cursor', OLD_CURSOR);
  }
  if (f.accountId && (await filterVisibleAccountIds(ctx, [f.accountId])).length === 0) return { data: [], nextCursor: null };
  const kept: Row[] = [];
  let after = f.cursor ?? null;
  for (;;) {
    const rows = await ctx.tx
      .select()
      .from(request)
      .where(
        and(
          eq(request.tenantId, ctx.tenantId),
          f.status ? eq(request.status, f.status) : undefined,
          f.accountId ? eq(request.accountId, f.accountId) : undefined,
          after
            ? sql`(${request.createdAt}, ${request.id}) < (select r.created_at, r.id from enrichment.request r where r.tenant_id = ${ctx.tenantId} and r.id = ${after})`
            : undefined,
        ),
      )
      .orderBy(desc(request.createdAt), desc(request.id))
      .limit(limit + 1);
    const accountIds = [...new Set(rows.map((r) => r.accountId))];
    const visible = new Set(f.accountId ? accountIds : await filterVisibleAccountIds(ctx, accountIds));
    for (const r of rows) {
      if (!visible.has(r.accountId)) continue;
      kept.push(r);
      if (kept.length > limit) break;
    }
    if (kept.length > limit || rows.length <= limit) break;
    after = rows[rows.length - 1]!.id;
  }
  const page = kept.slice(0, limit);
  return { data: await views(ctx, page), nextCursor: kept.length > limit ? page[page.length - 1]!.id : null };
}

// ---- Changing ----

/** The request locked for this change: 404 when missing or outside the data limit. */
async function lockVisible(ctx: ModuleContext, id: string): Promise<Row> {
  const [r] = await ctx.tx.select().from(request).where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, id))).for('update');
  if (!r || !(await isVisible(ctx, r))) throw notFound();
  return r;
}

function move(r: Row, to: RequestStatus): void {
  if (!canTransition(r.status as RequestStatus, to)) throw already(r);
}

const subject = (id: string) => ({ type: 'enrichment_request', id });

/** Approves a flagged row (or marks a new one): the run is queued in the same transaction (Ruling 8). */
async function approveRow(ctx: ModuleContext, p: Principal, r: Row, extra: Partial<Row> = {}): Promise<Row> {
  const [updated] = await ctx.tx
    .update(request)
    .set({ ...extra, status: 'approved', decidedBy: p.id, decidedByLabel: await requesterLabel(ctx, p), decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(request.tenantId, ctx.tenantId), eq(request.id, r.id)))
    .returning();
  await enqueueJob(ctx, runRequestJob, { requestId: r.id });
  await publish(
    ctx,
    requestApproved,
    { requestId: r.id, accountId: r.accountId, kind: r.kind as EnrichmentKind, providerKey: r.providerKey, decidedBy: p.id, requestedByLabel: r.requestedByLabel ?? '' },
    subject(r.id),
  );
  return updated!;
}

/**
 * Asks for an enrichment (Ruling 1): an approver's request is `approved` and runs; anyone else's, and every key's, is
 * `flagged` and needs a reason. A second request of the same kind for the same account while one is open joins it
 * (Ruling 6): the asker becomes a watcher, and an approver joining a flagged request approves it.
 */
export async function createRequest(
  ctx: ModuleContext,
  principal: Principal,
  accountId: string,
  input: RequestInput,
): Promise<{ request: RequestView; joined: boolean }> {
  requirePermission(principal, 'enrichment:request');
  const c = await check(ctx, accountId, input);
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > MAX_REASON) throw invalid('reason', `Keep the reason to ${MAX_REASON} characters.`);
  const by = principalRef(principal);
  const approver = mayApprove(principal);

  // One open request per (account, kind): two askers at once must not both create one.
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':enr:' || ${c.accountId} || ':' || ${input.kind}))`);
  const [open] = await ctx.tx
    .select()
    .from(request)
    .where(and(eq(request.tenantId, ctx.tenantId), eq(request.accountId, c.accountId), eq(request.kind, input.kind), inArray(request.status, OPEN)))
    .orderBy(request.createdAt, request.id)
    .limit(1)
    .for('update');
  if (open) {
    const watchers = open.requestedBy === by || open.watchers.includes(by) ? open.watchers : [...open.watchers, by];
    let row: Row | undefined = open;
    if (approver && open.status === 'flagged') row = await approveRow(ctx, principal, open, { watchers });
    else if (watchers !== open.watchers) {
      [row] = await ctx.tx.update(request).set({ watchers, updatedAt: new Date() }).where(eq(request.id, open.id)).returning();
    }
    return { request: await viewOf(ctx, row!), joined: true };
  }

  if (!approver && !reason) throw invalid('reason', REASON_NEEDED);
  const label = await requesterLabel(ctx, principal);
  const requestingSourceId = principal.sourceId ?? ctx.access?.sourceId ?? null;
  const [created] = await ctx.tx
    .insert(request)
    .values({
      id: newId('enr'),
      tenantId: ctx.tenantId,
      accountId: c.accountId,
      kind: input.kind,
      params: c.params,
      providerKey: input.providerKey,
      requestedBy: by,
      requestedByLabel: label,
      requestingSourceId,
      reason,
      estimate: toStoredEstimate(c.estimate, c.sample),
      status: 'flagged', // an approver's is approved below, in this transaction: one approval path, no flagged event
    })
    .returning();
  await seedEnrichmentDefaults(ctx);
  if (approver) return { request: await viewOf(ctx, await approveRow(ctx, principal, created!)), joined: false };
  await publish(
    ctx,
    requestFlagged,
    {
      requestId: created!.id,
      accountId: c.accountId,
      kind: input.kind,
      requestedBy: by,
      requestedByLabel: label,
      ...(requestingSourceId ? { requestingSourceId } : {}),
      reason: reason!,
      estimate: c.estimate,
    },
    subject(created!.id),
  );
  return { request: await viewOf(ctx, created!), joined: false };
}

/** A person with `enrichment:approve` approves a flagged request; the run is queued (Rulings 1 and 8). */
export async function approveRequest(ctx: ModuleContext, principal: Principal, id: string): Promise<RequestView> {
  requireApprover(principal);
  const r = await lockVisible(ctx, id);
  move(r, 'approved');
  return viewOf(ctx, await approveRow(ctx, principal, r));
}

/** A person with `enrichment:approve` declines with a reason; the requesting source alone is told (Ruling 10). */
export async function declineRequest(ctx: ModuleContext, principal: Principal, id: string, reason: string): Promise<RequestView> {
  requireApprover(principal);
  const why = reason?.trim();
  if (!why) throw invalid('reason', DECLINE_REASON_NEEDED);
  if (why.length > MAX_REASON) throw invalid('reason', `Keep the reason to ${MAX_REASON} characters.`);
  const r = await lockVisible(ctx, id);
  move(r, 'declined');
  const [updated] = await ctx.tx
    .update(request)
    .set({ status: 'declined', declineReason: why, decidedBy: principal.id, decidedByLabel: await requesterLabel(ctx, principal), decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(request.id, r.id))
    .returning();
  const event = await publish(ctx, requestDeclined, { requestId: r.id, accountId: r.accountId, decidedBy: principal.id, reason: why }, subject(r.id));
  if (r.requestingSourceId) {
    await recordSourceFeedback(ctx, {
      sourceId: r.requestingSourceId,
      accountId: r.accountId,
      kind: 'enrichment_declined',
      note: why,
      byUserId: principal.id,
      causeEventId: event.id,
    });
  }
  return viewOf(ctx, updated!);
}

/** Cancels a flagged or approved request: an approver may, and so may whoever asked (Ruling 7). */
export async function cancelRequest(ctx: ModuleContext, principal: Principal, id: string): Promise<RequestView> {
  const r = await lockVisible(ctx, id);
  if (principalRef(principal) !== r.requestedBy) requirePermission(principal, 'enrichment:approve');
  move(r, 'cancelled');
  const [updated] = await ctx.tx.update(request).set({ status: 'cancelled', waitingReason: null, updatedAt: new Date() }).where(eq(request.id, r.id)).returning();
  await publish(ctx, requestCancelled, { requestId: r.id, accountId: r.accountId, reason: 'cancelled' }, subject(r.id));
  return viewOf(ctx, updated!);
}
