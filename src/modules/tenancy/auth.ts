import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { config, type Config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { newId, type IdPrefix } from '@/platform/ids';
import { account, session, user, verification } from './db/schema';
import { NOT_SET_UP, checkSignIn, completeSignIn, entraIdentityFits, signInEmailFor } from './services/sign-in';

/** Most a session lives, from sign-in. */
export const SESSION_MAX_SECONDS = 7 * 24 * 3600;
/** How often a session's last activity (`updated_at`) is written. */
export const SESSION_UPDATE_AGE_SECONDS = 3600;

const ID_PREFIX: Record<string, IdPrefix> = { user: 'usr', session: 'ses', account: 'oac', verification: 'vrf' };

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
  return betterAuth({
    appName: 'Scout',
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
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
            // Match on our user's email: found by Entra object id, then email, then UPN.
            mapProfileToUser: async (profile) => {
              const email = await signInEmailFor(profile as Record<string, unknown>);
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
      },
    },
    advanced: {
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
          // Once a person has signed in, their Entra object id is pinned: a different Microsoft
          // identity that merely claims the same email (Entra email claims are not verified) is refused.
          before: async (data) => {
            if (data.providerId !== 'microsoft') return;
            if (!(await entraIdentityFits(data.userId, data.accountId))) throw refuse(NOT_SET_UP);
          },
        },
      },
      session: {
        create: {
          before: async (data) => {
            const result = await checkSignIn({ userId: data.userId });
            if (!result.ok) throw refuse(result.message);
            await completeSignIn(result.userId);
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
