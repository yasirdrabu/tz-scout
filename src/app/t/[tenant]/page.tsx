import { EmptyState, PageHeader } from '@/components/ui';
import { TenantShell } from '@/components/shell';
import { pageContext } from '@/server/page-context';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Home' };

export default async function TenantHome({ params }: { params: Promise<{ tenant: string }> }) {
  const ctx = await pageContext((await params).tenant);
  return (
    <TenantShell ctx={ctx} current="home">
      <PageHeader title={ctx.tenant.name} />
      <EmptyState title="Nothing here yet">Accounts arrive here in the next release.</EmptyState>
    </TenantShell>
  );
}
