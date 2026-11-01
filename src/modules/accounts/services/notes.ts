import { and, desc, eq, sql } from 'drizzle-orm';
import { members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { accountNote, accountSummary } from '../db/schema';
import { lockAccount } from './lock';
import { resolveAccountId } from './match';
import { filterVisibleAccountIds } from './visibility';

export const MAX_NOTE = 4000;
const MAX_NOTES_READ = 500;

export type NoteView = { id: string; body: string; byUserId: string; byName: string | null; at: Date };

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
const invalid = (title: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path: 'body', message: title }] });

/** The account the caller may see, following a merge to the survivor; 404 otherwise. */
async function visibleAccount(ctx: ModuleContext, accountId: string): Promise<string> {
  const resolved = await resolveAccountId(ctx, accountId);
  if (!resolved || (await filterVisibleAccountIds(ctx, [resolved.id])).length === 0) throw notFound();
  return resolved.id;
}

async function names(ctx: ModuleContext): Promise<Map<string, string>> {
  return new Map((await members(ctx)).map((m) => [m.userId, m.name]));
}

/** The account's notes, newest first (Decision 3). Everyone who can see the account sees them. */
export async function listNotes(ctx: ModuleContext, accountId: string): Promise<{ data: NoteView[]; total: number }> {
  const id = await visibleAccount(ctx, accountId);
  const rows = await ctx.tx
    .select()
    .from(accountNote)
    .where(and(eq(accountNote.tenantId, ctx.tenantId), eq(accountNote.accountId, id)))
    .orderBy(desc(accountNote.at), desc(accountNote.id))
    .limit(MAX_NOTES_READ);
  const [count] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountNote)
    .where(and(eq(accountNote.tenantId, ctx.tenantId), eq(accountNote.accountId, id)));
  const who = await names(ctx);
  return { data: rows.map((r) => ({ id: r.id, body: r.body, byUserId: r.byUserId, byName: who.get(r.byUserId) ?? null, at: r.at })), total: count?.n ?? 0 };
}

/** Adds a note for the team (up to 4,000 characters) and counts it on the summary. People only. */
export async function addNote(ctx: ModuleContext, accountId: string, text: string): Promise<NoteView> {
  const by = ctx.access?.userId;
  if (!by) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can add a note.' });
  const body = text.trim();
  if (!body) throw invalid('Write the note first, then add it.');
  if (body.length > MAX_NOTE) throw invalid('Keep the note to 4,000 characters.');
  const id = await visibleAccount(ctx, accountId);
  await lockAccount(ctx, id);
  const [row] = await ctx.tx.insert(accountNote).values({ id: newId('nte'), tenantId: ctx.tenantId, accountId: id, body, byUserId: by }).returning();
  await ctx.tx
    .update(accountSummary)
    .set({ noteCount: sql`${accountSummary.noteCount} + 1`, updatedAt: new Date() })
    .where(and(eq(accountSummary.tenantId, ctx.tenantId), eq(accountSummary.accountId, id)));
  return { id: row!.id, body: row!.body, byUserId: by, byName: (await names(ctx)).get(by) ?? null, at: row!.at };
}

/** A merge moves the merged account's notes to the survivor and recounts them. The caller holds both account locks. */
export async function moveNotes(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  await ctx.tx.update(accountNote).set({ accountId: survivorId }).where(and(eq(accountNote.tenantId, ctx.tenantId), eq(accountNote.accountId, mergedId)));
  const [count] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountNote)
    .where(and(eq(accountNote.tenantId, ctx.tenantId), eq(accountNote.accountId, survivorId)));
  await ctx.tx
    .update(accountSummary)
    .set({ noteCount: count?.n ?? 0, updatedAt: new Date() })
    .where(and(eq(accountSummary.tenantId, ctx.tenantId), eq(accountSummary.accountId, survivorId)));
}
