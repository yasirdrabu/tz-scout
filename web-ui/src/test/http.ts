import { HttpResponse } from 'msw';

/** A problem+json answer as the API sends it. */
export function problem(status: number, title: string, opts: { detail?: string; slug?: string; ref?: string } = {}) {
  return HttpResponse.json(
    {
      type: `https://scout.taazaa.ai/problems/${opts.slug ?? 'error'}`,
      title,
      status,
      ...(opts.detail ? { detail: opts.detail } : {}),
      correlation_id: opts.ref ?? 'cor_test01',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/**
 * A handler path with a literal colon, as in `/api/v1/admin/tenants/t1:suspend`. MSW reads `:name` as a
 * path parameter, so `/t1:suspend` would also match `/t1:resume`; this matches the path exactly.
 */
export const exactly = (path: string) => new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** The fields of a multipart request the test fetch sent (src/test/setup.ts): text values, and a file's name. */
export async function multipartFields(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  const out: Record<string, string> = {};
  for (const part of text.split(/--scout-test-boundary(?:--)?\r\n/)) {
    const m = part.match(/^Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r\n]*\r\n)?\r\n([\s\S]*)\r\n$/);
    if (m) out[m[1]!] = m[2] ?? m[3]!;
  }
  return out;
}
