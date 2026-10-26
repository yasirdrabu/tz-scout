import type { ReactNode } from 'react';
import { pageContext } from '@/server/page-context';

// Resolves the person and tenant once, so every page below is signed in and scoped.
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenant: string }>;
}) {
  await pageContext((await params).tenant);
  return children;
}
