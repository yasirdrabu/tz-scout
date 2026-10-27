import { and, eq, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import type { ArrivalV1 } from '../contracts/arrival';
import { batchCreated } from '../contracts/events';
import { importRunJob } from '../contracts/jobs';
import { batch, batchFile, fileImport } from '../db/schema';
import { LAYOUTS } from '../import/layouts';
import { FileParseError, parseFile, type ParsedFile } from '../import/parse';
import { rowsToArrivals, type SkippedRow } from '../import/rows-to-arrivals';
import type { MappingColumn } from '../import/synonyms';
import { storeFile, readFile } from './files';
import { chooseMapping, cleanChosen, hasRequiredFields, saveMapping, type MappingOrigin } from './mappings';
import { settleBatch } from './resolve';
import { loadSource } from './sources';
import { getBatch, listArrivals } from './status';
import { senderOf, storeItems, vendorChain } from './submit';

// SRC-E4: a file import is a batch with the original file attached. Parse first, store second, submit one arrival per company.

type ImportRow = typeof fileImport.$inferSelect;
type Draft = { body: ArrivalV1; raw: { headers: string[]; rows: string[][] } };

/** What an import stores in `file_import.stats` when it has run (the batch's own counts are read live). */
type RunStats = {
  sheet: string | null;
  /** The next company to send: the chunk cursor. */
  cursor?: number;
  companies?: number;
  /** Rows stored for the batch, rejected ones included. */
  submitted?: number;
  /** Companies this source had already sent (same external ref); they belong to the earlier batch. */
  repeated?: number;
  skipped?: SkippedRow[];
  /** Why the import stopped, when it is `failed`. */
  error?: string;
};

export type ImportCreated =
  | { status: 'needs_sheet'; sheets: string[] }
  | {
      id: string;
      batchId: string;
      status: 'needs_confirm' | 'queued';
      origin: MappingOrigin;
      layout: string | null;
      mapping: MappingColumn[];
      headers: string[];
      rowCount: number;
      sha256: string;
    };

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That import was not found.' });
const invalid = (title: string) => new ScoutError({ slug: 'validation', status: 400, title });

async function parse(file: { fileName: string; contentType?: string; bytes: Uint8Array }, sheet?: string): Promise<ParsedFile> {
  try {
    return await parseFile(file, sheet ? { sheet } : {});
  } catch (e) {
    if (e instanceof FileParseError) throw invalid(e.message);
    throw e;
  }
}

/**
 * Parses first, so a file that can't be read stores nothing. A workbook with several sheets and no `sheet`
 * stores nothing either: the answer lists the sheets and the caller sends the file again with one. Then it
 * creates the batch (the sending source, plus the optional vendor), attaches the file and stores the import.
 * `queued` enqueues the run; `needs_confirm` waits for `confirmImport`.
 */
export async function createImport(
  ctx: ModuleContext,
  input: { fileName: string; contentType: string; bytes: Uint8Array; sheet?: string; vendorSourceId?: string },
): Promise<ImportCreated> {
  const sender = await senderOf(ctx);
  if (input.vendorSourceId) {
    const vendor = await loadSource(ctx, input.vendorSourceId);
    if (!vendor || vendor.kind !== 'vendor' || vendor.status === 'archived') throw invalid('Choose a vendor from the list.');
  }
  const parsed = await parse(input, input.sheet);
  if (parsed.sheets.length > 1 && !input.sheet) return { status: 'needs_sheet', sheets: parsed.sheets };

  const chosen = await chooseMapping(ctx, { sourceId: sender.id, headers: parsed.headers, sampleRows: parsed.rows.slice(0, 5) });
  const status = chosen.needsConfirm ? 'needs_confirm' : 'queued';

  const chain = vendorChain(sender.chain, input.vendorSourceId) ?? sender.chain;
  const batchId = newId('bat');
  const runAt = new Date();
  const name = parsed.sheet && parsed.sheets.length > 1 ? `${input.fileName} (${parsed.sheet})` : input.fileName;
  await ctx.tx.insert(batch).values({
    id: batchId,
    tenantId: ctx.tenantId,
    personSourceId: chain.personSourceId ?? null,
    agentSourceId: chain.agentSourceId ?? null,
    vendorSourceId: chain.vendorSourceId ?? null,
    principal: `${ctx.actor.kind}:${ctx.actor.id}`,
    name,
    runAt,
  });
  const file = await storeFile(ctx, batchId, input);

  const id = newId('imp');
  await ctx.tx.insert(fileImport).values({
    id,
    tenantId: ctx.tenantId,
    batchId,
    sourceId: sender.id,
    fileName: input.fileName,
    storageKey: file.storageKey,
    layout: chosen.layout,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    mapping: chosen.mapping,
    mappingOrigin: chosen.origin,
    status,
    stats: { sheet: parsed.sheet } satisfies RunStats,
  });
  if (status === 'queued') await enqueueJob(ctx, importRunJob, { importId: id });
  return {
    id,
    batchId,
    status,
    origin: chosen.origin,
    layout: chosen.layout,
    mapping: chosen.mapping,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    sha256: file.sha256,
  };
}

/** The import, or null when it is not there or its batch is hidden from the caller. */
async function loadImport(ctx: ModuleContext, id: string, lock = false): Promise<ImportRow | null> {
  const query = ctx.tx.select().from(fileImport).where(and(eq(fileImport.tenantId, ctx.tenantId), eq(fileImport.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row?.batchId || !(await getBatch(ctx, row.batchId))) return null;
  return row;
}

/** The companies a file makes: a built-in layout reads it alone, anything else uses the mapping. */
async function draftsOf(
  ctx: ModuleContext,
  imp: ImportRow,
  mapping: MappingColumn[],
): Promise<{ drafts: Draft[]; skipped: SkippedRow[] }> {
  const file = await readFile(ctx, imp.batchId!, imp.storageKey);
  if (!file) throw notFound();
  const sheet = (imp.stats as RunStats | null)?.sheet ?? undefined;
  const parsed = await parse(file, sheet);
  const layout = imp.layout ? LAYOUTS.find((l) => l.key === imp.layout) : undefined;
  if (layout) return { drafts: layout.toArrivals(parsed, { now: new Date(), fileName: imp.fileName }), skipped: [] };
  const out = rowsToArrivals(parsed, { columns: mapping }, { fileName: imp.fileName });
  return { drafts: out.arrivals, skipped: out.skipped };
}

/** SRC-E4-S3-AC2: the first 5 arrivals the mapping would create (the stored one, unless a mapping is given). */
export async function previewImport(
  ctx: ModuleContext,
  importId: string,
  mapping?: MappingColumn[],
): Promise<{ arrivals: ArrivalV1[]; total: number; skipped: SkippedRow[] }> {
  const imp = await loadImport(ctx, importId);
  if (!imp) throw notFound();
  const { drafts, skipped } = await draftsOf(ctx, imp, mapping ? cleanChosen(mapping) : ((imp.mapping as MappingColumn[] | null) ?? []));
  return { arrivals: drafts.slice(0, 5).map((d) => d.body), total: drafts.length, skipped };
}

/** Saves the confirmed mapping for the source and its headers, then queues the run. */
export async function confirmImport(ctx: ModuleContext, importId: string, mapping: MappingColumn[]): Promise<void> {
  const imp = await loadImport(ctx, importId, true);
  if (!imp) throw notFound();
  if (imp.status !== 'needs_confirm') {
    throw new ScoutError({ slug: 'conflict', status: 409, title: 'This import does not need confirming.' });
  }
  const chosen = cleanChosen(mapping);
  if (!hasRequiredFields(chosen)) throw invalid('Map a column to the company name, website or domain.');
  await saveMapping(ctx, { sourceId: imp.sourceId, headers: imp.headers as string[], mapping: chosen });
  await ctx.tx
    .update(fileImport)
    .set({ mapping: chosen, mappingOrigin: 'person', status: 'queued', updatedAt: new Date() })
    .where(and(eq(fileImport.tenantId, ctx.tenantId), eq(fileImport.id, importId)));
  await enqueueJob(ctx, importRunJob, { importId });
}

/** Companies one `jobs.intake.import.run` message sends. A setter lets tests lower it. */
let chunkSize = 500;
export const setImportChunkSize = (n: number): void => {
  chunkSize = n;
};

/**
 * Runs one chunk of `jobs.intake.import.run`: the companies from `cursor`, up to the chunk size, sent as
 * arrivals from the importing source (channel `file`, `raw` = the header row and the company's rows) through
 * the same path as a batch (`storeItems`), so invalid, repeated-in-file and over-cap companies are stored and
 * rejected. The first chunk publishes `intake.batch.created` with the planned count. The cursor lives in
 * `stats.cursor`; a message whose cursor is not the stored one is a redelivery and does nothing, and the import
 * row lock stops two from running at once. Each chunk is its own transaction, so the source's cap lock is
 * held for a chunk, not the whole file. The last chunk marks the import `imported`; the batch cannot complete before.
 * A source paused or archived since the import was created stops the import as `failed`, with the reason.
 */
export async function runImport(ctx: ModuleContext, importId: string, cursor = 0): Promise<void> {
  const [imp] = await ctx.tx
    .select()
    .from(fileImport)
    .where(and(eq(fileImport.tenantId, ctx.tenantId), eq(fileImport.id, importId)))
    .for('update');
  if (!imp?.batchId || imp.status !== 'queued') return;
  const stats = { ...(imp.stats as RunStats) };
  if ((stats.cursor ?? 0) !== cursor) return;
  const batchId = imp.batchId;
  const [b] = await ctx.tx.select().from(batch).where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)));
  const setImport = (set: Partial<typeof fileImport.$inferInsert>) =>
    ctx.tx
      .update(fileImport)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(fileImport.tenantId, ctx.tenantId), eq(fileImport.id, importId)));

  const sending: ModuleContext = { ...ctx, access: { sourceId: imp.sourceId, dataLimit: { kind: 'own_source' } } };
  let sender;
  try {
    sender = await senderOf(sending);
  } catch (e) {
    if (!(e instanceof ScoutError)) throw e;
    await setImport({ status: 'failed', stats: { ...stats, error: `Import stopped: ${e.message}` } });
    await settleBatch(ctx, batchId);
    return;
  }

  const { drafts, skipped } = await draftsOf(ctx, imp, (imp.mapping as MappingColumn[] | null) ?? []);
  if (cursor === 0) {
    stats.companies = drafts.length;
    stats.skipped = skipped;
    const sourceChain = {
      ...(b!.personSourceId ? { personSourceId: b!.personSourceId } : {}),
      ...(b!.agentSourceId ? { agentSourceId: b!.agentSourceId } : {}),
      ...(b!.vendorSourceId ? { vendorSourceId: b!.vendorSourceId } : {}),
    };
    await publish(
      ctx,
      batchCreated,
      { batchId, sourceChain, name: b!.name, runAt: b!.runAt.toISOString(), itemCount: drafts.length },
      { type: 'batch', id: batchId },
    );
  }

  const end = Math.min(cursor + chunkSize, drafts.length);
  const item = (d: Draft) => ({ raw: d.raw, body: d.body });
  const result = await storeItems(sending, sender, batchId, drafts.slice(cursor, end).map(item), {
    channel: 'file',
    ...(b!.vendorSourceId ? { vendorSourceId: b!.vendorSourceId } : {}),
    before: drafts.slice(0, cursor).map(item),
  });
  stats.cursor = end;
  stats.submitted = (stats.submitted ?? 0) + result.stored;
  stats.repeated = (stats.repeated ?? 0) + result.repeated;
  const last = end >= drafts.length;
  await ctx.tx
    .update(batch)
    .set({ itemCount: sql`${batch.itemCount} + ${result.stored}` })
    .where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)));
  await setImport({ status: last ? 'imported' : 'queued', stats });
  if (!last) await enqueueJob(ctx, importRunJob, { importId, cursor: end });
  // Counts the chunk's rejections; completes the batch when this was the last chunk and nothing is open.
  await settleBatch(ctx, batchId, { rejected: result.rejected });
}

