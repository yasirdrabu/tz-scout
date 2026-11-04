import { and, eq } from 'drizzle-orm';
import { listOffers, listPractices } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { upsertSchedule } from '@/platform/scheduler';
import { briefSweepJob } from './contracts/jobs';
import { playbookTemplate } from './db/schema';
import { setOfferPlaybook } from './services/offer-playbooks';
import { createTemplate, type StepInput } from './services/templates';

/** Every 15 minutes, a sweep settles or queues again the drafts stuck in `drafting`. */
export const SWEEP_CRON = '*/15 * * * *';

const RFP_PRACTICE = 'ai-operating-platforms';
const RFP_NAME = 'Public sector RFP';
const STANDARD_NAME = 'Standard outbound';

const RFP_STEPS: StepInput[] = [
  { day: 0, channel: 'task', ownerRole: 'seller', title: 'Register as a county vendor and set alerts', detail: 'Register Taazaa as a vendor with the county and set bid alerts for matching notices.' },
  {
    day: 3,
    channel: 'email',
    ownerRole: 'seller',
    title: 'Send the capability brief to the business owner',
    targetBuyingRoles: ['business_owner'],
    subject: 'How {offer.name} could help {account.name}',
    body: 'Hi {person.first_name},\n\nI work with public sector teams on {offer.name}. {offer.promise}\n\nI have attached a short capability brief. Would a 20 minute call be useful?\n\n{seller.first_name}',
  },
  { day: 14, channel: 'task', ownerRole: 'seller', title: 'Request an industry day through contracts', targetBuyingRoles: ['commercial_buyer'], detail: 'Ask the contracts office for an industry day, so we can meet the team before the RFP.' },
  { day: 21, channel: 'meeting', ownerRole: 'leader', title: 'Conference presence and operator teaming', detail: 'Meet the buyer at a conference, and line up an operator to team with on the bid.' },
];

const STANDARD_STEPS: StepInput[] = [
  {
    day: 0,
    channel: 'email',
    ownerRole: 'seller',
    title: 'Send the intro email',
    subject: 'A quick idea for {account.name}',
    body: 'Hi {person.first_name},\n\nI help teams like {account.name} with {offer.name}. {offer.promise}\n\nWould it be worth a short chat to see if it fits?\n\n{seller.first_name}',
  },
  { day: 3, channel: 'linkedin', ownerRole: 'seller', title: 'Connect on LinkedIn', detail: 'Send a connection request with a short note. Do not pitch.' },
  {
    day: 7,
    channel: 'email',
    ownerRole: 'seller',
    title: 'Send a follow-up email',
    subject: 'Following up on {offer.name}',
    body: 'Hi {person.first_name},\n\nI wanted to follow up on my note about {offer.name}. {offer.promise}\n\nIf now is not the right time, tell me and I will check back later.\n\n{seller.first_name}',
  },
  { day: 14, channel: 'call', ownerRole: 'seller', title: 'Call to book a meeting', detail: 'Call the contact. If no one answers, leave a short voicemail.' },
];

/**
 * One active template per seeded practice (Ruling 17): "Public sector RFP" for AI Operating Platforms and
 * "Standard outbound" for the rest, then each offer's act_now and good_fit mapped to its practice's template.
 * Matches templates by name; offers are mapped only when their template was made in this run, so a rerun leaves
 * edits and cleared mappings alone. A workspace with no practices (a new one, before its offers are seeded) gets nothing.
 */
async function seedTemplates(ctx: ModuleContext): Promise<void> {
  const practices = await listPractices(ctx);
  if (practices.length === 0) return;
  const idOf = async (name: string, steps: StepInput[], description: string, whenToUse: string): Promise<{ id: string; fresh: boolean }> => {
    const [have] = await ctx.tx
      .select({ id: playbookTemplate.id })
      .from(playbookTemplate)
      .where(and(eq(playbookTemplate.tenantId, ctx.tenantId), eq(playbookTemplate.name, name)));
    if (have) return { id: have.id, fresh: false };
    return { id: (await createTemplate(ctx, { name, description, whenToUse, status: 'active', steps })).id, fresh: true };
  };
  const rfp = practices.some((p) => p.slug === RFP_PRACTICE)
    ? await idOf(RFP_NAME, RFP_STEPS, 'Get found by a public sector buyer before the RFP is out.', 'Offers sold to counties and other public sector buyers.')
    : null;
  const standard = practices.some((p) => p.slug !== RFP_PRACTICE)
    ? await idOf(STANDARD_NAME, STANDARD_STEPS, 'Four touches over two weeks: email, LinkedIn, a follow-up and a call.', 'The default for a new account when nothing more specific fits.')
    : null;
  const slugOf = new Map(practices.map((p) => [p.id, p.slug]));
  // Only a template made in this run is mapped, so a rerun never brings back a mapping someone cleared.
  for (const o of await listOffers(ctx, { status: ['draft', 'approved'] })) {
    const template = slugOf.get(o.practiceId) === RFP_PRACTICE ? rfp : standard;
    if (!template?.fresh) continue;
    for (const tier of ['act_now', 'good_fit']) await setOfferPlaybook(ctx, o.id, tier, template.id);
  }
}

/** A tenant's playbooks defaults: the sweep schedule and the seed playbooks. Safe to run again. */
export async function seedPlaybooksDefaults(ctx: ModuleContext): Promise<void> {
  await upsertSchedule({ actor: ctx.actor, correlationId: ctx.correlationId, tx: ctx.tx }, { tenantId: ctx.tenantId, jobName: briefSweepJob.name, cron: SWEEP_CRON, timezone: 'UTC', payload: {} });
  await seedTemplates(ctx);
}
