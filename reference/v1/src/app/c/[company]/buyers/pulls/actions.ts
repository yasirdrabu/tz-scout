"use server";

import { authorize } from "@/server/context";
import { act, list, num, optStr, str, type ActionResult } from "@/server/action";
import { clearSampleAccounts, deleteSearch, queueSearch, saveSearch, SearchInput } from "@/server/buyers";

const path = (slug: string) => `/c/${slug}/buyers`;

/** A whole, non-negative number typed by a person, or null when empty. */
function whole(fd: FormData, key: string, label: string): number | null {
  const n = num(fd, key);
  if (n == null) return null;
  if (n < 0 || !Number.isInteger(n)) throw new Error(`${label} must be a whole number of zero or more.`);
  return n;
}

/** Revenue typed in $ millions, to integer cents. */
function millions(fd: FormData, key: string, label: string): number | null {
  const n = num(fd, key);
  if (n == null) return null;
  if (n < 0) throw new Error(`${label} can't be negative.`);
  return Math.round(n * 100_000_000);
}

function parsePull(fd: FormData) {
  const name = str(fd, "name");
  if (name.length < 2) throw new Error("Give the pull a name.");
  const employeeMin = whole(fd, "employeeMin", "Employees from");
  const employeeMax = whole(fd, "employeeMax", "Employees to");
  if (employeeMin != null && employeeMax != null && employeeMin > employeeMax) throw new Error("Employees from must be less than employees to.");
  const revenueMinCents = millions(fd, "revenueMinM", "Revenue from");
  const revenueMaxCents = millions(fd, "revenueMaxM", "Revenue to");
  if (revenueMinCents != null && revenueMaxCents != null && revenueMinCents > revenueMaxCents) throw new Error("Revenue from must be less than revenue to.");
  const maxCompanies = num(fd, "maxCompanies") ?? 25;
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > 200) throw new Error("Most companies per pull must be a whole number from 1 to 200.");
  return SearchInput.parse({
    name,
    offeringId: optStr(fd, "offeringId"),
    segmentId: optStr(fd, "segmentId"),
    filters: {
      industries: list(fd, "industries"),
      employeeMin,
      employeeMax,
      revenueMinCents,
      revenueMaxCents,
      locations: list(fd, "locations"),
      keywords: list(fd, "keywords"),
      hiringTitles: list(fd, "hiringTitles"),
      technologies: list(fd, "technologies"),
      titles: list(fd, "titles"),
      excludeDomains: list(fd, "excludeDomains").map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")),
    },
    maxCompanies,
    schedule: str(fd, "schedule") || "off",
  });
}

export async function savePullAction(slug: string, id: string | null, _prev: ActionResult | null, fd: FormData) {
  const run = fd.get("intent") === "run";
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.pull");
      const input = parsePull(fd);
      if (input.segmentId) {
        // A segment only sticks when it belongs to the chosen offering.
        const seg = await ctx.db.segment.findUnique({ where: { id: input.segmentId }, select: { offeringId: true } });
        if (!seg || seg.offeringId !== input.offeringId) input.segmentId = null;
      }
      const searchId = await saveSearch(ctx, id, input);
      if (run) await queueSearch(ctx, searchId);
      return searchId;
    },
    { revalidate: path(slug), message: run ? "Saved. The pull is running." : "Saved." },
  );
}

export async function runPullAction(slug: string, id: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.pull");
      await queueSearch(ctx, id);
    },
    { revalidate: path(slug) },
  );
}

export async function deletePullAction(slug: string, id: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.pull");
      await deleteSearch(ctx, id);
    },
    { revalidate: path(slug) },
  );
}

export async function clearSampleAction(slug: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.pull");
      await clearSampleAccounts(ctx);
    },
    { revalidate: path(slug), message: "Sample companies removed." },
  );
}
