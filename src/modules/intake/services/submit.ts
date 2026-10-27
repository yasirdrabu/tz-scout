import { and, eq, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { getAccount, type SourceChain } from '@/modules/accounts';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { sha256 } from '@/platform/idempotency';
import { newId } from '@/platform/ids';
import { ArrivalV1Schema, BatchEnvelopeV1Schema, moveItemFields, type ArrivalV1 } from '../contracts/arrival';
import { arrivalReceived, arrivalRejected, batchCreated } from '../contracts/events';
import { resolveJob } from '../contracts/jobs';
import { arrival, batch, source } from '../db/schema';
import { normaliseDomain } from '../domain/normalise';
import { checkArrivalCap, isCapped } from './caps';
import { loadSource } from './sources';

export type Channel = 'api' | 'mcp' | 'file' | 'webhook' | 'form' | 'enrichment' | 'web';

/** API and MCP arrivals are validated strictly; files, webhooks, forms and vendors leniently (SRC-E2). */
export const isStrictChannel = (channel: string): boolean => channel === 'api' || channel === 'mcp';

export const MAX_ARRIVAL_BYTES = 256 * 1024;
export const MAX_BATCH_BYTES = 10 * 1024 * 1024;
const TOO_LARGE = 'An arrival can be up to 256 KB.';

export type SubmitOptions = {
  channel: Channel;
  batchId?: string;
  /** Targeted arrivals only: resolved inside the call (the resolve pipeline adds this), so no resolve job is queued. */
  inline?: boolean;
  /** What was received, when the body was built from it (file rows with their headers). Defaults to the body. */
  raw?: unknown;
};

export type SubmitResult = {
  arrivalId: string;
  status: string;
  duplicateOfRequest: boolean;
  inlineResult?: unknown;
};

export type BatchItemResult = { arrivalId: string; externalRef: string | null; status: string };

type Problem = { path: string; message: string };

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
const invalid = (title: string, errors?: Problem[]) =>
  new ScoutError({ slug: 'validation', status: 400, title, ...(errors ? { errors } : {}) });

function problems(error: z.ZodError): Problem[] {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.code === 'unrecognized_keys' ? `Unknown field: ${i.keys.join(', ')}.` : i.message,
  }));
}

type Sender = { id: string; kind: string; chain: SourceChain };

/**
 * The sending source and its chain, from `ctx.access.sourceId` (the key's source, or a signed-in
 * person's person source) and its parent. Never from the body (SRC-E2-S1-AC5).
 */
async function senderOf(ctx: ModuleContext): Promise<Sender> {
  const id = ctx.access?.sourceId;
  const row = id ? await loadSource(ctx, id) : undefined;
  if (!row) {
    throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Forbidden', detail: 'Only a source can send arrivals.' });
  }
  if (row.status === 'paused') throw new ScoutError({ slug: 'forbidden', status: 403, title: 'This source is paused' });
  if (row.status === 'archived') {
    throw new ScoutError({ slug: 'forbidden', status: 403, title: 'This source is archived. Ask an owner for a new key.' });
  }
  const parent = row.parentId ?? undefined;
  // Partners sit at the person level and CRMs and web forms at the vendor level, so trust keeps three levels.
  const chains: Record<string, SourceChain> = {
    person: { personSourceId: row.id },
    partner: { personSourceId: row.id },
    agent: { agentSourceId: row.id, personSourceId: parent },
    scheduled_pull: { agentSourceId: row.id, vendorSourceId: parent },
    vendor: { vendorSourceId: row.id },
    crm: { vendorSourceId: row.id },
    web_form: { vendorSourceId: row.id },
  };
  const chain = Object.fromEntries(Object.entries(chains[row.kind] ?? {}).filter(([, v]) => v)) as SourceChain;
  return { id: row.id, kind: row.kind, chain };
}

