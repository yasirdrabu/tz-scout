import { createHmac, timingSafeEqual } from 'node:crypto';

/** HubSpot refuses a request signed more than this long ago. */
export const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export type SignedRequest = { method: string; url: string; rawBody: string; timestamp: string; signature: string };

/**
 * HubSpot's v3 signature: base64(HMAC-SHA256(client secret, method + url + body + timestamp)), with the timestamp in
 * milliseconds. A timestamp older than 5 minutes, or one that is not a number, is refused.
 */
export function verifyHubSpotV3(secret: string, req: SignedRequest, now: Date): boolean {
  const sent = Number(req.timestamp);
  if (!req.timestamp.trim() || !Number.isFinite(sent) || Math.abs(now.getTime() - sent) > SIGNATURE_MAX_AGE_MS) return false;
  const expected = createHmac('sha256', secret).update(`${req.method}${req.url}${req.rawBody}${req.timestamp}`).digest();
  const given = Buffer.from(req.signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type WebhookEvent = {
  kind: 'deal' | 'activity' | 'lifecycle';
  objectId: string;
  /** The HubSpot company id, when the event carries one. */
  companyId?: string;
  /** Set on lifecycle events: the contact. */
  contactId?: string;
  propertyName?: string;
  propertyValue?: string;
};

const KINDS: [prefix: string, kind: WebhookEvent['kind']][] = [
  ['deal.', 'deal'],
  ['engagement.', 'activity'],
  ['contact.propertyChange', 'lifecycle'],
];

const text = (v: unknown): string | undefined => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);

/** Reads HubSpot's list of subscription events. Subscriptions Scout does not use, and a body that isn't a list, give nothing. */
export function parseHubSpotWebhook(rawBody: string): WebhookEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: WebhookEvent[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const type = text(e.subscriptionType);
    const objectId = text(e.objectId);
    const kind = type ? KINDS.find(([p]) => type.startsWith(p))?.[1] : undefined;
    if (!kind || !objectId) continue;
    const companyId = text(e.companyId);
    out.push(
      kind === 'lifecycle'
        ? { kind, objectId, contactId: objectId, propertyName: text(e.propertyName), propertyValue: text(e.propertyValue) }
        : { kind, objectId, ...(companyId ? { companyId } : {}) },
    );
  }
  return out;
}
