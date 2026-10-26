// Last N complete weeks (Monday start, UTC) of show-up rates for both meeting types, with empty weeks filled in.

import type { ScopedDb } from "@/lib/db";
import { showUpByWeek } from "@/server/meetings";

const DAY = 86_400_000;

export function mondayUtc(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
}

export type ShowUpRow = { week: string; discovery: { booked: number; held: number; rate: number | null }; sales: { booked: number; held: number; rate: number | null } };

export async function lastCompleteWeeks(db: ScopedDb, weeks = 8, now = new Date()) {
  const to = mondayUtc(now);
  const from = new Date(to.getTime() - weeks * 7 * DAY);
  const [disc, sales] = await Promise.all([showUpByWeek(db, "DISCOVERY", from, to), showUpByWeek(db, "SALES", from, to)]);
  const empty = { booked: 0, held: 0, rate: null };
  const rows: ShowUpRow[] = [];
  for (let i = 0; i < weeks; i++) {
    const week = new Date(from.getTime() + i * 7 * DAY).toISOString().slice(0, 10);
    rows.push({ week, discovery: disc.find((w) => w.week === week) ?? empty, sales: sales.find((w) => w.week === week) ?? empty });
  }
  const total = (k: "discovery" | "sales") => {
    const booked = rows.reduce((s, r) => s + r[k].booked, 0);
    const held = rows.reduce((s, r) => s + r[k].held, 0);
    return { booked, held, rate: booked ? held / booked : null };
  };
  return { rows: rows.reverse(), total: { discovery: total("discovery"), sales: total("sales") } };
}
