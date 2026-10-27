import { and, asc, eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { sha256 } from '@/platform/idempotency';
import { newId } from '@/platform/ids';
import { columnMapping } from '../db/schema';
import { detectLayout } from '../import/layouts';
import { isAllowedTarget, type MappingColumn } from '../import/synonyms';
import { suggestMapping } from '../tasks/csv-column-mapping';
import { visibleSourceIds } from './sources';

// SRC-E4: which mapping a file gets, and the mappings a source has saved.

export type MappingOrigin = 'layout' | 'saved' | 'synonyms' | 'ai';
export type ChosenMapping = {
  /** Empty for a built-in layout, which reads the file by itself. */
  mapping: MappingColumn[];
  origin: MappingOrigin;
  /** The key of the built-in layout, when the file has one. */
  layout: string | null;
  needsConfirm: boolean;
};
export type SavedMapping = {
  id: string;
  sourceId: string;
  headerSignature: string;
  mapping: MappingColumn[];
  lastUsedAt: Date | null;
  createdAt: Date;
};

const norm = (h: string) => h.toLowerCase().replace(/\s+/g, ' ').trim();

/** The normalised headers, sorted and hashed, so the same columns in another order match. */
export const headerSignature = (headers: string[]): string => sha256(headers.map(norm).sort().join('\n'));

/** A file can be read when some column names the company: its name, website or domain, or a person's email. */
export const hasRequiredFields = (mapping: MappingColumn[]): boolean =>
  mapping.some((c) => c.target === 'account.name' || c.target === 'account.website' || c.target === 'account.domain' || /^people\[\d+\]\.email$/.test(c.target ?? ''));

/** What a person confirms: targets outside the allowed list are dropped. Their choice needs no confidence floor. */
export function cleanChosen(mapping: MappingColumn[]): MappingColumn[] {
  return mapping.map((c) => ({ ...c, target: c.target && isAllowedTarget(c.target) ? c.target : null }));
}

const view = (r: typeof columnMapping.$inferSelect): SavedMapping => ({
  id: r.id,
  sourceId: r.sourceId,
  headerSignature: r.headerSignature,
  mapping: r.mapping as MappingColumn[],
  lastUsedAt: r.lastUsedAt,
  createdAt: r.createdAt,
});

const forSource = (ctx: ModuleContext, sourceId: string) =>
  and(eq(columnMapping.tenantId, ctx.tenantId), eq(columnMapping.sourceId, sourceId));

/**
 * First match wins: a built-in layout, this source's saved mapping for the same headers, then the
 * suggestion (Claude, else header synonyms). Only a layout or a saved mapping that maps every required
 * field skips the confirm step.
 */
export async function chooseMapping(
  ctx: ModuleContext,
  input: { sourceId: string; headers: string[]; sampleRows: string[][] },
): Promise<ChosenMapping> {
  const layout = detectLayout(input.headers);
  if (layout) return { mapping: [], origin: 'layout', layout: layout.key, needsConfirm: false };

  const [saved] = await ctx.tx
    .select()
    .from(columnMapping)
    .where(and(forSource(ctx, input.sourceId), eq(columnMapping.headerSignature, headerSignature(input.headers))));
  if (saved) {
    await ctx.tx.update(columnMapping).set({ lastUsedAt: new Date() }).where(eq(columnMapping.id, saved.id));
    const mapping = saved.mapping as MappingColumn[];
    return { mapping, origin: 'saved', layout: null, needsConfirm: !hasRequiredFields(mapping) };
  }

  const suggested = await suggestMapping(ctx, input.headers, input.sampleRows);
  return { mapping: suggested.mapping, origin: suggested.origin, layout: null, needsConfirm: true };
}

/** Saves (or replaces) the source's mapping for this set of headers. */
export async function saveMapping(
  ctx: ModuleContext,
  input: { sourceId: string; headers: string[]; mapping: MappingColumn[] },
): Promise<SavedMapping> {
  const signature = headerSignature(input.headers);
  const [row] = await ctx.tx
    .insert(columnMapping)
    .values({
      id: newId('map'),
      tenantId: ctx.tenantId,
      sourceId: input.sourceId,
      headerSignature: signature,
      mapping: cleanChosen(input.mapping),
      createdBy: `${ctx.actor.kind}:${ctx.actor.id}`,
    })
    .onConflictDoUpdate({
      target: [columnMapping.tenantId, columnMapping.sourceId, columnMapping.headerSignature],
      set: { mapping: cleanChosen(input.mapping) },
    })
    .returning();
  return view(row!);
}

const hidden = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That source was not found.' });

/** A source outside the caller's data limit looks like a missing one. */
async function assertSourceVisible(ctx: ModuleContext, sourceId: string): Promise<void> {
  const visible = await visibleSourceIds(ctx);
  if (visible && !visible.includes(sourceId)) throw hidden();
}

export async function listMappings(ctx: ModuleContext, sourceId: string): Promise<SavedMapping[]> {
  await assertSourceVisible(ctx, sourceId);
  const rows = await ctx.tx
    .select()
    .from(columnMapping)
    .where(forSource(ctx, sourceId))
    .orderBy(asc(columnMapping.createdAt), asc(columnMapping.id));
  return rows.map(view);
}

export async function deleteMapping(ctx: ModuleContext, id: string): Promise<void> {
  const [found] = await ctx.tx
    .select({ sourceId: columnMapping.sourceId })
    .from(columnMapping)
    .where(and(eq(columnMapping.tenantId, ctx.tenantId), eq(columnMapping.id, id)));
  if (found) await assertSourceVisible(ctx, found.sourceId);
  const gone = await ctx.tx
    .delete(columnMapping)
    .where(and(eq(columnMapping.tenantId, ctx.tenantId), eq(columnMapping.id, id)))
    .returning({ id: columnMapping.id });
  if (gone.length === 0) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That mapping was not found.' });
}
