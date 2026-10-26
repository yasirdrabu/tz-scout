import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, CardHeader, LinkButton, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { LEAD_FIELDS, groupRows, type Mapping } from "@/lib/leadSheet";
import { bestResearch } from "@/lib/research";
import { modeOf } from "@/integrations/mode";
import { TIER_LABEL, type Tier } from "@/lib/matching";
import type { ImportStats } from "@/server/leadImport";
import { addHeldAction, discardImportAction, runImportAction } from "../actions";

export const metadata = { title: "Import" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const tierLabel = (t: string | null) => (t && t in TIER_LABEL ? TIER_LABEL[t as Tier] : "Not scored yet");

export default async function ImportDetailPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  const imp = await ctx.db.leadImport.findUnique({ where: { id } });
  if (!imp) notFound();
  const canAct = ctx.can("buyers.act");
  const headers = imp.headers as string[];
  const rows = imp.rows as string[][];
  const mapping = (imp.mapping ?? {}) as Mapping;
  const buckets = await ctx.db.bucket.findMany({ orderBy: { sort: "asc" }, select: { id: true, name: true } });
  const bucket = buckets.find((b) => b.id === imp.bucketId) ?? null;
  const eyebrow = (
    <Link href={`/c/${slug}/buyers/import`} className="hover:text-ink">
      Import
    </Link>
  );

  if (imp.status !== "done") {
    // Preview what the suggested columns would produce, so a wrong guess is visible before anything is created.
    const preview = groupRows(rows, mapping);
    const canEnrich = modeOf("prospects") === "live";
    return (
      <>
        <PageHeader eyebrow={eyebrow} title={imp.name} description={`${imp.fileName} · ${rows.length.toLocaleString("en-US")} rows. Check which column is which, then run the import.`} />
        {canAct ? (
          <ActionForm action={runImportAction.bind(null, slug, imp.id)}>
            <Card className="mb-5">
              <CardHeader title="Columns" description="We guessed from the headers. Website or work email is required: it's how each row is tied to a company." />
              <div className="grid gap-x-6 gap-y-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
                {LEAD_FIELDS.map((f) => (
                  <label key={f.key} className="grid gap-1 text-sm">
                    <span className="text-xs font-medium text-ink-soft">{f.label}</span>
                    <select name={`map_${f.key}`} defaultValue={mapping[f.key] != null ? String(mapping[f.key]) : ""} className="input">
                      <option value="">Not in this file</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="grid gap-3 border-t border-line px-5 py-4 text-sm sm:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-xs font-medium text-ink-soft">Bucket</span>
                  <select name="bucketId" defaultValue={imp.bucketId ?? ""} className="input">
                    <option value="">No bucket</option>
                    {buckets.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                {canEnrich ? (
                  <label className="flex items-start gap-2 self-end">
                    <input type="checkbox" name="enrich" className="mt-0.5" />
                    <span>
                      Enrich new companies with Apollo
                      <span className="block text-xs text-ink-muted">Adds size, industry, hiring, news and more buyers. About one credit per company plus one per buyer found.</span>
                    </span>
                  </label>
                ) : (
                  <p className="self-end text-xs text-ink-muted">Apollo isn&apos;t connected, so new companies are scored on what the file gives us.</p>
                )}
              </div>
            </Card>

            <Notice tone={preview.companies.length ? "neutral" : "near"} className="mb-5" title={`With the suggested columns: ${plural(preview.companies.length, "company", "companies")}, ${plural(preview.companies.reduce((n, c) => n + c.people.length, 0), "person", "people")}, ${plural(preview.skipped.length, "row", "rows")} skipped`}>
              {preview.skipped.length > 0 && <span>Skipped rows have no website or work email (personal addresses like Gmail can&apos;t tell us the company). They&apos;re listed after the import.</span>}
            </Notice>

            <div className="mb-5 flex items-center gap-2">
              <SubmitButton pendingText="Importing, checking HubSpot and scoring...">Run the import</SubmitButton>
              <span className="text-xs text-ink-muted">Nothing is pushed to HubSpot. New accounts land in the Buyers queue.</span>
            </div>
          </ActionForm>
        ) : (
          <Notice className="mb-5">Waiting for someone who can import to check the columns.</Notice>
        )}

        <Card>
          <CardHeader title="First rows of the file" />
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  {headers.map((h, i) => (
                    <Th key={i} className="whitespace-nowrap">
                      {h}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((r, ri) => (
                  <tr key={ri}>
                    {headers.map((_, i) => (
                      <Td key={i} className="max-w-56 truncate text-xs text-ink-soft">
                        {r[i]}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
        {canAct && (
          <div className="mt-4">
            <ActionButton action={discardImportAction.bind(null, slug, imp.id)} variant="ghost" size="sm" confirm="Discard this file? Nothing was imported from it.">
              Discard this file
            </ActionButton>
          </div>
        )}
      </>
    );
  }

  const s = imp.stats as unknown as ImportStats;
  const accounts = await ctx.db.account.findMany({
    where: { importIds: { has: imp.id } },
    orderBy: [{ bestTotal: { sort: "desc", nulls: "last" } }, { name: "asc" }],
    take: 500,
    select: { id: true, name: true, domain: true, tier: true, batchId: true, importIds: true, research: true, bestOfferingId: true, _count: { select: { contacts: true } } },
  });
  const offers = new Map((await ctx.db.offering.findMany({ select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  const held = s.skipped.filter((r) => r.needsWebsite);
  const other = s.skipped.filter((r) => !r.needsWebsite);
  const research = imp.kind === "research";

  return (
    <>
      <PageHeader
        eyebrow={eyebrow}
        title={imp.name}
        description={`${research ? "Research sheet" : "Lead list"}${bucket ? ` · ${bucket.name}` : ""} · ${imp.fileName} · imported ${imp.updatedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}${imp.createdBy ? ` by ${imp.createdBy}` : ""}`}
        actions={
          <LinkButton href={`/c/${slug}/buyers?list=${imp.id}`} variant="primary">
            Work this list in Buyers
          </LinkButton>
        }
      />

      <div className={`mb-5 grid gap-3 ${research ? "sm:grid-cols-6" : "sm:grid-cols-5"}`}>
        <Tile n={s.companies} label="Companies in" />
        <Tile n={s.created} label="New to us" />
        <Tile n={s.alreadyInQueue} label="Already in the queue" />
        <Tile n={s.alreadySent} label="Already sent to a rep" />
        <Tile n={s.peopleAdded} label="People added" />
        {research && <Tile n={s.signalsAdded ?? 0} label="Signals added" />}
      </div>

      <div className="mb-5 space-y-2">
        {Object.keys(s.tiers).length > 0 && (
          <Notice title="Where they landed">
            {Object.entries(s.tiers)
              .map(([t, n]) => `${n} ${tierLabel(t === "unscored" ? null : t)}`)
              .join(" · ")}
            {research && <span className="block text-xs text-ink-muted">The researcher&apos;s tier is a floor: an A with a signal in the last six months is Act now, A older or B is Good fit, C is Watch.</span>}
          </Notice>
        )}
        {s.hubspot.error ? <Notice tone="near" title="Couldn't check HubSpot">{s.hubspot.error}</Notice> : s.hubspot.checked > 0 && <Notice title={`${s.hubspot.inCrm} of ${s.hubspot.checked} are already in HubSpot`}>The ownership rule applies when you push: open deals and customers stay with their owner.</Notice>}
        {s.enriched > 0 && <Notice title={`${s.enriched} new companies enriched with Apollo`} />}
        {s.enrichStopped && <Notice tone="near" title="Apollo enrichment stopped">{s.enrichStopped}</Notice>}
      </div>

      {held.length > 0 && (
        <Card className="mb-5">
          <CardHeader title={`${plural(held.length, "company needs", "companies need")} a website`} description="The sheet has no website for these, and the website is how we tie a company to HubSpot. Type the ones you know (example.com) and add them; leave the rest blank." />
          {canAct ? (
            <ActionForm action={addHeldAction.bind(null, slug, imp.id)} className="p-4">
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {held.map((r) => (
                  <label key={r.row} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate text-ink" title={r.company ?? r.preview}>
                      {r.company ?? r.preview}
                    </span>
                    <input name={`site_${r.row}`} placeholder="example.com" className="input h-8 w-48 shrink-0 py-0 text-sm" />
                  </label>
                ))}
              </div>
              <div className="mt-4">
                <SubmitButton pendingText="Adding, checking HubSpot and scoring...">Add these companies</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <ul className="px-4 py-3 text-sm text-ink-soft">
              {held.map((r) => (
                <li key={r.row}>{r.company ?? r.preview}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="mb-5">
        <CardHeader title="Companies from this file" description="Already-sent accounts stay in Sent with their rep; the file is tagged on them so you can see the overlap." />
        <Table>
          <thead>
            <tr>
              <Th>Company</Th>
              <Th>Where it landed</Th>
              {research && <Th>Research</Th>}
              <Th>Best offer</Th>
              <Th>Status</Th>
              <Th numeric>People</Th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr>
                <Td colSpan={research ? 6 : 5} className="text-ink-muted">
                  None yet{held.length ? ": add the websites above to bring them in." : "."}
                </Td>
              </tr>
            )}
            {accounts.map((a) => {
              const r = bestResearch(a.research);
              return (
                <tr key={a.id} className="hover:bg-sunken/50">
                  <Td>
                    <Link href={`/c/${slug}/buyers/${a.id}`} className="font-medium text-ink hover:text-accent">
                      {a.name}
                    </Link>
                    <div className="text-2xs text-ink-muted">{a.domain}</div>
                  </Td>
                  <Td className="text-ink-soft">{tierLabel(a.tier)}</Td>
                  {research && <Td className="tnum text-ink-soft">{r?.entry.tier ? `${r.entry.tier}${r.entry.score != null ? ` · ${r.entry.score}` : ""}` : "n/a"}</Td>}
                  <Td className="text-ink-soft">{a.bestOfferingId ? offers.get(a.bestOfferingId) : <span className="text-ink-muted">None approved in this bucket</span>}</Td>
                  <Td>{a.batchId ? <Badge tone="muted">Sent</Badge> : a.importIds[0] === imp.id ? <Badge tone="accent">New in queue</Badge> : <Badge>Already in queue</Badge>}</Td>
                  <Td numeric className="tnum">{a._count.contacts}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {other.length > 0 && (
        <Card>
          <CardHeader title={`${plural(other.length, "row", "rows")} skipped`} description="Fix these in the file and import it again if they matter." />
          <Table>
            <thead>
              <tr>
                <Th numeric>Row</Th>
                <Th>Why</Th>
                <Th>Row starts with</Th>
              </tr>
            </thead>
            <tbody>
              {other.slice(0, 200).map((r) => (
                <tr key={r.row}>
                  <Td numeric className="tnum">{r.row}</Td>
                  <Td className="text-ink-soft">{r.reason}</Td>
                  <Td className="max-w-96 truncate text-xs text-ink-muted">{r.preview}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function Tile({ n, label }: { n: number; label: string }) {
  return (
    <Card className="p-4">
      <div className="tnum text-2xl font-semibold text-ink">{n}</div>
      <div className="text-xs text-ink-muted">{label}</div>
    </Card>
  );
}