/** Adds the vendor the arrival names in `via_vendor`, matched by the vendor's `settings.key`. Unknown names add nothing. */
async function withVendor(ctx: ModuleContext, chain: SourceChain, viaVendor: string | null | undefined): Promise<SourceChain> {
  const key = viaVendor?.trim().toLowerCase();
  if (!key || chain.vendorSourceId) return chain;
  const [vendor] = await ctx.tx
    .select({ id: source.id })
    .from(source)
    .where(
      and(
        eq(source.tenantId, ctx.tenantId),
        eq(source.kind, 'vendor'),
        ne(source.status, 'archived'),
        sql`lower(${source.settings}->>'key') = ${key}`,
      ),
    )
    .orderBy(source.createdAt)
    .limit(1);
  return vendor ? { ...chain, vendorSourceId: vendor.id } : chain;
}

async function findByRef(ctx: ModuleContext, sourceId: string, externalRef: string) {
  const [row] = await ctx.tx
    .select({ id: arrival.id, status: arrival.status })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.closestSourceId, sourceId), eq(arrival.externalRef, externalRef)));
  return row;
}

function capReached(resetsAt: Date, now = new Date()): ScoutError {
  return new ScoutError({
    slug: 'cap-reached',
    status: 429,
    title: 'This source has sent its daily limit of arrivals.',
    headers: { 'retry-after': String(Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000))) },
    extensions: { resets_at: resetsAt.toISOString() },
  });
}

/** "28 Oct 2026, 00:00 America/New_York". */
function localTime(at: Date, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);
  return `${text} ${timeZone}`;
}

type Row = {
  sender: Sender;
  chain: SourceChain;
  channel: Channel;
  batchId?: string;
  raw: unknown;
  externalRef: string | null;
  targetAccountId?: string | null;
  rejected?: { reason: 'invalid' | 'daily_cap_reached' | 'duplicate_in_batch'; detail: string };
};

