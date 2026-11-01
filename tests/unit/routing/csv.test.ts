import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '@/modules/routing/domain/csv';

describe('csv', () => {
  it('quotes what needs it and leaves the rest', () => {
    expect(csvCell('Acme')).toBe('Acme');
    expect(csvCell('Miami, FL')).toBe('"Miami, FL"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
  });

  it('makes a formula plain text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@sum')).toBe("'@sum");
  });

  it('writes a header and rows with CRLF', () => {
    expect(toCsv(['A', 'B'], [['1', null]])).toBe('A,B\r\n1,\r\n');
  });
});
