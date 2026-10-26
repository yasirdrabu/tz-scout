// Sign-in. Microsoft 365 (Entra ID) when configured; a dev sign-in listing seeded users while
// AUTH_DEV_SIGNIN=true. Only people who already have a User record can sign in either way.

import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";
import { unscopedDb } from "./db";

export const devSignInEnabled = () => process.env.AUTH_DEV_SIGNIN === "true";
export const microsoftEnabled = () => Boolean(process.env.AZURE_AD_CLIENT_ID && process.env.AZURE_AD_CLIENT_SECRET && process.env.AZURE_AD_TENANT_ID);

const providers: NextAuthOptions["providers"] = [];

if (microsoftEnabled()) {
  providers.push(
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
      tenantId: process.env.AZURE_AD_TENANT_ID!,
      // Entra only sends the email claim when the account has one set; the sign-in name (UPN) is
      // the same address for Taazaa accounts, so fall back to it rather than refusing the sign-in.
      profile: (p: { sub: string; name?: string; email?: string; preferred_username?: string }) => ({ id: p.sub, name: p.name ?? null, email: (p.email ?? p.preferred_username ?? "").toLowerCase() || null, image: null }),
    }),
  );
}

providers.push(
  CredentialsProvider({
    id: "dev",
    name: "Dev sign-in",
    credentials: { email: { label: "Email", type: "email" } },
    async authorize(creds) {
      if (!devSignInEnabled()) return null;
      const email = String(creds?.email ?? "").toLowerCase();
      const user = await unscopedDb.user.findUnique({ where: { email } });
      return user ? { id: user.id, email: user.email, name: user.name } : null;
    },
  }),
);

export const authOptions: NextAuthOptions = {
  providers,
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false;
      const known = await unscopedDb.user.findUnique({ where: { email: user.email.toLowerCase() } });
      return known ? true : "/signin?error=not_invited";
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const u = await unscopedDb.user.findUnique({ where: { email: user.email.toLowerCase() } });
        if (u) token.uid = u.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.uid) (session.user as { id?: string }).id = token.uid as string;
      return session;
    },
  },
};

export type SessionUser = { id: string; email: string; name: string; isAdmin: boolean };

export async function currentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) return null;
  const u = await unscopedDb.user.findUnique({ where: { id } });
  return u ? { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin } : null;
}
