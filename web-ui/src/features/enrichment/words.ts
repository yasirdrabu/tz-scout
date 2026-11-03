import type { EnrichmentKind, EnrichmentRequest } from './api';

/** "What to find", in the dialog's order. */
export const KINDS: { key: EnrichmentKind; label: string }[] = [
  { key: 'people_for_roles', label: 'People for buying roles' },
  { key: 'email_reveal', label: 'Reveal emails' },
  { key: 'company_firmographics', label: 'Company facts' },
  { key: 'signals_refresh', label: 'Fresh signals' },
  { key: 'website_read', label: 'Read the website' },
];

const VENDORS = [
  { key: 'apollo', label: 'Apollo' },
  { key: 'vibe', label: 'Vibe Prospecting' },
];

/** The providers a kind can use; the first is the default. */
export const providersFor = (kind: EnrichmentKind) => (kind === 'website_read' ? [{ key: 'website', label: 'Company website' }] : VENDORS);

export const REASON_NEEDED = 'Say why this is worth the spend.';
export const ROLE_NEEDED = 'Pick at least one buying role.';
export const EVERYONE_EMAILED = 'Everyone here already has an email.';

export const startedText = (name: string) => `Enrichment started for ${name}. New signals appear in about 2 minutes.`;
export const FLAGGED_TEXT = 'Sent for approval. A leader will see it in Enrichment requests.';
export const JOINED_TEXT = "Already requested. You'll see the results here too.";

const OPEN = new Set<EnrichmentRequest['status']>(['flagged', 'approved', 'running']);
const RECENT_MS = 7 * 86_400_000;

/** The notice shows open requests and those created or decided in the last 7 days. */
export function shownInNotice(r: EnrichmentRequest, now = Date.now()): boolean {
  if (OPEN.has(r.status)) return true;
  const latest = Math.max(Date.parse(r.created_at), r.decided_at ? Date.parse(r.decided_at) : 0);
  return now - latest <= RECENT_MS;
}

/** Still moving on its own: worth asking again soon. */
export const isRunning = (r: EnrichmentRequest) => r.status === 'approved' || r.status === 'running';