/** Inserts one arrival. Null when the source already sent this `external_ref` (a concurrent request won). */
async function store(ctx: ModuleContext, r: Row): Promise<string | null> {
  const id = newId('arr');
  const inserted = await ctx.tx
    .insert(arrival)
    .values({
      id,
      tenantId: ctx.tenantId,
      batchId: r.batchId ?? null,
      personSourceId: r.chain.personSourceId ?? null,
      agentSourceId: r.chain.agentSourceId ?? null,
      vendorSourceId: r.chain.vendorSourceId ?? null,
      closestSourceId: r.sender.id,
      principal: `${ctx.actor.kind}:${ctx.actor.id}`,
      channel: r.channel,
      payload: { raw: r.raw, contractVersion: 1 },
      payloadHash: sha256(JSON.stringify(r.raw ?? null)),
      externalRef: r.rejected ? null : r.externalRef,
      targetAccountId: r.targetAccountId ?? null,
      ...(r.rejected ? { status: 'rejected', rejectReason: r.rejected.reason, rejectDetail: r.rejected.detail } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: arrival.id });
  if (inserted.length === 0) return null;
  const subject = { type: 'arrival', id };
  if (r.rejected) {
    await publish(
      ctx,
      arrivalRejected,
      { arrivalId: id, ...(r.batchId ? { batchId: r.batchId } : {}), reason: r.rejected.reason, detail: r.rejected.detail },
      subject,
    );
  } else {
    await publish(
      ctx,
      arrivalReceived,
      {
        arrivalId: id,
        ...(r.batchId ? { batchId: r.batchId } : {}),
        sourceChain: r.chain,
        ...(r.targetAccountId ? { targetAccountId: r.targetAccountId } : {}),
        ...(r.externalRef ? { externalRef: r.externalRef } : {}),
      },
      subject,
    );
  }
  return id;
}

const refOf = (a: Pick<ArrivalV1, 'account'>): string | null => a.account?.external_ref?.trim() || null;

/** The visible account a targeted arrival names, or a 404. */
async function targetOf(ctx: ModuleContext, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const account = await getAccount(ctx, id);
  if (!account) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  return account.id;
}

/**
 * Stores one arrival exactly as received and queues it for resolving. Order: check the sender
 * (paused or archived is a 403), validate, return an earlier arrival with the same `external_ref`, take the cap lock and check the
 * cap, check the target account, insert. Publishes `intake.arrival.received` in the same
 * transaction and enqueues `jobs.intake.resolve` unless `inline`.
 */
export async function submitArrival(ctx: ModuleContext, body: unknown, opts: SubmitOptions): Promise<SubmitResult> {
  const sender = await senderOf(ctx);
  const raw = opts.raw === undefined ? body : opts.raw;
  if (bytes(raw) > MAX_ARRIVAL_BYTES) throw invalid(TOO_LARGE);
  const parsed = ArrivalV1Schema({ strict: isStrictChannel(opts.channel) }).safeParse(body);
  if (!parsed.success) throw invalid('Check the request.', problems(parsed.error));
  const a = parsed.data;
  if (opts.inline && !a.target_account_id) throw new Error('Only a targeted arrival can be resolved inline');

  const externalRef = refOf(a);
  const duplicate = async (): Promise<SubmitResult | null> => {
    const existing = externalRef ? await findByRef(ctx, sender.id, externalRef) : undefined;
    return existing ? { arrivalId: existing.id, status: existing.status, duplicateOfRequest: true } : null;
  };
  const earlier = await duplicate();
  if (earlier) return earlier;

  if (isCapped(opts.channel, sender.kind)) {
    const cap = await checkArrivalCap(ctx, sender.id);
    if (!cap.allowed) throw capReached(cap.resetsAt);
  }
  const targetAccountId = await targetOf(ctx, a.target_account_id);
  const chain = await withVendor(ctx, sender.chain, a.via_vendor);

  const id = await store(ctx, { sender, chain, channel: opts.channel, batchId: opts.batchId, raw, externalRef, targetAccountId });
  if (!id) return (await duplicate())!;
  if (!opts.inline) await enqueueJob(ctx, resolveJob, { arrivalId: id });
  return { arrivalId: id, status: 'received', duplicateOfRequest: false };
}

/**
 * Stores a batch and every item in the order sent (Ruling 7). Only a bad envelope is a 400 with
 * nothing stored. Items are stored and rejected `invalid` (failing paths in the detail),
 * `duplicate_in_batch` (an earlier item had the same ref or domain) or `daily_cap_reached`.
 * Rejected items keep their ref only in `payload.raw`, so the caller can send them again. An item
 * whose ref this source sent in an earlier request gets that arrival back; it is counted in
 * `counts.repeated`, not in `item_count`. A paused or archived source gets 403 before anything is read.
 */
export async function submitBatch(
  ctx: ModuleContext,
  body: unknown,
  opts: { channel: Channel },
): Promise<{ batchId: string; items: BatchItemResult[] }> {
  const sender = await senderOf(ctx);
  if (bytes(body) > MAX_BATCH_BYTES) throw invalid('A batch can be up to 10 MB.');
  const envelope = BatchEnvelopeV1Schema.safeParse(body);
  if (!envelope.success) throw invalid('Check the request.', problems(envelope.error));
  const b = envelope.data;
  const cap = isCapped(opts.channel, sender.kind) ? await checkArrivalCap(ctx, sender.id) : null;
  let remaining = cap ? cap.remaining : Infinity;
  let capCopy: string | undefined;

  const batchId = newId('bat');
  const runAt = b.run_at ? new Date(b.run_at) : new Date();
  await ctx.tx.insert(batch).values({
    id: batchId,
    tenantId: ctx.tenantId,
    personSourceId: sender.chain.personSourceId ?? null,
    agentSourceId: sender.chain.agentSourceId ?? null,
    vendorSourceId: sender.chain.vendorSourceId ?? null,
    principal: `${ctx.actor.kind}:${ctx.actor.id}`,
    name: b.name,
    runAt,
    notes: b.notes ?? null,
    criteria: b.criteria ?? null,
    metadata: b.metadata ?? null,
  });

  const strict = isStrictChannel(opts.channel);
  const schema = ArrivalV1Schema({ strict });
  const seenRefs = new Set<string>();
  const seenDomains = new Set<string>();
  const items: BatchItemResult[] = [];
  let rejectedCount = 0;
  let stored = 0;
  // Items whose ref this source sent in an earlier request: answered with that arrival, not part of this batch.
  let repeated = 0;

  for (const rawItem of b.items) {
    const item = moveItemFields(rawItem);
    const sentRef = (item as { account?: { external_ref?: unknown } } | null)?.account?.external_ref;
    const shownRef = typeof sentRef === 'string' && sentRef.trim() ? sentRef.trim() : null;
    const base = { sender, chain: sender.chain, channel: opts.channel, batchId, raw: rawItem };
    const reject = async (reason: NonNullable<Row['rejected']>['reason'], detail: string) => {
      const id = (await store(ctx, { ...base, externalRef: null, rejected: { reason, detail } }))!;
      rejectedCount++;
      stored++;
      items.push({ arrivalId: id, externalRef: shownRef, status: 'rejected' });
    };

    if (bytes(rawItem) > MAX_ARRIVAL_BYTES) {
      await reject('invalid', TOO_LARGE);
      continue;
    }
    const parsed = schema.safeParse(item);
    if (!parsed.success) {
      await reject('invalid', problems(parsed.error).map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join(' '));
      continue;
    }
    const a = parsed.data;
    const externalRef = refOf(a);
    const domain = normaliseDomain(a.account?.domain) ?? normaliseDomain(a.account?.website);
    if ((externalRef && seenRefs.has(externalRef)) || (domain && seenDomains.has(domain))) {
      await reject('duplicate_in_batch', 'An earlier item in this batch has the same external_ref or domain.');
      continue;
    }
    if (externalRef) seenRefs.add(externalRef);
    if (domain) seenDomains.add(domain);

    const existing = externalRef ? await findByRef(ctx, sender.id, externalRef) : undefined;
    if (existing) {
      repeated++;
      items.push({ arrivalId: existing.id, externalRef, status: existing.status });
      continue;
    }
    if (remaining <= 0) {
      capCopy ??= `This source reached its daily limit. Send this one again after ${localTime(cap!.resetsAt, await tenantTimezone(ctx))}.`;
      await reject('daily_cap_reached', capCopy);
      continue;
    }
    const target = a.target_account_id ? await getAccount(ctx, a.target_account_id) : null;
    if (a.target_account_id && !target) {
      await reject('invalid', 'target_account_id: That account was not found.');
      continue;
    }
    const chain = await withVendor(ctx, sender.chain, a.via_vendor);
    const id = await store(ctx, { ...base, chain, externalRef, targetAccountId: target?.id ?? null });
    if (!id) {
      repeated++;
      const won = (await findByRef(ctx, sender.id, externalRef!))!;
      items.push({ arrivalId: won.id, externalRef, status: won.status });
      continue;
    }
    await enqueueJob(ctx, resolveJob, { arrivalId: id });
    remaining--;
    stored++;
    items.push({ arrivalId: id, externalRef, status: 'received' });
  }

  // The batch counts only the rows stored with it, so its counts can add up to its items.
  await ctx.tx
    .update(batch)
    .set({ itemCount: stored, counts: { resolved: 0, rejected: rejectedCount, newAccounts: 0, alreadyKnown: 0, repeated } })
    .where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)));
  await publish(
    ctx,
    batchCreated,
    { batchId, sourceChain: sender.chain, name: b.name, runAt: runAt.toISOString(), itemCount: stored },
    { type: 'batch', id: batchId },
  );
  return { batchId, items };
}
