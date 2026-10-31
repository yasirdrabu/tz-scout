import { devSignInUsers } from '@/modules/tenancy';
import { config } from '@/platform/config';
import { notFound } from '../../_lib/path';
import { publicRoute } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** People the developer sign-in offers. 404 unless AUTH_DEV_SIGNIN=true (never in production). */
export const GET = publicRoute(async () => {
  if (!config.authDevSignin) throw notFound();
  return devSignInUsers();
});
