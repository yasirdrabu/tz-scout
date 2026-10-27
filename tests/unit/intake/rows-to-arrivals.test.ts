import { describe, expect, it } from 'vitest';
import { ArrivalV1Schema } from '@/modules/intake/contracts/arrival';
import { rowsToArrivals } from '@/modules/intake/import/rows-to-arrivals';
import type { ParsedFile } from '@/modules/intake/import/parse';
import { synonymMapping } from '@/modules/intake/import/synonyms';

const parsed = (headers: string[], rows: string[][]): ParsedFile => ({
  headers,
  rows,
  rowNumbers: rows.map((_, i) => i + 2),
  sheets: [],
  sheet: null,
});
const map = (targets: Record<string, string | null>, headers = Object.keys(targets)) => ({
  columns: headers.map((header) => ({ header, target: targets[header] ?? null, confidence: 0.9, reason: '' })),
});
const run = (p: ParsedFile, m: ReturnType<typeof map>) => rowsToArrivals(p, m, { fileName: 'leads.csv' });
const lenient = ArrivalV1Schema({ strict: false });

describe('rowsToArrivals: grouping', () => {
  const headers = ['Company', 'Website', 'Name', 'Title', 'Email'];
  const mapping = map({ Company: 'account.name', Website: 'account.website', Name: 'people[0].name', Title: 'people[0].title', Email: 'people[0].email' });

  it('groups rows by website domain, else work-email domain, and de-duplicates people', () => {
    const rows = [
      ['Acme', '', 'Jane Doe', 'CIO', 'jane@acme.com'],
      ['Acme', 'https://www.acme.com/about', 'Raj Patel', 'COO', 'raj@acme.com'],
      ['Acme', '', 'Jane Doe', 'CIO', 'JANE@acme.com'],
    ];
    const { arrivals, skipped } = run(parsed(headers, rows), mapping);
    expect(skipped).toEqual([]);
    expect(arrivals).toHaveLength(1);
    const { body, raw } = arrivals[0]!;
    expect(body.account).toMatchObject({ name: 'Acme', website: 'https://www.acme.com/about' });
    expect(body.people.map((p) => p.email)).toEqual(['jane@acme.com', 'raj@acme.com']);
    expect(raw.headers).toEqual(headers);
    expect(raw.rows).toEqual(rows);
    expect(lenient.safeParse(body).success).toBe(true);
  });

  it('puts two @acme.com rows with no website into one arrival with two people', () => {
    const { arrivals } = run(parsed(['Name', 'Email'], [['Jane Doe', 'jane@acme.com'], ['Raj Patel', 'raj@acme.com']]), map({ Name: 'people[0].name', Email: 'people[0].email' }));
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.body.people).toHaveLength(2);
    expect(arrivals[0]!.body.account?.name).toBeUndefined();
  });

  it('keeps a company with no website, so it can wait for one', () => {
    const { arrivals, skipped } = run(parsed(headers, [['Nobody', '', '', '', '']]), mapping);
    expect(skipped).toEqual([]);
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.body.account).toEqual({ name: 'Nobody' });
  });
});

describe('rowsToArrivals: skipped rows', () => {
  it('skips a personal-email row with no company, with its row number', () => {
    const rows = [['Acme', 'acme.com', 'Jane Doe', 'jane@acme.com'], ['', '', 'Sam Lee', 'sam@gmail.com'], ['', '', '', '']];
    const p = parsed(['Company', 'Website', 'Name', 'Email'], rows);
    p.rowNumbers = [2, 5, 9];
    const { arrivals, skipped } = run(p, map({ Company: 'account.name', Website: 'account.website', Name: 'people[0].name', Email: 'people[0].email' }));
    expect(arrivals).toHaveLength(1);
    expect(skipped).toEqual([
      { row: 5, reason: 'Personal email and no company' },
      { row: 9, reason: 'No company, website or work email' },
    ]);
  });

  it('keeps a personal-email person when the row names a company', () => {
    const { arrivals, skipped } = run(parsed(['Company', 'Email'], [['Solo Ltd', 'sam@gmail.com']]), map({ Company: 'account.name', Email: 'people[0].email' }));
    expect(skipped).toEqual([]);
    expect(arrivals[0]!.body.people).toEqual([{ email: 'sam@gmail.com' }]);
  });
});