export type ImportView = {
  id: string;
  batchId: string;
  fileName: string;
  status: string;
  layout: string | null;
  mappingOrigin: string | null;
  headers: string[];
  rowCount: number;
  mapping: MappingColumn[];
  file: { storageKey: string; contentType: string; sizeBytes: number; sha256: string };
  stats: {
    /** Companies the file made. */
    companies: number;
    /** Live from the batch. */
    created: number;
    attached: number;
    rejected: number;
    waiting: { count: number; arrivalIds: string[] };
    skipped: SkippedRow[];
    /** Set when the import stopped (`failed`). */
    error: string | null;
  };
};

/** The import with live batch counts: accounts created, attached, rejected and the arrivals waiting for a person. */
export async function getImport(ctx: ModuleContext, id: string): Promise<ImportView | null> {
  const imp = await loadImport(ctx, id);
  if (!imp) return null;
  const batchId = imp.batchId!;
  const detail = (await getBatch(ctx, batchId))!;
  const [file] = await ctx.tx
    .select()
    .from(batchFile)
    .where(and(eq(batchFile.tenantId, ctx.tenantId), eq(batchFile.batchId, batchId), eq(batchFile.storageKey, imp.storageKey)));

  const arrivalIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listArrivals(ctx, { batchId, status: 'resolving', cursor, limit: 200 });
    arrivalIds.push(...page.data.filter((a) => a.waitingOn !== null).map((a) => a.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const run = (imp.stats ?? {}) as RunStats;
  return {
    id: imp.id,
    batchId,
    fileName: imp.fileName,
    status: imp.status,
    layout: imp.layout,
    mappingOrigin: imp.mappingOrigin,
    headers: (imp.headers as string[] | null) ?? [],
    rowCount: imp.rowCount ?? 0,
    mapping: (imp.mapping as MappingColumn[] | null) ?? [],
    file: { storageKey: file!.storageKey, contentType: file!.contentType, sizeBytes: file!.sizeBytes, sha256: file!.sha256 },
    stats: {
      companies: run.companies ?? 0,
      created: detail.counts.newAccounts,
      attached: detail.counts.alreadyKnown,
      rejected: detail.counts.rejected,
      waiting: { count: arrivalIds.length, arrivalIds },
      skipped: run.skipped ?? [],
      error: run.error ?? null,
    },
  };
}
