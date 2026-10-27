import { ScoutError } from '@/platform/errors';

export const JSON_MAX_BYTES = 5 * 1024 * 1024;
export const BATCH_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
/** Multipart framing around a file. */
const FORM_SLACK = 64 * 1024;

const tooLarge = () => new ScoutError({ slug: 'payload-too-large', status: 413, title: 'This request is over the size limit.' });
const invalid = (title: string, path?: string) =>
  new ScoutError({ slug: 'validation', status: 400, title, ...(path ? { errors: [{ path, message: title }] } : {}) });

function checkLength(req: Request, max: number): void {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
}

/** A copy of the request whose body has been read and measured: Content-Length first, then the real size. */
export async function limited(req: Request, max: number): Promise<Request> {
  checkLength(req, max);
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > max) throw tooLarge();
  const headers = new Headers(req.headers);
  headers.delete('content-length');
  return new Request(req.url, { method: req.method, headers, body: text });
}

/** The parsed JSON body, up to `max` bytes. */
export async function readJson(req: Request, max: number): Promise<unknown> {
  const text = await (await limited(req, max)).text();
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('Send a JSON body.');
  }
}

export type Upload = { fileName: string; contentType: string; bytes: Uint8Array; fields: Record<string, string> };

/** One file in the `file` field plus the text fields named in `allowed`. Anything else is a 400. */
export async function readUpload(req: Request, max: number, allowed: string[] = []): Promise<Upload> {
  checkLength(req, max + FORM_SLACK);
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

const CONTACT_KEYS = new Set(['email', 'phone', 'mobile_phone', 'linkedin_url']);
const CONTACT_HEADER = /e-?mail|phone|mobile|linkedin/i;

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !CONTACT_KEYS.has(k)).map(([k, v]) => [k, strip(v)]));
  }
  return value;
}

/** A file row's raw form is `{ headers, rows }`: blank the cells under contact headers. */
function blankColumns(value: { headers: unknown[]; rows: unknown }): unknown {
  const hidden = new Set(value.headers.flatMap((h, i) => (typeof h === 'string' && CONTACT_HEADER.test(h) ? [i] : [])));
  if (!Array.isArray(value.rows)) return value;
  return { ...value, rows: value.rows.map((r) => (Array.isArray(r) ? r.map((c, i) => (hidden.has(i) ? '' : c)) : r)) };
}

/**
 * TEN-E3-S3-AC1: without `people:read`, takes `email`, `phone`, `mobile_phone` and `linkedin_url` out of every
 * people entry at any depth (an arrival's raw payload and parsed body included), and blanks the contact
 * columns of a file row's raw form. Account fields (a company's own `linkedin_url`) stay.
 */
export function withoutContacts<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.headers) && 'rows' in o) return blankColumns(o as { headers: unknown[]; rows: unknown });
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, k === 'people' ? strip(x) : walk(x)]));
  };
  return walk(value) as T;
}
