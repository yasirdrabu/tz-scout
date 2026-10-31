import { expect, it } from 'vitest';
import { KEY_ACCESS, keyMask } from '@/modules/tenancy/domain/key-access';

it('turns each access choice into scopes', () => {
  expect(KEY_ACCESS.send_and_status).toEqual(['arrivals:write', 'arrivals:read', 'status:read']);
  expect(KEY_ACCESS.send_only).toEqual(['arrivals:write']);
  expect(KEY_ACCESS.read_only).toEqual(['accounts:read', 'status:read']);
});

it('masks a key from its prefix', () => {
  expect(keyMask('scout_live_AbCd1234')).toBe('scout_live_AbCd1234…');
});
