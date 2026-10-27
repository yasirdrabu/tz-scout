import { and, eq, gte, lt, or } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import type { ArrivalSignal, SignalKind, SourceChain } from '../contracts/types';
import { signal } from '../db/schema';
import { fineTypeFromTitle, kindFor, signalDedupKeys } from '../domain/signals';

const DAY = 24 * 60 * 60 * 1000;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The source closest to the signal: the agent or vendor that sent it, else the person. */
const closestSource = (c: { personSourceId?: string | null; agentSourceId?: string | null; vendorSourceId?: string | null }) =>
  c.agentSourceId ?? c.vendorSourceId ?? c.personSourceId ?? '';

export type StoredSignal = { signalId: string; existing: boolean; type: string | null; kind: SignalKind; occurredAt: Date };

/**
 * Stores a signal once (ACC-E4 duplicate keys). A fine type sets the kind; otherwise the title may
 * give a fine type of the same kind. An undated research signal takes the arrival date.
 */
export async function storeSignal(
  ctx: ModuleContext,
  accountId: string,
  input: ArrivalSignal,
  chain: SourceChain,
  arrivalId: string,
  receivedAt: Date,
): Promise<StoredSignal> {
  const statedKind = input.type ? kindFor(input.type) : null;
  const kind = statedKind ?? input.kind;
  const type = statedKind ? input.type! : fineTypeFromTitle(kind, input.title);
  const occurredAt = input.occurredAt ?? utcDay(receivedAt);
  const externalId = input.externalId ?? null;
  const url = input.url ?? null;

  const keys = new Set(signalDedupKeys({ source: closestSource(chain), externalId, url, kind, title: input.title, occurredAt }));
  const day = utcDay(occurredAt);
  // Every key but the external id includes the day, so candidates are that day's signals and the external id's.
  const candidates = await ctx.tx
    .select()
    .from(signal)
    .where(
      and(
        eq(signal.tenantId, ctx.tenantId),
        eq(signal.accountId, accountId),
        or(
          and(gte(signal.occurredAt, day), lt(signal.occurredAt, new Date(day.getTime() + DAY))),
          externalId ? eq(signal.externalId, externalId) : undefined,
        ),
      ),
    );
  const same = candidates.find((s) =>
    signalDedupKeys({
      source: closestSource(s),
      externalId: s.externalId,
      url: s.url,
      kind: s.kind as SignalKind,
      title: s.title,
      occurredAt: s.occurredAt ?? s.recordedAt,
    }).some((k) => keys.has(k)),
  );
  if (same) return { signalId: same.id, existing: true, type: same.type, kind: same.kind as SignalKind, occurredAt: same.occurredAt ?? occurredAt };

  const id = newId('sig');
  await ctx.tx.insert(signal).values({
    id,
    tenantId: ctx.tenantId,
    accountId,
    type,
    kind,
    title: input.title,
    detail: input.detail ?? null,
    url,
    value: input.value ?? null,
    confidence: input.confidence ?? null,
    occurredAt,
    personSourceId: chain.personSourceId ?? null,
    agentSourceId: chain.agentSourceId ?? null,
    vendorSourceId: chain.vendorSourceId ?? null,
    arrivalId,
    externalId,
  });
  return { signalId: id, existing: false, type, kind, occurredAt };
}
