// Lead sheets: read a CSV, Excel or Markdown file into rows, suggest which column is which, and group
// rows into companies (by website or work-email domain) with their people. Pure and tested; the import
// itself is src/server/leadImport.ts.

import { FREE_EMAIL_DOMAINS } from "./leadChecks";

export type Sheet = { headers: string[]; rows: string[][] };

// ---------- Parsing ----------

/** CSV with quotes, escaped quotes and line breaks inside quotes. Detects comma, semicolon or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
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
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Markdown pipe tables. Lines that aren't table rows are ignored; the separator row is dropped. */
export function parseMarkdown(text: string): string[][] {
  const rows: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|") && !(line.includes("|") && line.split("|").length > 2)) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue; // |---|---|
    rows.push(cells.map((c) => c.replace(/^\*\*(.*)\*\*$/, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")));
  }
  return rows;
}

const colIndex = (ref: string) => {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};
const xmlText = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The first sheet of an .xlsx file, read straight from its XML (no spreadsheet library needed). */
export async function parseXlsx(bytes: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const read = async (p: string) => (await zip.file(p)?.async("string")) ?? null;
  const workbook = (await read("xl/workbook.xml")) ?? "";
  const rels = (await read("xl/_rels/workbook.xml.rels")) ?? "";
  const firstSheetRel = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const target = firstSheetRel ? rels.match(new RegExp(`Id="${firstSheetRel}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${firstSheetRel}"`))?.[1] : null;
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const sheet = (await read(sheetPath)) ?? (await read("xl/worksheets/sheet1.xml"));
  if (!sheet) throw new Error("Couldn't find a worksheet in this file.");
  const shared = [...((await read("xl/sharedStrings.xml")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]!));
  const rows: string[][] = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const inner = c[2] ?? "";
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s" && v != null) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = xmlText(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "");
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else if (v != null) value = xmlText(v);
      const at = ref ? colIndex(ref) : row.length;
      while (row.length < at) row.push("");
      row[at] = value.trim();
    }
    if (row.some((x) => x !== "")) rows.push(row);
  }
  return rows;
}

/** Any supported file to a sheet: the first non-empty row is the header row. */
export async function readSheet(fileName: string, bytes: ArrayBuffer | Uint8Array): Promise<Sheet> {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  let rows: string[][];
  if (ext === "xlsx") rows = await parseXlsx(bytes);
  else if (ext === "xls") throw new Error("Old .xls files aren't supported. Save it as .xlsx or .csv and try again.");
  else {
    const text = new TextDecoder("utf-8").decode(bytes);
    rows = ext === "md" || ext === "markdown" ? parseMarkdown(text) : parseCsv(text);
    if (!rows.length && ext !== "md") rows = parseMarkdown(text);
  }
  if (rows.length < 2) throw new Error("Didn't find a header row and at least one row of data.");
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")].map((c) => c.trim());
  const [head, ...data] = rows.map(pad);
  return { headers: head!.map((h, i) => h || `Column ${i + 1}`), rows: data };
}

// ---------- Columns ----------

export const LEAD_FIELDS = [
  { key: "company", label: "Company", aliases: ["company", "company name", "organization", "organisation", "account", "account name", "employer", "business"] },
  { key: "website", label: "Website or domain", aliases: ["website", "domain", "url", "company website", "web", "site", "company domain", "company url"] },
  { key: "fullName", label: "Full name", aliases: ["name", "full name", "contact", "contact name", "attendee", "person"] },
  { key: "firstName", label: "First name", aliases: ["first name", "first", "firstname", "given name"] },
  { key: "lastName", label: "Last name", aliases: ["last name", "last", "lastname", "surname", "family name"] },
  { key: "title", label: "Title", aliases: ["title", "job title", "position", "role", "job"] },
  { key: "email", label: "Email", aliases: ["email", "email address", "work email", "e-mail", "business email"] },
  { key: "phone", label: "Phone", aliases: ["phone", "phone number", "mobile", "cell", "direct", "telephone"] },
  { key: "linkedin", label: "LinkedIn", aliases: ["linkedin", "linkedin url", "linkedin profile", "li"] },
  { key: "industry", label: "Industry", aliases: ["industry", "sector", "vertical"] },
  { key: "employees", label: "Employees", aliases: ["employees", "employee count", "company size", "headcount", "size", "# employees"] },
  { key: "city", label: "City", aliases: ["city", "town"] },
  { key: "state", label: "State or region", aliases: ["state", "region", "province"] },
  { key: "country", label: "Country", aliases: ["country"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note", "comments", "comment", "context", "conversation"] },
] as const;
export type LeadField = (typeof LEAD_FIELDS)[number]["key"];
export type Mapping = Partial<Record<LeadField, number>>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/** Best guess at which column holds which field. Exact alias first, then a contained alias. */
export function suggestMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<number>();
  const H = headers.map(norm);
  for (const pass of ["exact", "contains"] as const) {
    for (const f of LEAD_FIELDS) {
      if (m[f.key] != null) continue;
      const i = H.findIndex((h, idx) => !used.has(idx) && f.aliases.some((a) => (pass === "exact" ? h === a : h.includes(a) && a.length > 3)));
      if (i >= 0) {
        m[f.key] = i;
        used.add(i);
      }
    }
  }
  return m;
}

// ---------- Rows to companies ----------

export function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.includes("@")) {
    const d = v.split("@").pop()!.replace(/[>\s].*$/, "");
    return d && !FREE_EMAIL_DOMAINS.has(d) && d.includes(".") ? d : null;
  }
  v = v.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0]!;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/** "1,001-5,000" -> 1001..5000 midpoint-ish; "250" -> 250; "51-200 employees" -> 101. */
