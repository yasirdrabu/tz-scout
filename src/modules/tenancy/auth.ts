import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { config, type Config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { newId, type IdPrefix } from '@/platform/ids';
import { account, session, user, verification } from './db/schema';
import { log } from '@/platform/log';
import {
  NOT_SET_UP,
  checkSignIn,
  completeSignIn,
  entraIdentityFits,
  pinEntraIdentity,
  signInEmailFor,
  tenantOfIdToken,
  type EntraPolicy,
} from './services/sign-in';

/** Most a session lives, from sign-in. */
export const SESSION_MAX_SECONDS = 7 * 24 * 3600;
/** How often a session's last activity (`updated_at`) is written. */
export const SESSION_UPDATE_AGE_SECONDS = 3600;

const ID_PREFIX: Record<string, IdPrefix> = { user: 'usr', session: 'ses', account: 'oac', verification: 'vrf' };

/** Paths better-auth serves over HTTP. Everything else (passwords, account management) is off. */
export const AUTH_PATHS = ['/sign-in/social', '/callback/:id', '/sign-out', '/get-session'] as const;

/** better-auth's other HTTP endpoints (1.7), listed so `disabledPaths` turns them off. */
const DISABLED_PATHS = [
  '/account-info',
  '/change-email',
  '/change-password',
  '/delete-user',
  '/delete-user/callback',
  '/error',
  '/get-access-token',
  '/link-social',
  '/list-accounts',
  '/list-sessions',
  '/ok',
  '/refresh-token',
  '/request-password-reset',
  '/reset-password',
  '/revoke-other-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/send-verification-email',
  '/sign-in/email',
  '/sign-up/email',
  '/unlink-account',
  '/update-session',
  '/update-user',
  '/verify-email',
  '/verify-password',
];

/** Shown when sign-in passed the gate but could not be recorded. */
export const SIGN_IN_FAILED = 'We could not finish signing you in. Try again in a minute.';

const refuse = (message: string) =>
  new APIError('FORBIDDEN', { code: message === NOT_SET_UP ? 'not_set_up' : 'account_turned_off', message });

/**
 * Developer sign-in: creates a session for an existing user through better-auth (so the sign-in gate
 * still runs) and sets the session cookie. Server only: never on the HTTP router; the
 * `/api/dev/sign-in` route calls it when `AUTH_DEV_SIGNIN=true`.
 */
const devSignInPlugin = {
  id: 'scout-dev-sign-in',
  endpoints: {
    devSignIn: createAuthEndpoint.serverOnly(
      { method: 'POST', body: z.object({ userId: z.string().min(1) }) },
      async (ctx) => {
        const found = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        if (!found) throw new APIError('NOT_FOUND', { code: 'user_not_found', message: 'That user was not found.' });
        const created = await ctx.context.internalAdapter.createSession(found.id);
        await setSessionCookie(ctx, { session: created, user: found });
        return ctx.json({ userId: found.id });
      },
    ),
  },
} satisfies BetterAuthPlugin;

/** Builds a better-auth instance. `overrides` is for tests (a fake Microsoft app); the app uses `auth`. */
export function createAuth(overrides: { azureAd?: Config['azureAd'] } = {}) {
  const azure = 'azureAd' in overrides ? overrides.azureAd : config.azureAd;
  const policy: EntraPolicy = { homeTenantId: azure?.tenantId ?? '', allowedTenantIds: azure?.allowedTenantIds ?? [] };
  return betterAuth({
    appName: 'Scout',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    disabledPaths: DISABLED_PATHS,
    database: drizzleAdapter(adminDb, {
      provider: 'pg',
      schema: { user, session, account, verification },
      transaction: true,
    }),
    emailAndPassword: { enabled: false },
    socialProviders: azure
      ? {
          microsoft: {
            clientId: azure.clientId,
            clientSecret: azure.clientSecret,
            tenantId: azure.tenantId,
            disableDefaultScope: true,
            scope: ['openid', 'profile', 'email', 'User.Read'],
            disableProfilePhoto: true,
            // Match on our user's email: pinned Entra identity first, then email or UPN from a trusted tenant.
            mapProfileToUser: async (profile) => {
              const email = await signInEmailFor(profile as Record<string, unknown>, policy);
              return email ? { email } : {};
            },
          },
        }
      : {},
    account: {
      encryptOAuthTokens: true,
      // Scout membership decides access. A member's Microsoft account links to their user on first
      // sign-in; our users are created by invites, so their email is never "verified" locally.
      accountLinking: { enabled: true, trustedProviders: ['microsoft'], requireLocalEmailVerified: false },
    },
    session: {
      expiresIn: SESSION_MAX_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // Never slide `expires_at`: 7 days is the most. `sessionPrincipal` tracks idle time itself.
      disableSessionRefresh: true,
    },
    user: {
      additionalFields: {
        platformAdmin: { type: 'boolean', input: false, required: false, defaultValue: false },
        disabledAt: { type: 'date', input: false, required: false },
        lastTenantId: { type: 'string', input: false, required: false },
        lastSignInAt: { type: 'date', input: false, required: false },
        entraObjectId: { type: 'string', input: false, required: false },
        entraTenantId: { type: 'string', input: false, required: false },
      },
    },
    advanced: {
      useSecureCookies: config.isProduction,
      database: {
        generateId: ({ model }) => {
          const prefix = ID_PREFIX[model];
          if (!prefix) throw new Error(`No id prefix for better-auth model ${model}`);
          return newId(prefix);
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // People are created by invites, never by signing in.
          before: async () => {
            throw refuse(NOT_SET_UP);
          },
        },
      },
      account: {
        create: {
          // A Microsoft identity links only to someone who may sign in, and only when it fits: the
          // user's pinned identity, or a first link from a trusted Entra tenant (Entra email and UPN
          // claims are not verified). Runs before the row exists, so a refused link leaves nothing.
          before: async (data) => {
            if (data.providerId !== 'microsoft') return;
            const gate = await checkSignIn({ userId: data.userId });
            if (!gate.ok) throw refuse(gate.message);
            const tid = tenantOfIdToken((data as { idToken?: string | null }).idToken);
            if (!(await entraIdentityFits(data.userId, data.accountId, tid, policy))) throw refuse(NOT_SET_UP);
          },
          // Pin the person to this identity at link time.
          after: async (created) => {
            if (!created || created.providerId !== 'microsoft') return;
            await pinEntraIdentity(created.userId, created.accountId, tenantOfIdToken(created.idToken));
          },
        },
      },
      session: {
        create: {
          before: async (data) => {
            const result = await checkSignIn({ userId: data.userId });
            if (!result.ok) throw refuse(result.message);
            try {
              await completeSignIn(result.userId);
            } catch (e) {
              log.error({ err: e, userId: result.userId }, 'could not record sign-in');
              throw new APIError('SERVICE_UNAVAILABLE', { code: 'sign_in_failed', message: SIGN_IN_FAILED });
            }
          },
        },
      },
    },
    plugins: [devSignInPlugin],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;
const get = (): Auth => (instance ??= createAuth());

/** The better-auth instance, created on first use so config is read lazily. */
export const auth: Auth = new Proxy({} as Auth, {
  get: (_t, prop) => Reflect.get(get(), prop),
});

const ALLOWED_PATH = /^\/api\/auth\/(?:sign-in\/social|sign-out|get-session|callback\/[^/]+)\/?$/;

/**
 * The `/api/auth/*` route handler: only the paths in `AUTH_PATHS` reach better-auth; anything else
 * (including patterned paths `disabledPaths` cannot list, such as `/reset-password/:token`) is 404.
 */
export function authHandler(request: Request): Promise<Response> {
  if (!ALLOWED_PATH.test(new URL(request.url).pathname)) {
    return Promise.resolve(new Response('Not Found', { status: 404 }));
  }
  return auth.handler(request);
}
