import { and, eq, inArray } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { upsertSchedule } from '@/platform/scheduler';
import { relationshipDefault, source } from './db/schema';
import { waitingExpireJob } from './contracts/jobs';

/** Vendor-level sources every tenant starts with (SRC-E1-S1-AC4). `settings.key` is what `via_vendor` matches. */
export const DEFAULT_VENDOR_SOURCES = [
  { key: 'apollo', name: 'Apollo', kind: 'vendor', initialReviewStatusKey: 'unvetted' },
  { key: 'vibe', name: 'Vibe Prospecting', kind: 'vendor', initialReviewStatusKey: 'unvetted' },
  { key: 'hubspot_qualified', name: 'HubSpot marketing qualified', kind: 'crm', initialReviewStatusKey: 'needs_review' },
] as const;

/** Warm-intro relationship keys with their labels and default points (SRC-E5). */
export const RELATIONSHIP_DEFAULTS = [
  { relationshipKey: 'customer_referral', label: 'Referred by a current customer', points: 15 },
  { relationshipKey: 'partner_referral', label: 'Referred by a partner', points: 10 },
  { relationshipKey: 'board_or_investor', label: 'Board member or investor intro', points: 12 },
  { relationshipKey: 'employee_network', label: 'Someone on our team knows them', points: 8 },
  { relationshipKey: 'event_meeting', label: 'Met in person at an event', points: 5 },
  { relationshipKey: 'other', label: 'Other', points: 3 },
];

/** Adds what is missing and leaves what a person has changed alone, so it is safe to run again. */
export async function seedIntakeDefaults(ctx: ModuleContext): Promise<void> {
  const tenantId = ctx.tenantId;
  const existing = await ctx.tx
    .select({ settings: source.settings })
    .from(source)
    .where(and(eq(source.tenantId, tenantId), inArray(source.kind, ['vendor', 'crm'])));
  const have = new Set(existing.map((s) => (s.settings as { key?: string }).key));
  const missing = DEFAULT_VENDOR_SOURCES.filter((v) => !have.has(v.key));
  if (missing.length > 0) {
    await ctx.tx.insert(source).values(
      missing.map((v) => ({
        id: newId('src'),
        tenantId,
        kind: v.kind,
        name: v.name,
        initialReviewStatusKey: v.initialReviewStatusKey,
        settings: { key: v.key },
      })),
    );
  }
  await ctx.tx
    .insert(relationshipDefault)
    .values(RELATIONSHIP_DEFAULTS.map((d) => ({ tenantId, ...d })))
    .onConflictDoNothing();
  // Ruling 8: rejects arrivals that waited 30 days, daily at 04:00 UTC.
  await upsertSchedule(
    { actor: ctx.actor, correlationId: ctx.correlationId },
    { tenantId, jobName: waitingExpireJob.name, cron: '0 4 * * *', timezone: 'UTC', payload: {} },
  );
}
