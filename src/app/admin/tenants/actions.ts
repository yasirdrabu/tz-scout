'use server';

import { createTenant } from '@/modules/tenancy';
import { act, str, type ActionResult } from '@/server/action';
import { adminContext } from '@/server/page-context';

export async function createTenantAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const name = str(fd, 'name');
  return act(
    async () => {
      const admin = await adminContext();
      await createTenant(
        { kind: 'user', id: admin.userId },
        {
          slug: str(fd, 'slug'),
          name,
          currency: str(fd, 'currency') || 'USD',
          timezone: str(fd, 'timezone') || 'America/New_York',
          ownerEmail: str(fd, 'ownerEmail'),
        },
      );
    },
    { revalidate: '/admin/tenants', message: `Created ${name}. The owner shows as Invited until they sign in.` },
  );
}
