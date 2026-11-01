import { z } from 'zod';
import { adminTenants, createTenant } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { adminRoute, created } from '../../_lib/v1-route';

const validTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const createBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  // The slug rule itself is createTenant's (400 with the screen copy).
  slug: z.string().trim().min(1).max(40),
  owner_email: z.email(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code.').default('USD'),
  timezone: z.string().trim().refine(validTimezone, 'Use a timezone such as America/New_York.').default('America/New_York'),
});

/** Every tenant, newest first, with member count, owner and the total, active and suspended counts. */
export const GET = adminRoute({}, async (_req, _person, { tx }) => {
  const data = await adminTenants(tx);
  return {
    data,
    summary: {
      total: data.length,
      active: data.filter((t) => t.status === 'active').length,
      suspended: data.filter((t) => t.status === 'suspended').length,
    },
  };
});

/**
 * Creates a tenant with Scout defaults; the owner is invited and gets the Owner role when they sign
 * in. Starting from another tenant's settings is not supported yet.
 */
export const POST = adminRoute({}, async (req, _person, { actor, tx }) => {
  const b = await parseBody<{ name: string; slug: string; ownerEmail: string; currency: string; timezone: string }>(req, createBody);
  const { tenantId } = await createTenant(actor, b, tx);
  const row = (await adminTenants(tx)).find((t) => t.id === tenantId);
  return created(row!);
});
