import '@/entry/compose';
import { handleCrmWebhook, verifyHubSpotV3 } from '@/modules/crm';
import { connectionTenant, webhookSecret } from '@/modules/integrations';
import { config } from '@/platform/config';
import { withTenant } from '@/platform/db/tenant';
import { newId } from '@/platform/ids';
import { logFor } from '@/platform/log';
import { boundedRequest } from '../../../_lib/intake';

const MAX_BYTES = 1024 * 1024;
/** A connection id is logged at most this long, so a crafted path cannot flood the log. */
const LOGGED_ID_LIMIT = 64;

const problem = (status: number, slug: string, title: string) =>
  new Response(JSON.stringify({ type: `about:blank#${slug}`, title, status }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

/**
 * HubSpot signs the URL it called, with these characters decoded first (their v3 rule). `req.url` may carry the
 * internal host behind a proxy, so the origin is the public one from config and only the path and query come from the request.
 */
const DECODED = /%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi;
function signedUrl(req: Request): string {
  const u = new URL(req.url);
  return (new URL(config.publicUrl).origin + u.pathname + u.search).replace(DECODED, (m) => decodeURIComponent(m));
}

/**
 * `POST /api/v1/inbound/hubspot/{connectionId}`. No principal: the connection id finds the tenant, and the v3 signature
 * made with that tenant's client secret is the authentication (Ruling 15). Every refusal is 401 and logged, so an
 * unknown, malformed or disabled connection looks the same as a wrong signature.
 */
export async function POST(req: Request): Promise<Response> {
  const correlationId = newId('cor');
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const rawId = parts[parts.indexOf('hubspot') + 1] ?? '';
  let connectionId = '';
  const refuse = (reason: string, tenantId?: string) => {
    logFor({ correlationId, ...(tenantId ? { tenantId } : {}) }).warn({ connectionId: (connectionId || rawId).slice(0, LOGGED_ID_LIMIT), reason }, 'refused an inbound hubspot webhook');
    return problem(401, 'unauthenticated', 'Not authorized.');
  };
  try {
    connectionId = decodeURIComponent(rawId);
  } catch {
    return refuse('malformed connection id');
  }

  let rawBody: string;
  try {
    rawBody = await (await boundedRequest(req, MAX_BYTES)).text();
  } catch {
    return problem(413, 'payload-too-large', 'This request is over the size limit.');
  }

  const found = connectionId ? await connectionTenant(connectionId) : null;
  if (!found || found.provider !== 'hubspot') return refuse('unknown connection');
  const { tenantId } = found;
  if (found.status === 'disabled') return refuse('connection disabled', tenantId);
  try {
    return await withTenant(tenantId, async (tx) => {
      const ctx = { tenantId, actor: { kind: 'system' as const, id: 'hubspot_webhook' }, correlationId, tx };
      const secret = await webhookSecret(ctx, 'hubspot');
      if (!secret) return refuse('no client secret', tenantId);
      const ok = verifyHubSpotV3(
        secret,
        {
          method: req.method,
          url: signedUrl(req),
          rawBody,
          timestamp: req.headers.get('x-hubspot-request-timestamp') ?? '',
          signature: req.headers.get('x-hubspot-signature-v3') ?? '',
        },
        new Date(),
      );
      if (!ok) return refuse('bad signature or timestamp', tenantId);
      await handleCrmWebhook(ctx, connectionId, rawBody);
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  } catch (e) {
    logFor({ correlationId, tenantId }).error({ err: e }, 'inbound hubspot webhook failed');
    return problem(500, 'internal', 'Something went wrong.');
  }
}
