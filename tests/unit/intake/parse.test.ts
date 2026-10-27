import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseFile } from '@/modules/intake/import/parse';

const enc = (s: string) => new TextEncoder().encode(s);
const csv = (text: string, fileName = 'leads.csv') => parseFile({ fileName, bytes: enc(text) });

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('parseFile: CSV', () => {
  it('reads quotes, escaped quotes and line breaks inside a cell, and keeps row numbers', async () => {
    const p = await csv('Company,Notes\r\n"Acme, Inc.","Said ""call me"" after\nthe demo"\r\nBeta,ok\r\n');
    expect(p.headers).toEqual(['Company', 'Notes']);
    expect(p.rows).toEqual([
      ['Acme, Inc.', 'Said "call me" after\nthe demo'],
      ['Beta', 'ok'],
    ]);
    expect(p.rowNumbers).toEqual([2, 3]);
  });

  it('detects semicolon and tab delimiters and strips a byte order mark', async () => {
    expect((await csv('\uFEFFa;b\n1;2')).headers).toEqual(['a', 'b']);
    expect((await csv('a\tb\n1\t2')).rows).toEqual([['1', '2']]);
  });

  it('suffixes duplicate headers, names blank ones, and skips blank rows without renumbering', async () => {
    const p = await csv('a,a,\n1,2,3\n\n , ,\n4,5,6\n');
    expect(p.headers).toEqual(['a', 'a (2)', 'Column 3']);
    expect(p.rows).toEqual([['1', '2', '3'], ['4', '5', '6']]);
    expect(p.rowNumbers).toEqual([2, 5]);
  });

  it('pads short rows to the header width', async () => {
    expect((await csv('a,b,c\n1\n')).rows).toEqual([['1', '', '']]);
  });
});

describe('parseFile: Markdown', () => {
  it('reads a pipe table and drops the separator row, bold and links', async () => {
    const md = 'Booth scans\n\n| Company | Website |\n|---|:---:|\n| **Acme** | [acme.com](https://acme.com) |\n';
    const p = await parseFile({ fileName: 'scans.md', bytes: enc(md) });
    expect(p.headers).toEqual(['Company', 'Website']);
    expect(p.rows).toEqual([['Acme', 'acme.com']]);
    expect(p.rowNumbers).toEqual([5]);
  });

  it('falls back to a table when a .csv holds one', async () => {
    const p = await csv('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(p.rows).toEqual([['1', '2']]);
  });
});

describe('parseFile: Excel', () => {
  it('lists every sheet, reads the first by default and the named one on request', async () => {
    const bytes = await workbook((wb) => {
      const a = wb.addWorksheet('Leads');
      a.addRow(['Company', 'Employees']);
      a.addRow(['Acme', 250]);
      const b = wb.addWorksheet('Contacts');
      b.addRow(['Name', 'Email', 'Met on']);
      b.addRow(['Jane Doe', 'jane@acme.com', new Date(Date.UTC(2026, 9, 21))]);
      b.addRow([]);
      b.addRow(['Raj Patel', { text: 'raj@acme.com', hyperlink: 'mailto:raj@acme.com' }, 'n/a']);
    });
    const first = await parseFile({ fileName: 'book.xlsx', bytes });
    expect(first.sheets).toEqual(['Leads', 'Contacts']);
    expect(first.sheet).toBe('Leads');
    expect(first.rows).toEqual([['Acme', '250']]);

    const second = await parseFile({ fileName: 'book.xlsx', bytes }, { sheet: 'Contacts' });
    expect(second.sheets).toEqual(['Leads', 'Contacts']);
    expect(second.headers).toEqual(['Name', 'Email', 'Met on']);
    expect(second.rows).toEqual([
      ['Jane Doe', 'jane@acme.com', '2026-10-21'],
      ['Raj Patel', 'raj@acme.com', 'n/a'],
    ]);
    expect(second.rowNumbers).toEqual([2, 4]);
  });

  it('says so when the sheet does not exist', async () => {
    const bytes = await workbook((wb) => wb.addWorksheet('Leads').addRow(['a']));
    await expect(parseFile({ fileName: 'book.xlsx', bytes }, { sheet: 'Nope' })).rejects.toThrow('This file has no sheet called Nope.');
  });
});

describe('parseFile: refusals and limits', () => {
  it('refuses old .xls files and files without data rows', async () => {
    await expect(parseFile({ fileName: 'old.xls', bytes: enc('x') })).rejects.toThrow(/\.xlsx or \.csv/);
    await expect(csv('Company,Website\n', 'empty.csv')).rejects.toThrow(/header row/);
  });

  it('refuses a file over 20 MB', async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    await expect(parseFile({ fileName: 'big.csv', bytes })).rejects.toThrow('This file is over 20 MB. Split it and import the parts.');
  });

  it('refuses more than 10,000 rows, and accepts exactly 10,000', async () => {
    const body = (n: number) => `a,b\n${Array.from({ length: n }, (_, i) => `${i},x`).join('\n')}\n`;
    await expect(csv(body(10_001))).rejects.toThrow('This file has more than 10,000 rows. Split it and import the parts.');
    expect((await csv(body(10_000))).rows).toHaveLength(10_000);
  });

  it('applies the row limit to Excel too', async () => {
    const bytes = await workbook((wb) => {
      const ws = wb.addWorksheet('Big');
      ws.addRow(['a']);
      for (let i = 0; i < 10_001; i++) ws.addRow([i]);
    });
    await expect(parseFile({ fileName: 'big.xlsx', bytes })).rejects.toThrow('This file has more than 10,000 rows. Split it and import the parts.');
  });
});
