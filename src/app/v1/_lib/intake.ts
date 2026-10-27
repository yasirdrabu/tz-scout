import { ScoutError } from '@/platform/errors';

export const JSON_MAX_BYTES = 5 * 1024 * 1024;
export const BATCH_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
/** Multipart framing around a file. */
export const FORM_SLACK = 64 * 1024;

const tooLarge = () => new ScoutError({ slug: 'payload-too-large', status: 413, title: 'This request is over the size limit.' });
const invalid = (title: string, path?: string) =>
  new ScoutError({ slug: 'validation', status: 400, title, ...(path ? { errors: [{ path, message: title }] } : {}) });

/**
 * Reads the body once, counting bytes as they arrive. Content-Length is checked first; a body that passes
 * `max` is cancelled and refused (413) without reading the rest. Returns a request carrying the same
 * bytes, so hashing and parsing can both use it.
 */
export async function boundedRequest(req: Request, max: number): Promise<Request> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!req.body) return req;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const headers = new Headers(req.headers);
  headers.delete('content-length');
  return new Request(req.url, { method: req.method, headers, body: Buffer.concat(chunks) });
}

/** The parsed JSON body (the route has already bounded it). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return JSON.parse(await req.text());
  } catch {
    throw invalid('Send a JSON body.');
  }
}

export type Upload = { fileName: string; contentType: string; bytes: Uint8Array; fields: Record<string, string> };

/** One file in the `file` field plus the text fields named in `allowed`. Anything else is a 400. */
export async function readUpload(req: Request, max: number, allowed: string[] = []): Promise<Upload> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw invalid('Send a multipart form with a file.');
  }
  const fields: Record<string, string> = {};
  let file: File | undefined;
  for (const [name, value] of form) {
    if (name === 'file' && typeof value !== 'string' && !file) file = value;
    else if (typeof value === 'string' && allowed.includes(name)) fields[name] = value;
    else throw invalid(`Unknown field: ${name}.`, name);
  }
  if (!file) throw invalid('Send one file in the file field.', 'file');
  if (file.size > max) throw tooLarge();
  return {
    fileName: file.name || 'upload',
    contentType: file.type || 'application/octet-stream',
    bytes: new Uint8Array(await file.arrayBuffer()),
    fields,
  };
}

const PEOPLE_KEEP = new Set(['name', 'first_name', 'last_name', 'title', 'buying_role', 'buying_roles', 'notes', 'seniority']);
const WARM_INTRO_KEEP = new Set(['introducer_name', 'relationship', 'relationship_key', 'note']);

/** Entries keep only the keys on the list, so a contact stored under any other name (work_email, Email) is dropped too. */
function keepOnly(value: unknown, keep: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => keepOnly(v, keep));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => keep.has(k)));
  return value;
}

/**
 * TEN-E3-S3-AC1: without `people:read`, each entry under `people` keeps only name, first_name, last_name,
 * title, buying_role, buying_roles, notes and seniority, and `warm_intro` keeps only introducer_name,
 * relationship, relationship_key and note, at any depth (an allow-list, so off-contract keys in raw payloads
 * go too). A file row's raw form (`headers` with `rows`) keeps its headers and loses its rows
 * (`rows: []`, `rows_hidden: true`). A company's own `linkedin_url` stays.
 */
export function withoutContacts<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object' || v instanceof Date) return v;
    const o = v as Record<string, unknown>;
    const rawRows = Array.isArray(o.headers) && Array.isArray(o.rows);
    return Object.fromEntries(
      Object.entries(o).flatMap(([k, x]): [string, unknown][] => {
        if (rawRows && k === 'rows') return [[k, []], ['rows_hidden', true]];
        if (k === 'people') return [[k, keepOnly(x, PEOPLE_KEEP)]];
        if (k === 'warm_intro') return [[k, keepOnly(x, WARM_INTRO_KEEP)]];
        return [[k, walk(x)]];
      }),
    );
  };
  return walk(value) as T;
}

/** The AI suggester's reasons may quote cells from the file, so they are shown only with people:read. */
export function withoutReasons<T extends { reason?: string }>(mapping: T[]): Omit<T, 'reason'>[] {
  return mapping.map(({ reason: _reason, ...rest }) => rest);
}
