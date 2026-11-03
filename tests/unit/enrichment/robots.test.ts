import { describe, expect, it } from 'vitest';
import { parseRobots } from '@/modules/enrichment/adapters/website/robots';

describe('robots.txt', () => {
  it('Disallow: /about blocks /about/team but not /', () => {
    const r = parseRobots('User-agent: *\nDisallow: /about\n');
    expect(r.allows('/about/team')).toBe(false);
    expect(r.allows('/about')).toBe(false);
    expect(r.allows('/')).toBe(true);
    expect(r.allows('/services')).toBe(true);
  });

  it('reads the * and Scout groups, and ignores other robots', () => {
    const r = parseRobots(['User-agent: Googlebot', 'Disallow: /services', '', 'User-agent: TaazaaScout', 'Disallow: /contact # not for us', '', 'User-agent: *', 'Disallow: /private'].join('\n'));
    expect(r.allows('/services')).toBe(true);
    expect(r.allows('/contact')).toBe(false);
    expect(r.allows('/private/x')).toBe(false);
  });

  it('a group can name several agents', () => {
    const r = parseRobots('User-agent: Bingbot\nUser-agent: scout\nDisallow: /industries\n');
    expect(r.allows('/industries/health')).toBe(false);
  });

  it('an empty Disallow allows everything, and so does no file', () => {
    expect(parseRobots('User-agent: *\nDisallow:\n').allows('/about')).toBe(true);
    expect(parseRobots('').allows('/')).toBe(true);
  });

  it('Disallow: / blocks every page', () => {
    expect(parseRobots('user-agent: *\r\ndisallow: /\r\n').allows('/')).toBe(false);
  });
});