export function employeesOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const nums = value.replace(/,/g, "").match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length) return null;
  if (nums.length === 1) return nums[0]!;
  return Math.round(Math.sqrt(nums[0]! * nums[1]!));
}

export type SheetPerson = { firstName: string; lastName: string | null; title: string | null; email: string | null; phone: string | null; linkedin: string | null; row: number };
export type SheetCompany = { domain: string; name: string; industry: string | null; employees: number | null; city: string | null; state: string | null; country: string | null; notes: string[]; people: SheetPerson[]; rows: number[] };
export type SkippedRow = { row: number; reason: string; preview: string; company?: string; needsWebsite?: boolean };

export function groupRows(rows: string[][], m: Mapping): { companies: SheetCompany[]; skipped: SkippedRow[] } {
  const get = (r: string[], f: LeadField) => (m[f] != null ? (r[m[f]!] ?? "").trim() : "");
  const byDomain = new Map<string, SheetCompany>();
  const skipped: SkippedRow[] = [];
  rows.forEach((r, i) => {
    const rowNo = i + 2; // as the person sees it: row 1 is the header
    const email = get(r, "email");
    const domain = domainOf(get(r, "website")) ?? domainOf(email);
    const preview = r.filter(Boolean).slice(0, 4).join(" · ");
    if (!domain) {
      skipped.push({ row: rowNo, reason: email && !domainOf(email) && email.includes("@") ? "Personal email and no website, so the company can't be identified." : "No website and no work email, so the company can't be identified.", preview });
      return;
    }
    const companyName = get(r, "company") || domain.split(".")[0]!.replace(/^\w/, (c) => c.toUpperCase());
    const c = byDomain.get(domain) ?? { domain, name: companyName, industry: null, employees: null, city: null, state: null, country: null, notes: [], people: [], rows: [] };
    c.rows.push(rowNo);
    c.industry ??= get(r, "industry") || null;
    c.employees ??= employeesOf(get(r, "employees"));
    c.city ??= get(r, "city") || null;
    c.state ??= get(r, "state") || null;
    c.country ??= get(r, "country") || null;
    const note = get(r, "notes");
    if (note) c.notes.push(note);
    let first = get(r, "firstName");
    let last = get(r, "lastName");
    const full = get(r, "fullName");
    if (!first && full) {
      const parts = full.split(",")[0]!.trim().split(/\s+/);
      first = parts[0] ?? "";
      last = parts.slice(1).join(" ");
    }
    if (first || email) {
      const person: SheetPerson = { firstName: first || email.split("@")[0]!, lastName: last || null, title: get(r, "title") || null, email: email && email.includes("@") ? email.toLowerCase() : null, phone: get(r, "phone") || null, linkedin: get(r, "linkedin") || null, row: rowNo };
      const dup = c.people.find((p) => (person.email && p.email === person.email) || (`${p.firstName} ${p.lastName ?? ""}`.toLowerCase() === `${person.firstName} ${person.lastName ?? ""}`.toLowerCase()));
      if (!dup) c.people.push(person);
    }
    byDomain.set(domain, c);
  });
  return { companies: [...byDomain.values()], skipped };
}
