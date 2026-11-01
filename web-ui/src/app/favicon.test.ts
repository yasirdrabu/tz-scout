import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('favicon', () => {
  it('index.html links the plum S mark, which public/ ships', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    const svg = readFileSync(resolve(__dirname, '../../public/favicon.svg'), 'utf8');
    expect(svg).toContain('#7b2d6b');
    expect(svg).toMatch(/>S</);
  });
});
