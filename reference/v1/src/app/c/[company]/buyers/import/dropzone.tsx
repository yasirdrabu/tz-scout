"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, cx } from "@/components/ui";
import { Spinner } from "@/components/client";
import type { ActionResult } from "@/server/action";
import type { ImportStats } from "@/server/leadImport";

type Result = { id: string; name: string; ran: boolean; kind: string; bucket: string | null; stats: ImportStats | null };
type Item = { key: string; file: string; state: "waiting" | "working" | "done" | "columns" | "error"; result?: Result; error?: string };

const ACCEPT = /\.(csv|tsv|txt|xlsx|md|markdown)$/i;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Drag files in (or pick them); each is read, filed and imported in turn, with a line per file. */
export function DropZone({ action, slug, buckets, canEnrich }: { action: (fd: FormData) => Promise<ActionResult>; slug: string; buckets: { id: string; name: string }[]; canEnrich: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bucketId, setBucketId] = useState("");
  const [enrich, setEnrich] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function run(files: File[]) {
    const list = files.filter((f) => ACCEPT.test(f.name));
    const rejected = files.filter((f) => !ACCEPT.test(f.name));
    const batch: Item[] = [
      ...list.map((f, i) => ({ key: `${Date.now()}-${i}`, file: f.name, state: "waiting" as const })),
      ...rejected.map((f, i) => ({ key: `${Date.now()}-x${i}`, file: f.name, state: "error" as const, error: "Not a CSV, Excel (.xlsx) or Markdown file." })),
    ];
    setItems((prev) => [...batch, ...prev]);
    if (!list.length) return;
    setBusy(true);
    for (const [i, f] of list.entries()) {
      const key = batch[i]!.key;
      const set = (patch: Partial<Item>) => setItems((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      set({ state: "working" });
      const fd = new FormData();
      fd.set("file", f);
      fd.set("bucketId", bucketId);
      if (enrich) fd.set("enrich", "on");
      try {
        const r = await action(fd);
        if (!r.ok) set({ state: "error", error: r.error });
        else {
          const res = r.data as Result;
          set({ state: res.ran ? "done" : "columns", result: res });
        }
      } catch (e) {
        set({ state: "error", error: e instanceof Error ? e.message : "Something went wrong." });
      }
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!busy) void run([...e.dataTransfer.files]);
        }}
        onClick={() => !busy && input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current?.click()}
        className={cx(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
          over ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-accent-line hover:bg-sunken/40",
          busy && "cursor-progress opacity-80",
        )}
      >
        <div className="text-sm font-medium text-ink">{busy ? "Importing..." : "Drop lead lists or research sheets here"}</div>
        <div className="mt-1 text-xs text-ink-muted">or click to choose files · CSV, Excel (.xlsx) or Markdown · several at once is fine</div>
        <input
          ref={input}
          type="file"
          multiple
          accept=".csv,.tsv,.txt,.xlsx,.md,.markdown,text/csv"
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void run(files);
          }}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-soft">
        <label className="flex items-center gap-2">
          <span>Bucket</span>
          <select value={bucketId} onChange={(e) => setBucketId(e.target.value)} className="input h-7 py-0 text-xs" disabled={busy}>
            <option value="">Work it out from the file</option>
            {buckets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        {canEnrich && (
          <label className="flex items-center gap-2" title="Adds size, industry, hiring, news and more buyers. About one Apollo credit per company plus one per buyer found.">
            <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} disabled={busy} />
            Enrich new companies with Apollo (uses credits)
          </label>
        )}
      </div>

      {items.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-md border border-line bg-surface">
          {items.map((it) => (
            <li key={it.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-ink">{it.result?.name ?? it.file}</div>
                <div className="mt-0.5 text-xs text-ink-muted">{line(it)}</div>
              </div>
              <div className="flex items-center gap-2">
                {it.state === "waiting" && <Badge tone="muted">Waiting</Badge>}
                {it.state === "working" && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                    <Spinner /> Importing, checking HubSpot, scoring
                  </span>
                )}
                {it.state === "error" && <Badge tone="bad">Didn&apos;t import</Badge>}
                {it.state === "columns" && it.result && (
                  <Link href={`/c/${slug}/buyers/import/${it.result.id}`} className="link text-xs">
                    Check the columns
                  </Link>
                )}
                {it.state === "done" && it.result && (
                  <>
                    {it.result.stats && it.result.stats.skipped.some((s) => s.needsWebsite) && <Badge tone="near">{it.result.stats.skipped.filter((s) => s.needsWebsite).length} need a website</Badge>}
                    <Link href={`/c/${slug}/buyers/import/${it.result.id}`} className="link text-xs">
                      See what came in
                    </Link>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function line(it: Item): string {
  if (it.state === "waiting") return it.file;
  if (it.state === "working") return it.file;
  if (it.state === "error") return it.error ?? "Didn't import.";
  const r = it.result!;
  const where = r.bucket ? `${r.bucket} · ` : "";
  if (it.state === "columns") return `${where}${it.file}: couldn't tell which column is the website or email. Check the columns to finish.`;
  const s = r.stats!;
  const act = s.tiers.act_now ?? 0;
  return [
    `${where}${r.kind === "research" ? "Research sheet" : "Lead list"}`,
    plural(s.companies, "company", "companies"),
    `${s.created} new`,
    s.alreadyInQueue + s.alreadySent ? `${s.alreadyInQueue + s.alreadySent} already here` : null,
    plural(s.peopleAdded, "person", "people") + " added",
    act ? `${act} act now` : null,
    s.skipped.length ? `${s.skipped.length} held` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
