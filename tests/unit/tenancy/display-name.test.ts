import { describe, expect, it } from 'vitest';
import { displayNameFromEmail } from '@/modules/tenancy/domain/display-name';

describe('displayNameFromEmail', () => {
  it('splits the local part on dots, underscores and hyphens and capitalises each part', () => {
    expect(displayNameFromEmail('zach.wiant@taazaa.com')).toBe('Zach Wiant');
    expect(displayNameFromEmail('mary-jo_smith@x.com')).toBe('Mary Jo Smith');
    expect(displayNameFromEmail('ash@taazaa.com')).toBe('Ash');
  });

  it('keeps an odd address readable', () => {
    expect(displayNameFromEmail('a..b@x.com')).toBe('A B');
    expect(displayNameFromEmail('@x.com')).toBe('@x.com');
  });
});
