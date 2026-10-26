import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignOutButton } from '@/components/client';
import { Card, Notice } from '@/components/ui';
import { NOT_SET_UP, landingPathFor, sessionUser } from '@/modules/tenancy';

export const dynamic = 'force-dynamic';

// Sends people to their workspace. Platform admins without one go to the workspace list.
export default async function Home() {
  const user = await sessionUser(await headers());
  if (!user) redirect('/signin');
  const path = await landingPathFor(user.userId);
  if (path !== '/') redirect(path);
  if (user.platformAdmin) redirect('/admin/tenants');
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md space-y-3 p-5">
        <Notice tone="near">{NOT_SET_UP}</Notice>
        <SignOutButton />
      </Card>
    </main>
  );
}
