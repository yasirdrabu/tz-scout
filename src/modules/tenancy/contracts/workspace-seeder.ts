import type { Envelope } from '@/platform/events/envelope';

/**
 * Seeds a new workspace's defaults by running the `tenancy.tenant.created` consumers against it before
 * it opens (D35 provisioning). The worker's composition registers it (entry/worker.ts), so tenancy does
 * not import the modules that seed. Each consumer records the event as processed, so its later NATS
 * delivery is a duplicate.
 */
export type WorkspaceSeeder = (tenantCreated: Envelope) => Promise<void>;

let seeder: WorkspaceSeeder | null = null;

export function registerWorkspaceSeeder(s: WorkspaceSeeder | null): void {
  seeder = s;
}

export function workspaceSeeder(): WorkspaceSeeder | null {
  return seeder;
}
