import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

// SRC-E4: CSV, Excel and Markdown files to rows. Ported from v1 `leadSheet.ts`, with Excel read as a stream.

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_ROWS = 10_000;

/** A file the person can fix: too big, the wrong kind, or empty. The message is shown as written. */
export class FileParseError extends Error {}

export type ParsedFile = {
  headers: string[];
  /** Data rows, padded to the header width. Blank rows are gone. */
  rows: string[][];
  /** Each row's number in the file as the person sees it (the header row counts), parallel to `rows`. */
  rowNumbers: number[];
  /** Every sheet of an Excel file, in order. Empty for CSV and Markdown. */
  sheets: string[];
  /** The sheet that was read, null for CSV and Markdown. */
  sheet: string | null;
};

type Numbered = { n: number; cells: string[] };

const TOO_BIG = 'This file is over 20 MB. Split it and import the parts.';
const TOO_MANY = 'This file has more than 10,000 rows. Split it and import the parts.';
// Rows of any kind, blank ones included, that a sheet may hold before it is refused.
const HARD_ROW_CEILING = 100_000;
const blank = (cells: string[]) => cells.every((c) => c.trim() === '');

/** CSV with quotes, escaped quotes and line breaks inside quotes. Detects comma, semicolon or tab. */
function parseCsv(text: string): Numbered[] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t']
    .map((d) => [d, firstLine.split(d).length] as const)
    .sort((a, b) => b[1] - a[1])[0]![0];
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    records.push(row);
  }
  return records.map((cells, i) => ({ n: i + 1, cells })).filter((r) => !blank(r.cells));
}

/** Markdown pipe tables. Lines that are not table rows are ignored; the separator row is dropped. */
function parseMarkdown(text: string): Numbered[] {
  const rows: Numbered[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line.startsWith('|') && !(line.includes('|') && line.split('|').length > 2)) return;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return; // |---|---|
    rows.push({
      n: i + 1,
      cells: cells.map((c) => c.replace(/^\*\*(.*)\*\*$/, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')),
    });
  });
  return rows;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return cellText(v.text as ExcelJS.CellValue);
    return ''; // an error cell
  }
  return String(v);
}

type Sheet = { rows: Numbered[]; sheets: string[]; sheet: string };

function rowCells(row: { values: ExcelJS.CellValue[] | unknown }): string[] {
  const values = row.values as ExcelJS.CellValue[];
  return Array.from({ length: Math.max(values.length - 1, 0) }, (_, i) => cellText(values[i + 1] ?? null).trim());
}

function noSheet(want: string | undefined): FileParseError {
  return new FileParseError(want === undefined ? 'This file has no sheets.' : `This file has no sheet called ${want}.`);
}

/** Streams the workbook. Every sheet is listed; only `want` (default the first) is read. */
async function streamWorkbook(bytes: Uint8Array, want: string | undefined): Promise<Sheet> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([Buffer.from(bytes)]), {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
  });
  const sheets: string[] = [];
  let chosen: string | null = null;
  const rows: Numbered[] = [];
  for await (const ws of reader) {
    const name = (ws as unknown as { name: string }).name;
    sheets.push(name);
    if (chosen !== null || (want !== undefined && name !== want)) continue;
    chosen = name;
    let seen = 0;
    for await (const row of ws) {
      if (++seen > HARD_ROW_CEILING) throw new FileParseError(TOO_MANY);
      const cells = rowCells(row);
      if (blank(cells)) continue;
      rows.push({ n: row.number, cells });
      if (rows.length > MAX_FILE_ROWS + 1) throw new FileParseError(TOO_MANY);
    }
  }
  if (chosen === null) throw noSheet(want);
  return { rows, sheets, sheet: chosen };
}

/** The same read without streaming, for files the streaming reader cannot follow. */
async function loadWorkbook(bytes: Uint8Array, want: string | undefined): Promise<Sheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const sheets = wb.worksheets.map((w) => w.name);
  const ws = want === undefined ? wb.worksheets[0] : wb.worksheets.find((w) => w.name === want);
  if (!ws) throw noSheet(want);
  if (ws.rowCount > HARD_ROW_CEILING || ws.actualRowCount > MAX_FILE_ROWS + 1) throw new FileParseError(TOO_MANY);
  const rows: Numbered[] = [];
  for (let n = 1; n <= ws.rowCount; n++) {
    const cells = rowCells(ws.getRow(n));
    if (blank(cells)) continue;
    rows.push({ n, cells });
    if (rows.length > MAX_FILE_ROWS + 1) throw new FileParseError(TOO_MANY);
  }
  return { rows, sheets, sheet: ws.name };
}

const UNREADABLE = "We couldn't read this Excel file. Save it again as .xlsx and retry.";

// The streaming reader needs the workbook part before the sheets. On a file that orders them otherwise
// (exceljs's own writer does) it fails with this one error, and only then is the file loaded whole (20 MB at most).
const isOrderingFailure = (e: unknown) => e instanceof TypeError && /reading 'sheets'/.test(e.message);

async function readWorkbook(bytes: Uint8Array, want: string | undefined): Promise<Sheet> {
  try {
    try {
      return await streamWorkbook(bytes, want);
    } catch (e) {
      if (!isOrderingFailure(e)) throw e;
      return await loadWorkbook(bytes, want);
    }
  } catch (e) {
    throw e instanceof FileParseError ? e : new FileParseError(UNREADABLE);
  }
}

function extensionOf(fileName: string, contentType?: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['csv', 'tsv', 'txt', 'md', 'markdown', 'xlsx', 'xls'].includes(ext)) return ext;
  if (/spreadsheetml/.test(contentType ?? '')) return 'xlsx';
  if (/markdown/.test(contentType ?? '')) return 'md';
  return 'csv';
}

export async function parseFile(
  file: { fileName: string; contentType?: string; bytes: Uint8Array },
  opts: { sheet?: string } = {},
): Promise<ParsedFile> {
  if (file.bytes.byteLength > MAX_FILE_BYTES) throw new FileParseError(TOO_BIG);
  const ext = extensionOf(file.fileName, file.contentType);
  if (ext === 'xls') {
    throw new FileParseError("Old .xls files aren't supported. Save it as .xlsx or .csv and try again.");
  }
  let rows: Numbered[];
  let sheets: string[] = [];
  let sheet: string | null = null;
  if (ext === 'xlsx') ({ rows, sheets, sheet } = await readWorkbook(file.bytes, opts.sheet));
  else {
    const text = new TextDecoder('utf-8').decode(file.bytes);
    const markdown = ext === 'md' || ext === 'markdown';
    rows = markdown ? parseMarkdown(text) : parseCsv(text);
    // A pipe table saved as .csv has one "column" per line and no delimiter.
    if (!markdown && rows.length && rows.every((r) => r.cells.length === 1)) {
      const table = parseMarkdown(text);
      if (table.length) rows = table;
    }
  }
  if (rows.length < 2) throw new FileParseError("Didn't find a header row and at least one row of data.");
  if (rows.length - 1 > MAX_FILE_ROWS) throw new FileParseError(TOO_MANY);

  const width = Math.max(...rows.map((r) => r.cells.length));
  const pad = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill('')].map((c) => c.trim());
  const [head, ...data] = rows;
  const seen = new Map<string, number>();
  const headers = pad(head!.cells).map((h, i) => {
    const base = h || `Column ${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  return { headers, rows: data.map((r) => pad(r.cells)), rowNumbers: data.map((r) => r.n), sheets, sheet };
}
