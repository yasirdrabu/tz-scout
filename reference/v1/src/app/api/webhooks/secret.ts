// Shared checks for inbound webhooks: the shared secret header and the company lookup.

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { unscopedDb } from "@/lib/db";

/** Constant-time compare of the x-webhook-secret header with WEBHOOK_SECRET. Hashing first keeps lengths equal. */
export function secretOk(req: Request): boolean {
  const expected = process.env.WEBHOOK_SECRET;
  const given = req.headers.get("x-webhook-secret");
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export const unauthorized = () => NextResponse.json({ error: "Missing or wrong webhook secret." }, { status: 401 });

/** Company lookup by slug is the one cross-company read a webhook needs; everything after uses scopedDb. */
export async function companyBySlug(slug: string) {
  return unscopedDb.company.findUnique({ where: { slug }, select: { id: true, slug: true, name: true } });
}

export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false };
  }
}
