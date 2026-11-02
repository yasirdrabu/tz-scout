import { describe, expect, it } from 'vitest';
import { workspaceRoute } from '@/platform/db/doors';

const row = (status: string) => ({ status, database: 'scout_t_01abc' });

describe('workspaceRoute: where a tenant works, from its registry row (D35)', () => {
  it('shared mode: the shared database, with or without a row', () => {
    expect(workspaceRoute('t_a', row('active'), 'shared')).toEqual({ shared: true });
    expect(workspaceRoute('t_a', null, 'shared')).toEqual({ shared: true });
  });

  it('per_workspace mode: the row names the database; no row is an error', () => {
    expect(workspaceRoute('t_a', row('active'), 'per_workspace')).toEqual({ database: 'scout_t_01abc' });
    expect(() => workspaceRoute('t_a', null, 'per_workspace')).toThrow('Tenant t_a has no workspace registry row');
  });

  it('refuses every workspace not active, suspended included, in either mode', () => {
    for (const status of ['provisioning', 'suspended', 'exporting', 'deleting', 'deleted', 'failed']) {
      for (const mode of ['shared', 'per_workspace'] as const) {
        expect(() => workspaceRoute('t_a', row(status), mode)).toThrow(expect.objectContaining({ slug: 'workspace-unavailable', status: 503 }));
      }
    }
  });
});
