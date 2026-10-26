import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DevSignIn, MicrosoftSignIn } from '@/components/client';
import { Card } from '@/components/ui';
import { config } from '@/platform/config';
import { devSignInUsers, sessionUser } from '@/modules/tenancy';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

export default async function SignInPage() {
  if (await sessionUser(await headers())) redirect('/');
  const microsoft = Boolean(config.azureAd);
  const dev = config.authDevSignin;
  const users = dev ? await devSignInUsers() : [];
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-accent text-sm font-bold text-white">S</div>
          <div>
            <div className="text-base font-semibold">Scout</div>
            <div className="text-xs text-ink-muted">Find, qualify and win the right accounts.</div>
          </div>
        </div>
        <Card className="space-y-4 p-5">
          <h1 className="text-sm font-semibold">Sign in</h1>
          {microsoft && <MicrosoftSignIn />}
          {dev && (
            <div>
              <h2 className="mb-2 text-xs font-medium text-ink-soft">Developer sign-in</h2>
              <DevSignIn
                users={users.map((u) => ({ id: u.id, email: u.email, detail: u.platformAdmin ? 'Platform admin' : u.name }))}
              />
            </div>
          )}
          {!microsoft && !dev && (
            <p className="text-sm text-ink-muted">
              No sign-in method is set up. Add the Microsoft 365 settings to the environment, then restart.
            </p>
          )}
        </Card>
        {dev && (
          <p className="mt-3 text-center text-2xs text-ink-faint">
            Developer sign-in is on. Turn it off before anyone outside the team can reach this app.
          </p>
        )}
      </div>
    </main>
  );
}
