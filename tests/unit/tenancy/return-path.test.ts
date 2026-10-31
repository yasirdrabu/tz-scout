import { describe, expect, it } from 'vitest';
import { safeReturnPath, signInErrorUrl } from '@/modules/tenancy/domain/return-path';

describe('safeReturnPath', () => {
  it('keeps a relative in-app path', () => {
    expect(safeReturnPath('/t/acme/queue?tier=a#top')).toBe('/t/acme/queue?tier=a#top');
    expect(safeReturnPath('/')).toBe('/');
  });

  it.each([undefined, null, 1, '', 'welcome', '//evil.example', '/\\evil.example', 'https://evil.example/x', 'javascript:alert(1)', '/a\nb', '/%2F%2Fevil.example'])(
    'replaces %s with the home page',
    (raw) => {
      expect(safeReturnPath(raw)).toBe('/');
    },
  );
});

describe('signInErrorUrl', () => {
  it('is the app sign-in page, carrying the return path unless it is the home page', () => {
    expect(signInErrorUrl('https://scout.example', '/')).toBe('https://scout.example/signin');
    expect(signInErrorUrl('https://scout.example/', '/t/acme/queue?x=1')).toBe(
      'https://scout.example/signin?return=%2Ft%2Facme%2Fqueue%3Fx%3D1',
    );
  });
});
