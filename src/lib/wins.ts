// Win stats computed straight from closed-won deals (no AI): who we win, how big, how fast.

import type { WonDeal } from "@/integrations/hubspot";

export type WinStats = {
  deals: number;
  totalCents: number;
  medianCents: number | null;
  medianCycleDays: number | null;
  industries: { name: string; deals: number }[];
  sizes: { band: string; deals: number }[];
  titles: { title: string; deals: number }[];
};

const SIZE_BANDS: [number, string][] = [[50, "Under 50"], [200, "50 to 199"], [500, "200 to 499"], [1000, "500 to 999"], [2500, "1,000 to 2,499"], [Infinity, "2,500 and up"]];
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const tally = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);

/** Group job titles by function so "VP of Operations" and "Operations Director" count together. */
export function titleFunction(title: string): string {
  const t = title.toLowerCase();
  if (/\b(ceo|chief executive|president|owner|founder|managing director)\b/.test(t) && !/vice/.test(t)) return "CEO / President";
  if (/\b(coo|chief operating|operations|ops)\b/.test(t)) return "Operations";
  if (/\b(cio|cto|chief information|chief technology|it\b|information technology|technology|engineering|digital)\b/.test(t)) return "IT / Technology";
  if (/\b(cfo|chief financial|finance|controller|accounting)\b/.test(t)) return "Finance";
  if (/\b(ciso|security|compliance|risk)\b/.test(t)) return "Security / Risk";
  if (/\b(data|analytics)\b/.test(t)) return "Data";
  if (/\b(sales|revenue|marketing|growth|commercial)\b/.test(t)) return "Sales / Marketing";
  if (/\b(hr|people|human resources|talent)\b/.test(t)) return "HR";
  return "Other";
}

export function winStats(deals: WonDeal[]): WinStats {
  const amounts = deals.map((d) => d.amountCents).filter((x): x is number => x != null && x > 0);
  const cycles = deals
    .map((d) => (d.closedAt && d.createdAt ? Math.round((new Date(d.closedAt).getTime() - new Date(d.createdAt).getTime()) / 86400_000) : null))
    .filter((x): x is number => x != null && x >= 0);
  const sizes = deals.map((d) => d.company?.employees).filter((x): x is number => x != null && x > 0).map((n) => SIZE_BANDS.find(([max]) => n < max)![1]);
  return {
    deals: deals.length,
    totalCents: amounts.reduce((s, x) => s + x, 0),
    medianCents: median(amounts),
    medianCycleDays: median(cycles),
    industries: tally(deals.map((d) => d.company?.industry?.replace(/_/g, " ").toLowerCase()).filter((x): x is string => !!x)).map(([name, n]) => ({ name, deals: n })).slice(0, 8),
    sizes: tally(sizes).map(([band, n]) => ({ band, deals: n })),
    // Count each function once per deal.
    titles: tally(deals.flatMap((d) => [...new Set(d.buyerTitles.map(titleFunction))])).map(([title, n]) => ({ title, deals: n })).slice(0, 8),
  };
}