describe('rowsToArrivals: people groups', () => {
  const headers = ['Company', 'Website', 'C1 name', 'C1 title', 'C3 name', 'C3 email', 'C2 name'];
  const mapping = map({ Company: 'account.name', Website: 'account.website', 'C1 name': 'people[0].name', 'C1 title': 'people[0].title', 'C3 name': 'people[2].name', 'C3 email': 'people[2].email', 'C2 name': 'people[1].name' });

  it('reads every group, in group order', () => {
    const { arrivals } = run(parsed(headers, [['Acme', 'acme.com', 'Jane Doe', 'CIO', 'Raj Patel', 'raj@acme.com', 'Mia Chen']]), mapping);
    expect(arrivals[0]!.body.people).toEqual([
      { name: 'Jane Doe', title: 'CIO' },
      { name: 'Mia Chen' },
      { name: 'Raj Patel', email: 'raj@acme.com' },
    ]);
  });

  it('compacts over a gap and skips empty groups', () => {
    const gappy = map({ Company: 'account.name', Website: 'account.website', 'C1 name': 'people[0].name', 'C3 name': 'people[2].name' }, ['Company', 'Website', 'C1 name', 'C3 name']);
    const rows = [['Acme', 'acme.com', '', 'Raj Patel'], ['Acme', 'acme.com', '', '']];
    const { arrivals } = run(parsed(['Company', 'Website', 'C1 name', 'C3 name'], rows), gappy);
    expect(arrivals[0]!.body.people).toEqual([{ name: 'Raj Patel' }]);
  });
});

describe('rowsToArrivals: other targets', () => {
  const headers = ['Company', 'Website', 'Employees', 'Notes', 'Region tag', 'Why', 'When', 'Link', 'Kind', 'Hook', 'Score', 'Bogus'];
  const mapping = map({
    Company: 'account.name', Website: 'account.website', Employees: 'account.employees', Notes: 'account.notes',
    'Region tag': 'account.custom_fields.region_tag', Why: 'signals[].title', When: 'signals[].occurred_at', Link: 'signals[].url',
    Kind: 'signals[].type', Hook: 'research.hook', Score: 'research.researcher_score', Bogus: 'research.not_a_field',
  });

  it('builds custom fields, signals, research, notes and employees', () => {
    const rows = [
      ['Acme', 'acme.com', '51-200', 'Met at booth', 'west', 'Raised Series B', '10/22/2026', 'https://x.com/a', 'trigger', 'Hi there', '91', 'x'],
      ['Acme', 'acme.com', '', 'Asked for pricing', '', 'Named new CIO', '2026-10-23T09:00:00Z', '', 'leadership', '', '', ''],
    ];
    const { arrivals } = run(parsed(headers, rows), mapping);
    const b = arrivals[0]!.body;
    expect(b.account).toMatchObject({ employees_range: '51-200', notes: 'Met at booth\nAsked for pricing', custom_fields: { region_tag: 'west' } });
    expect(b.signals).toEqual([
      { type: 'trigger', title: 'Raised Series B', occurred_at: '2026-10-22', url: 'https://x.com/a' },
      { fine_type: 'leadership', title: 'Named new CIO', occurred_at: '2026-10-23' },
    ]);
    expect(b.research).toEqual({ hook: 'Hi there', researcher_score: 91 });
    expect(lenient.safeParse(b).success).toBe(true);
  });

  it('gives a signal with no kind the research kind, so it may be undated', () => {
    const { arrivals } = run(parsed(['Company', 'Website', 'Why'], [['Acme', 'acme.com', 'Looking at AI']]), map({ Company: 'account.name', Website: 'account.website', Why: 'signals[].title' }));
    expect(arrivals[0]!.body.signals).toEqual([{ type: 'research', title: 'Looking at AI' }]);
    expect(lenient.safeParse(arrivals[0]!.body).success).toBe(true);
  });

  it('works with the header-synonym mapping', () => {
    const headers2 = ['Company Name', 'Work Email', 'Job Title', 'Name'];
    const m = synonymMapping({ headers: headers2, sampleRows: [] });
    const { arrivals } = run(parsed(headers2, [['Acme', 'jane@acme.com', 'CIO', 'Jane Doe']]), m);
    expect(arrivals[0]!.body.people).toEqual([{ name: 'Jane Doe', title: 'CIO', email: 'jane@acme.com' }]);
  });
});
