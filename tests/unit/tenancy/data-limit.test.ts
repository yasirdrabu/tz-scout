import { describe, expect, it } from 'vitest';
import { DEFAULT_DATA_LIMIT, DataLimitSchema, defaultDataLimit } from '@/modules/tenancy';

describe('DataLimitSchema', () => {
  it('rejects practices without ids', () => {
    expect(DataLimitSchema.safeParse({ kind: 'practices' }).success).toBe(false);
    expect(DataLimitSchema.safeParse({ kind: 'sources', ids: 'x' }).success).toBe(false);
  });
  it('accepts every kind', () => {
    for (const v of [
      { kind: 'all' },
      { kind: 'practices', ids: ['prc_1'] },
      { kind: 'own_accounts' },
      { kind: 'sources', ids: ['src_1'] },
      { kind: 'own_source' },
      {
        kind: 'any_of',
        limits: [{ kind: 'own_accounts' }, { kind: 'sources', ids: ['src_1'] }],
      },
    ]) {
      expect(DataLimitSchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
    }
  });
  it('rejects unknown kinds and empty any_of', () => {
    expect(DataLimitSchema.safeParse({ kind: 'everything' }).success).toBe(false);
    expect(DataLimitSchema.safeParse({ kind: 'any_of', limits: [] }).success).toBe(false);
  });
  it('defaults', () => {
    expect(DEFAULT_DATA_LIMIT.owner).toEqual({ kind: 'all' });
    expect(DEFAULT_DATA_LIMIT.leader).toEqual({ kind: 'all' });
    expect(DEFAULT_DATA_LIMIT.operator).toEqual({ kind: 'all' });
    expect(DEFAULT_DATA_LIMIT.seller).toEqual({ kind: 'own_accounts' });
    expect(defaultDataLimit('api_key')).toEqual({ kind: 'own_source' });
    expect(defaultDataLimit('oauth')).toEqual({ kind: 'own_source' });
  });
});
