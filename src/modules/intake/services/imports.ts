import { and, eq } from 'drizzle-orm';
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
import { senderOf, submitArrival } from './submit';

// SRC-E4: a file import is a batch with the original file attached. Parse first, store second, submit one arrival per company.

type ImportRow = typeof fileImport.$inferSelect;
type Draft = { body: ArrivalV1; raw: { headers: string[]; rows: string[][] } };

/** What an import stores in `file_import.stats` when it has run (the batch's own counts are read live). */
type RunStats = {
  sheet: string | null;
  companies?: number;
  submitted?: number;
  /** Companies this source had already sent (same external ref); they belong to the earlier batch. */
  repeated?: number;
  skipped?: SkippedRow[];
  /** Companies that could not be stored, with why (over the daily cap, or not valid). */
  notSent?: { name: string; reason: string }[];
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

  const chain = { ...sender.chain, ...(input.vendorSourceId ? { vendorSourceId: input.vendorSourceId } : {}) };
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
  await publish(ctx, batchCreated, { batchId, sourceChain: chain, name, runAt: runAt.toISOString(), itemCount: 0 }, { type: 'batch', id: batchId });
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

/**
 * Runs `jobs.intake.import.run`. It sends each company as an arrival from the importing source (channel `file`,
 * `raw` = the header row and the company's rows) and sets the batch's item count. Safe to deliver twice: it
 * runs only while the import is `queued`, holding the import's row lock, and the whole run is one transaction,
 * so a second delivery finds `imported` and does nothing, and a failed one leaves nothing half sent.
 * A company the source can't send (over its daily cap, or not valid) is listed in `stats.notSent`.
 */
export async function runImport(ctx: ModuleContext, importId: string): Promise<void> {
  const [imp] = await ctx.tx
    .select()
    .from(fileImport)
    .where(and(eq(fileImport.tenantId, ctx.tenantId), eq(fileImport.id, importId)))
    .for('update');
  if (!imp?.batchId || imp.status !== 'queued') return;
  const batchId = imp.batchId;
  const [b] = await ctx.tx.select({ vendorSourceId: batch.vendorSourceId }).from(batch).where(eq(batch.id, batchId));
  const { drafts, skipped } = await draftsOf(ctx, imp, (imp.mapping as MappingColumn[] | null) ?? []);

  const sending: ModuleContext = { ...ctx, access: { sourceId: imp.sourceId, dataLimit: { kind: 'own_source' } } };
  const stats: RunStats = { ...(imp.stats as RunStats), companies: drafts.length, skipped, notSent: [] };
  let stored = 0;
  let repeated = 0;
  const nameOf = (d: Draft) => d.body.account?.name ?? d.body.account?.domain ?? d.body.account?.website ?? 'Unnamed company';
  for (const [i, d] of drafts.entries()) {
    try {
      const r = await submitArrival(sending, d.body, {
        channel: 'file',
        batchId,
        raw: d.raw,
        ...(b?.vendorSourceId ? { vendorSourceId: b.vendorSourceId } : {}),
      });
      if (r.duplicateOfRequest) repeated++;
      else stored++;
    } catch (e) {
      if (!(e instanceof ScoutError)) throw e;
      if (e.slug === 'cap-reached') {
        // Over the cap: the rest would be refused too.
        for (const rest of drafts.slice(i)) stats.notSent!.push({ name: nameOf(rest), reason: e.message });
        break;
      }
      stats.notSent!.push({ name: nameOf(d), reason: e.detail ?? e.message });
    }
  }
  stats.submitted = stored;
  stats.repeated = repeated;
  await ctx.tx.update(batch).set({ itemCount: stored }).where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)));
  await ctx.tx
    .update(fileImport)
    .set({ status: 'imported', stats, updatedAt: new Date() })
    .where(and(eq(fileImport.tenantId, ctx.tenantId), eq(fileImport.id, importId)));
  // Nothing sent (or every item already finished): the batch completes now.
  await settleBatch(ctx, batchId);
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
    notSent: { name: string; reason: string }[];
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
      notSent: run.notSent ?? [],
    },
  };
}
