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
