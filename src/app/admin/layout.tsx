import type { ReactNode } from 'react';
import { adminContext } from '@/server/page-context';

// Platform admins only. Pages and actions check again; this keeps every page below out of reach.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await adminContext();
  return children;
}
