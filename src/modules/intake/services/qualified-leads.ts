import { and, asc, eq, sql } from 'drizzle-orm';
import { fetchQualifiedLead, listQualifiedLeads, seedMockCrm, type QualifiedLead } from '@/modules/crm';
import { SAMPLE_ONLY, connectionId, connectionStatus } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { crmLeadPoll, source } from '../db/schema';
import { isFreeEmailDomain } from '../domain/free-email';
import { domainFromEmail } from '../domain/normalise';
import { submitArrival, type SubmitResult } from './submit';

const SYSTEM = 'hubspot';
const SOURCE_KEY = 'hubspot_qualified';

/** The sample contact `seedMockCrm` qualifies, which "Simulate a qualified lead" sends. */
export const SAMPLE_LEAD_EMAIL = 'pat.lee@qualified.example';

/** How far back the first poll of a connection reads. */
export const FIRST_POLL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** The tenant's `hubspot_qualified` source (from intake defaults). */
async function leadSource(ctx: ModuleContext) {
  const [row] = await ctx.tx
    .select({ id: source.id, status: source.status })
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), eq(source.kind, 'crm'), sql`${source.settings}->>'key' = ${SOURCE_KEY}`))
    .orderBy(asc(source.createdAt))
    .limit(1);
  return row;
}

/** `hubspot:<contactId>:<qualified date YYYY-MM-DD>`: one arrival per contact per qualified date. */
export const leadRef = (lead: QualifiedLead): string =>
  `${SYSTEM}:${lead.contact.externalId}:${new Date(lead.qualifiedAt).toISOString().slice(0, 10)}`;

/**
 * The arrival for a lead. A contact with no company sends its email domain as the website and intake's normal rules
 * decide; a free-mail address makes the contact a sole proprietor, so it becomes a shell account.
 */
function arrivalOf(lead: QualifiedLead) {
  const c = lead.company;
  const emailDomain = domainFromEmail(lead.contact.email);
  const freeMail = !c && !!emailDomain && isFreeEmailDomain(emailDomain);
  const external_ref = leadRef(lead);
  return {
    account: c
      ? { name: c.name, domain: c.domain, website: c.website, employees: c.employees, description: c.description, external_ref }
      : { website: freeMail ? null : emailDomain, external_ref },
    people: [
      { name: lead.contact.name, email: lead.contact.email, title: lead.contact.title, phone: lead.contact.phone, linkedin_url: lead.contact.linkedin },
    ],
    sole_proprietor: freeMail,
  };
}

/** Submits a lead as the `hubspot_qualified` source on channel `webhook`, with its CRM ids beside the body (Ruling 14). */
export async function submitQualifiedLead(ctx: ModuleContext, lead: QualifiedLead): Promise<SubmitResult> {
  const sender = await leadSource(ctx);
  if (!sender) throw new Error('The hubspot_qualified source is missing');
  const sending: ModuleContext = {
    ...ctx,
    actor: { kind: 'system', id: SOURCE_KEY },
    access: { sourceId: sender.id, dataLimit: { kind: 'own_source' } },
  };
  return submitArrival(sending, arrivalOf(lead), {
    channel: 'webhook',
    raw: lead,
    externalIds: {
      account: lead.company ? [{ system: SYSTEM, id: lead.company.externalId }] : [],
      people: [{ index: 0, system: SYSTEM, id: lead.contact.externalId }],
    },
  });
}

/** For `crm.lead.qualified`: reads the contact and submits it. A connection that isn't the tenant's or a paused source drops it. */
export async function takeQualifiedLead(ctx: ModuleContext, connection: string, contactId: string): Promise<void> {
  try {
    const lead = await fetchQualifiedLead(ctx, connection, contactId);
    if (lead) await submitQualifiedLead(ctx, lead);
  } catch (err) {
    if (err instanceof ScoutError && (err.status === 403 || err.status === 404)) return;
    throw err;
  }
}

/**
 * The 15-minute poll (Ruling 14): reads contacts qualified since `polled_until` (at most 200, oldest first), submits
 * each and moves `polled_until` to the latest qualified time submitted. Stops early when the source's daily cap is
 * reached, so the rest are read next time. Skips a paused source and a connection that is off or not set up.
 */
export async function pollQualifiedLeads(ctx: ModuleContext): Promise<{ submitted: number }> {
  const sender = await leadSource(ctx);
  if (sender?.status !== 'active') return { submitted: 0 };
  const status = await connectionStatus(ctx, SYSTEM);
  if (status.status === 'disabled' || (status.mode === 'live' && status.status === 'not_set_up')) return { submitted: 0 };
  const conn = await connectionId(ctx, SYSTEM);

  const [row] = await ctx.tx
    .select({ polledUntil: crmLeadPoll.polledUntil })
    .from(crmLeadPoll)
    .where(and(eq(crmLeadPoll.tenantId, ctx.tenantId), eq(crmLeadPoll.connectionId, conn)));
  const since = row?.polledUntil ?? new Date(Date.now() - FIRST_POLL_LOOKBACK_MS);
  let until = since;
  let submitted = 0;
  for (const lead of await listQualifiedLeads(ctx, conn, since)) {
    try {
      if (!(await submitQualifiedLead(ctx, lead)).duplicateOfRequest) submitted++;
    } catch (err) {
      if (err instanceof ScoutError && err.slug === 'cap-reached') break;
      throw err;
    }
    const at = new Date(lead.qualifiedAt);
    if (at > until) until = at;
  }
  await ctx.tx
    .insert(crmLeadPoll)
    .values({ tenantId: ctx.tenantId, connectionId: conn, polledUntil: until })
    .onConflictDoUpdate({ target: [crmLeadPoll.tenantId, crmLeadPoll.connectionId], set: { polledUntil: until } });
  return { submitted };
}

/** "Simulate a qualified lead" (SRC-E6-S1-AC4): the sample contact through the same path. Mock only; else 409. */
export async function simulateQualifiedLead(ctx: ModuleContext): Promise<SubmitResult> {
  if ((await connectionStatus(ctx, SYSTEM)).mode !== 'mock') {
    throw new ScoutError({ slug: 'sample-data-only', status: 409, title: SAMPLE_ONLY });
  }
  await seedMockCrm(ctx);
  const conn = await connectionId(ctx, SYSTEM);
  const sample = (await listQualifiedLeads(ctx, conn, new Date(0))).find((l) => l.contact.email?.toLowerCase() === SAMPLE_LEAD_EMAIL);
  const lead = sample && (await fetchQualifiedLead(ctx, conn, sample.contact.externalId));
  if (!lead) throw new ScoutError({ slug: 'not-found', status: 404, title: 'The sample qualified contact was not found.' });
  return submitQualifiedLead(ctx, lead);
}
