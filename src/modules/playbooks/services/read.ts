import { and, eq } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { getOffer } from '@/modules/offers';
import { getAccountReview } from '@/modules/routing';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { PAGE_SECTIONS, type BriefMode, type BriefOrigin, type DraftState, type PageSectionKey } from '../contracts/types';
import { briefSection } from '../db/schema';
import { labelFor, writtenBy, type WrittenBy } from '../domain/labels';
import { readBrief } from './brief';

type Piece = { writtenBy: WrittenBy; label: string };

export type SectionView = Piece & {
  key: PageSectionKey;
  title: string;
  body: string | null;
  citations: string[];
  editedByName: string | null;
  editedAt: Date | null;
  /** Set when the section was written for an offer that is not the current lead offer (Ruling 8). */
  writtenForOfferName: string | null;
  version: number | null;
};

export type BriefView = {
  accountId: string;
  offerId: string | null;
  offerName: string | null;
  state: DraftState;
  lastDraftedAt: Date | null;
  recommendation: (Piece & { headline: string; detail: string }) | null;
  whoFirst: (Piece & { personId: string | null; title: string; reason: string }) | null;
  opener: (Piece & { subject: string; body: string }) | null;
  whyNow: (Piece & { body: string; citations: string[] }) | null;
  /** The four page sections in order, also before drafting (`body` null). */
  sections: (SectionView | (Omit<SectionView, 'writtenBy' | 'label'> & { writtenBy: null; label: null }))[];
};

export type SectionRow = typeof briefSection.$inferSelect;

const piece = (origin: string | null, mode: string | null, editedByName?: string | null): Piece => {
  const i = { origin: (origin ?? 'rules') as BriefOrigin, mode: mode as BriefMode | null, editedByName };
  return { writtenBy: writtenBy(i), label: labelFor(i) };
};

/** Offer names by id; an offer that is gone has no name. */
async function offerNames(ctx: ModuleContext, ids: (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids.filter((x): x is string => !!x))) {
    try {
      out.set(id, (await getOffer(ctx, id)).name);
    } catch (e) {
      if (!(e instanceof ScoutError && e.status === 404)) throw e;
    }
  }
  return out;
}

export const sectionTitle = (key: string) => PAGE_SECTIONS.find((s) => s.key === key)?.title ?? key;

export function sectionView(row: SectionRow, leadOfferId: string | null, names: Map<string, string>): SectionView {
  const other = row.offerId && leadOfferId && row.offerId !== leadOfferId ? row.offerId : null;
  return {
    key: row.key as PageSectionKey,
    title: sectionTitle(row.key),
    body: row.body,
    citations: row.citations,
    ...piece(row.origin, row.mode, row.editedByName),
    editedByName: row.origin === 'human' ? row.editedByName : null,
    editedAt: row.origin === 'human' ? row.editedAt : null,
    writtenForOfferName: other ? (names.get(other) ?? null) : null,
    version: row.version,
  };
}

/** The account's lead offer as the review shows it; null when it has no review. */
export async function leadOfferId(ctx: ModuleContext, accountId: string): Promise<string | null | undefined> {
  try {
    return (await getAccountReview(ctx, accountId)).leadOffer?.offerId ?? null;
  } catch (e) {
    if (e instanceof ScoutError && e.status === 404) return undefined;
    throw e;
  }
}

/** The brief as the account page shows it (Task 3). Null for a missing or hidden account. */
export async function getBrief(ctx: ModuleContext, accountId: string): Promise<BriefView | null> {
  const account = await getAccount(ctx, accountId);
  if (!account) return null;
  const id = account.id;
  const row = await readBrief(ctx, id);
  const rows = await ctx.tx.select().from(briefSection).where(and(eq(briefSection.tenantId, ctx.tenantId), eq(briefSection.accountId, id)));
  const lead = (await leadOfferId(ctx, id)) ?? row?.offerId ?? null;
  const names = await offerNames(ctx, [row?.offerId ?? null, ...rows.map((r) => r.offerId)]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const drafted = !!row?.recommendationHeadline;
  const whyNow = byKey.get('why_now');
  return {
    accountId: id,
    offerId: row?.offerId ?? null,
    offerName: row?.offerId ? (names.get(row.offerId) ?? null) : null,
    state: (row?.draftState ?? 'not_drafted') as DraftState,
    lastDraftedAt: row?.draftedAt ?? null,
    recommendation: drafted ? { headline: row!.recommendationHeadline!, detail: row!.recommendationDetail ?? '', ...piece(row!.recommendationOrigin, row!.mode) } : null,
    whoFirst:
      drafted && row!.whoFirstTitle
        ? { personId: row!.whoFirstPersonId, title: row!.whoFirstTitle, reason: row!.whoFirstReason ?? '', ...piece(row!.recommendationOrigin, row!.mode) }
        : null,
    opener: drafted && row!.openerBody ? { subject: row!.openerSubject ?? '', body: row!.openerBody, ...piece(row!.openerOrigin, row!.mode) } : null,
    whyNow: whyNow ? { body: whyNow.body, citations: whyNow.citations, ...piece(whyNow.origin, whyNow.mode, whyNow.editedByName) } : null,
    sections: PAGE_SECTIONS.map((s) => {
      const r = byKey.get(s.key);
      return r
        ? sectionView(r, lead, names)
        : { key: s.key, title: s.title, body: null, citations: [], writtenBy: null, label: null, editedByName: null, editedAt: null, writtenForOfferName: null, version: null };
    }),
  };
}

export { offerNames };
