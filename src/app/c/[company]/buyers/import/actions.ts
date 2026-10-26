"use server";

import { redirect } from "next/navigation";
import { authorize } from "@/server/context";
import { act, bool, str, type ActionResult } from "@/server/action";
import { addHeldRows, createImport, mappingFromForm, quickImport, runImport } from "@/server/leadImport";

const path = (slug: string) => `/c/${slug}/buyers`;

/** One dropped file: read it and, when the columns are clear, import it straight away. */
export async function dropImportAction(slug: string, fd: FormData): Promise<ActionResult> {
  const file = fd.get("file");
  return act(
    async () => {
      if (!(file instanceof File) || file.size === 0) throw new Error("That file is empty.");
      const ctx = await authorize(slug, "buyers.act");
      return quickImport(ctx, { fileName: file.name, bytes: await file.arrayBuffer(), bucketId: str(fd, "bucketId") || null, enrich: bool(fd, "enrich") });
    },
    { revalidate: path(slug) },
  );
}

export async function uploadListAction(slug: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const file = fd.get("file");
  let id = "";
  const r = await act(async () => {
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV, Excel or Markdown file.");
    const ctx = await authorize(slug, "buyers.act");
    id = await createImport(ctx, { name: str(fd, "name"), fileName: file.name, bytes: await file.arrayBuffer(), bucketId: str(fd, "bucketId") || null });
  });
  if (r.ok) redirect(`/c/${slug}/buyers/import/${id}`);
  return r;
}

export async function runImportAction(slug: string, importId: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      if (fd.has("bucketId")) await ctx.db.leadImport.update({ where: { id: importId }, data: { bucketId: str(fd, "bucketId") || null } });
      await runImport(ctx, importId, { mapping: mappingFromForm(fd), enrich: bool(fd, "enrich") });
    },
    { revalidate: path(slug) },
  );
}

/** Companies held for a missing website: one input per row, named site_<row>. */
export async function addHeldAction(slug: string, importId: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let added = 0;
  const r = await act(
    async () => {
      const ctx = await authorize(slug, "buyers.act");
      const fixes = [...fd.entries()].filter(([k, v]) => k.startsWith("site_") && typeof v === "string" && v.trim()).map(([k, v]) => ({ row: Number(k.slice(5)), website: String(v) }));
      added = (await addHeldRows(ctx, importId, fixes)).added;
    },
    { revalidate: path(slug) },
  );
  return r.ok ? { ...r, message: `Added ${added} ${added === 1 ? "company" : "companies"}.` } : r;
}

export async function discardImportAction(slug: string, importId: string, _prev: ActionResult | null, _fd: FormData): Promise<ActionResult> {
  const r = await act(async () => {
    const ctx = await authorize(slug, "buyers.act");
    await ctx.db.leadImport.deleteMany({ where: { id: importId, status: "mapping" } });
  });
  if (r.ok) redirect(`/c/${slug}/buyers/import`);
  return r;
}
