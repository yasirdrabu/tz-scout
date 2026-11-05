import { and, eq } from 'drizzle-orm';
import { getAccount, getSignals } from '@/modules/accounts';
import { getCrmSettings, type HandoffPackage, type HandoffPackageProvider } from '@/modules/crm';
import { sourceNames } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import { BRIEF_KEYS, type BriefMode, type BriefOrigin } from '../contracts/types';
import { briefSection } from '../db/schema';
import { labelFor } from '../domain/labels';
import { buildPackage, rulesPackageBrief, type PackageBrief, type PackageSignal } from '../domain/package';
import { rulesBrief } from '../domain/rules-brief';
import { readBrief } from './brief';
import { bestOfferNames } from './best-offer';
import { buildBriefInput, closestSource } from './inputs';
import { planTasks } from './plans';

const EMPTY: HandoffPackage = { sections: [], properties: {}, firstTouch: null, followUps: [], planSteps: [] };

const label = (origin: string | null, mode: string | null, editedByName?: string | null) =>
  labelFor({ origin: (origin ?? 'rules') as BriefOrigin, mode: mode as BriefMode | null, editedByName });

const personName = (p: { firstName: string | null; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(' ');

/**
 * The package for the CRM push (Ruling 9): the stored brief, score, offer, case studies, signals and other
 * matches. It reads only: no Claude call and no write, so CRM can call it in every push and batch refresh.
 * With no stored brief it assembles the rules brief in memory. Null only when the account is missing; an
 * account with no score gets an empty package, so the CRM writes its own note sections and tasks.
 */
export async function handoffPackage(ctx: ModuleContext, accountId: string): Promise<HandoffPackage | null> {
  const account = await getAccount(ctx, accountId);
  if (!account) return null;
  const built = await buildBriefInput(ctx, account.id);
  if (!built) return EMPTY;
  const { input, explanation } = built;

  const rules = rulesPackageBrief(rulesBrief(input, new Date()));
  const row = await readBrief(ctx, account.id);
  const rows = await ctx.tx.select().from(briefSection).where(and(eq(briefSection.tenantId, ctx.tenantId), eq(briefSection.accountId, account.id)));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const brief: PackageBrief = {
    recommendation: row?.recommendationHeadline
      ? { headline: row.recommendationHeadline, detail: row.recommendationDetail ?? '', label: label(row.recommendationOrigin, row.mode) }
      : rules.recommendation,
    whoFirst: row?.recommendationHeadline && row.whoFirstTitle
      ? { personId: row.whoFirstPersonId, title: row.whoFirstTitle, reason: row.whoFirstReason ?? '', label: label(row.recommendationOrigin, row.mode) }
      : rules.whoFirst,
    opener: row?.recommendationHeadline && row.openerBody
      ? { subject: row.openerSubject ?? '', body: row.openerBody, label: label(row.openerOrigin, row.mode) }
      : rules.opener,
    sections: Object.fromEntries(
      BRIEF_KEYS.map((k) => {
        const r = byKey.get(k);
        return [k, r ? { text: r.body, label: label(r.origin, r.mode, r.editedByName) } : rules.sections[k]];
      }),
    ) as PackageBrief['sections'],
    rulesOpener: rules.rulesOpener,
  };

  // Every signal, with its link and the rule that scored it.
  const ruleText = new Map<string, string>();
  for (const l of explanation.lines) if (l.group === 'intent') for (const id of l.signalIds ?? []) if (!ruleText.has(id)) ruleText.set(id, l.text ?? l.label);
  const all = await getSignals(ctx, account.id);
  const names = await sourceNames(ctx, [...new Set(all.map((s) => closestSource(s.sourceChain)).filter((x): x is string => !!x))]);
  const signals: PackageSignal[] = all
    .map((s) => ({
      id: s.id,
      type: s.type,
      kind: s.kind,
      title: s.title,
      occurredAt: s.occurredAt?.toISOString() ?? null,
      sourceName: names.get(closestSource(s.sourceChain) ?? '') ?? null,
      url: s.url,
      ruleText: ruleText.get(s.id) ?? null,
    }))
    .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? '') || a.id.localeCompare(b.id));

  const matches = [...explanation.otherOffers].sort((a, b) => b.total - a.total).map((o) => ({ name: o.name, total: o.total }));
  const named = account.people.filter((p) => personName(p));
  const person = named.find((p) => p.id === brief.whoFirst.personId) ?? named.find((p) => p.isPrimary) ?? null;
  return buildPackage({
    brief,
    input,
    signals,
    matches,
    followUpDays: (await getCrmSettings(ctx)).followUpDays,
    buyer: person ? { name: personName(person), title: person.title, email: person.email } : null,
  });
}

/** CRM's `HandoffPackageProvider` (PLB-E3-S4-AC1), registered in src/entry/compose.ts; `planTasks` feeds the plan task sync (R2c-3b). */
export const playbooksHandoffPackage: HandoffPackageProvider = { package: (ctx, accountId) => handoffPackage(ctx, accountId), bestOfferNames, planTasks };
