// Server action plumbing: every action returns an ActionResult instead of throwing, so forms can
// show plain-language errors inline.

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

export type ActionResult = { ok: true; message?: string; id?: string; data?: unknown } | { ok: false; error: string };
export type FormAction = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export async function act(fn: () => Promise<unknown>, opts: { revalidate?: string | string[]; message?: string } = {}): Promise<ActionResult> {
  try {
    const out = await fn();
    for (const p of [opts.revalidate ?? []].flat()) revalidatePath(p, "layout");
    return { ok: true, message: opts.message, id: typeof out === "string" ? out : undefined, data: typeof out === "string" ? undefined : out };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e; // redirect / notFound
    if (e instanceof ZodError) {
      const i = e.issues[0];
      return { ok: false, error: i ? `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` : "Check the form and try again." };
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/Record to update not found|No .* found|Expected a record/i.test(msg)) return { ok: false, error: "That item no longer exists. Refresh the page." };
    console.error("[action]", e);
    return { ok: false, error: msg.length < 240 ? msg : "Something went wrong. Try again." };
  }
}

// ---------- FormData helpers ----------

export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
export const optStr = (fd: FormData, k: string) => str(fd, k) || null;
export const num = (fd: FormData, k: string): number | null => {
  const s = str(fd, k).replace(/[$,%\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** Dollars typed by a person to integer cents. */
export const cents = (fd: FormData, k: string): number | null => {
  const n = num(fd, k);
  return n == null ? null : Math.round(n * 100);
};
/** Percent typed by a person (5 or 5%) to a decimal rate (0.05). */
export const rate = (fd: FormData, k: string): number | null => {
  const n = num(fd, k);
  return n == null ? null : n / 100;
};
/** Comma or newline separated list. */
export const list = (fd: FormData, k: string) =>
  str(fd, k)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
export const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
