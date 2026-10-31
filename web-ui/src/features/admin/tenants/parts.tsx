import { Pill } from '../../../ui/Pill';
import type { AdminTenant } from './api';

export const initial = (name: string) => name.trim()[0]?.toUpperCase() ?? '?';

export function StatusPill({ status }: { status: AdminTenant['status'] }) {
  return status === 'active' ? <Pill tone="good">Active</Pill> : <Pill tone="near">Suspended</Pill>;
}
