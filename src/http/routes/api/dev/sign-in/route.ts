import { handleDevSignIn } from '@/modules/tenancy';
import { config } from '@/platform/config';

// Developer sign-in. 404 unless AUTH_DEV_SIGNIN=true; config refuses that setting in production.
export const POST = (request: Request) => handleDevSignIn(request, { enabled: config.authDevSignin });
