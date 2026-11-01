import { listOffers, listPractices } from '@/modules/offers';
import { members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';

/** Names behind ids, resolved server side so no screen needs a list most roles can't read. */
export type Names = {
  person: (userId: string | null | undefined) => string | null;
  offer: (offerId: string | null | undefined) => { name: string; practiceId: string } | null;
  practice: (practiceId: string | null | undefined) => string | null;
};

/** Every member (invited, active) and every offer and practice (archived ones too, a row may still name one). */
export async function loadNames(ctx: ModuleContext): Promise<Names> {
  const people = new Map((await members(ctx)).map((m) => [m.userId, m.name]));
  const offers = new Map((await listOffers(ctx)).map((o) => [o.id, { name: o.name, practiceId: o.practiceId }]));
  const practices = new Map((await listPractices(ctx, { includeArchived: true })).map((p) => [p.id, p.name]));
  return {
    person: (id) => (id ? (people.get(id) ?? null) : null),
    offer: (id) => (id ? (offers.get(id) ?? null) : null),
    practice: (id) => (id ? (practices.get(id) ?? null) : null),
  };
}

/** The offer a row shows (Decision 5): the one someone picked, else Scout's best, with its practice. */
export function leadOffer(names: Names, overrideId: string | null, bestOfferId: string | null) {
  const offerId = overrideId ?? bestOfferId;
  const offer = names.offer(offerId);
  if (!offerId) return null;
  return { offerId, name: offer?.name ?? null, practiceId: offer?.practiceId ?? null, practiceName: names.practice(offer?.practiceId), chosen: overrideId !== null };
}
