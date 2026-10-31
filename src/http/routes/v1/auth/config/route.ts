import { config } from '@/platform/config';
import { publicRoute } from '../../_lib/v1-route';

/** Public: which sign-in methods the sign-in page offers, and whether developer sign-in is on. */
export const GET = publicRoute(async () => ({
  methods: config.azureAd ? ['microsoft'] : [],
  devSignIn: config.authDevSignin,
}));
