// Always 200 while the process is up.
export const GET = () => Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
