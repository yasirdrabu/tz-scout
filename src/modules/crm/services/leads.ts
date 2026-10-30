import { connectionId as connectionIdOf, gateway } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import type { CrmAdapter, QualifiedLead } from '../contracts/adapter';
import { crmSystem } from './owners';
import { getCrmSettings } from './settings';

/** Most contacts one poll reads (Global Constraints). */
export const LEADS_POLL_LIMIT = 200;

/** The connection must be this tenant's connection for its CRM (Ruling 14). Returns the CRM system. */
async function checkedSystem(ctx: ModuleContext, connectionId: string): Promise<string> {
  const system = await crmSystem(ctx);
  if ((await connectionIdOf(ctx, system)) !== connectionId) {
    throw new ScoutError({ slug: 'not-found', status: 404, title: 'That connection was not found.' });
  }
  return system;
}

/** Contacts that entered the qualified state since `since`, oldest first, at most 200 (CRM-E6-S1). */
export async function listQualifiedLeads(ctx: ModuleContext, connectionId: string, since: Date): Promise<QualifiedLead[]> {
  const system = await checkedSystem(ctx, connectionId);
  const { qualifiedLeadRule: rule } = await getCrmSettings(ctx);
  const changedSince = since.toISOString();
  const leads = await gateway.call(ctx, system, 'listQualifiedLeads', (a) => (a as CrmAdapter).listQualifiedLeads({ changedSince, rule }), {
    module: 'crm',
    requestSummary: { changedSince, rule },
  });
  return [...leads].sort((x, y) => Date.parse(x.qualifiedAt) - Date.parse(y.qualifiedAt)).slice(0, LEADS_POLL_LIMIT);
}

/** One contact with its company and ids, or null when it no longer matches the rule (CRM-E6-S1-AC1). */
export async function fetchQualifiedLead(ctx: ModuleContext, connectionId: string, contactId: string): Promise<QualifiedLead | null> {
  const system = await checkedSystem(ctx, connectionId);
  const { qualifiedLeadRule: rule } = await getCrmSettings(ctx);
  return gateway.call(ctx, system, 'readQualifiedLead', (a) => (a as CrmAdapter).readQualifiedLead({ contactId, rule }), {
    module: 'crm',
    requestSummary: { contactId, rule },
  });
}
