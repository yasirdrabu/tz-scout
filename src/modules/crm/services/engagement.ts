import { and, eq, inArray } from 'drizzle-orm';
import { filterVisibleAccountIds, getCommittee, listPeople } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { activity, link } from '../db/schema';
import { personStates, type PersonEngagement } from '../domain/engagement';
import { latestCompleted } from './follow-through';
import { crmSystem } from './owners';

export type Engagement = { people: PersonEngagement[]; engaged: number; total: number; gapRole: string | null };

/**
 * R2d Rulings 6 and 7: each person on the account's committee, from the activity of the latest completed handoff and
 * the person's CRM contact link. `gapRole` is the label of the first required role nobody covers. Null when the caller can't see the account.
 */
export async function engagement(ctx: ModuleContext, accountId: string, now: Date = new Date()): Promise<Engagement | null> {
  if ((await filterVisibleAccountIds(ctx, [accountId])).length === 0) return null;
  const committee = await getCommittee(ctx, accountId);
  const people = await listPeople(ctx, accountId);
  const h = await latestCompleted(ctx, accountId);
  const system = h?.system ?? (await crmSystem(ctx));
  const links = people.length
    ? await ctx.tx
        .select({ personId: link.scoutId, externalId: link.externalId })
        .from(link)
        .where(and(eq(link.tenantId, ctx.tenantId), eq(link.system, system), eq(link.scoutType, 'person'), inArray(link.scoutId, people.map((p) => p.id))))
    : [];
  const rows = h ? await ctx.tx.select().from(activity).where(and(eq(activity.tenantId, ctx.tenantId), eq(activity.handoffId, h.id))) : [];
  const contacts = new Map(people.map((p) => [p.id, links.filter((l) => l.personId === p.id).map((l) => l.externalId)]));
  const states = personStates(rows, contacts, now);
  return {
    people: states,
    engaged: states.filter((s) => s.state === 'met' || s.state === 'replied').length,
    total: people.length,
    gapRole: committee.roles.find((r) => r.required && r.status === 'gap')?.label ?? null,
  };
}
