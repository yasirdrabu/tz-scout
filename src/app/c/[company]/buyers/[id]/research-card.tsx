import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui";
import type { ResearchEntry } from "@/lib/research";

/** What the ABM research found, per bucket: the reason, the opening, the proposed first step and the caveats. */
export function ResearchCard({ slug, research, bucketName }: { slug: string; research: Record<string, ResearchEntry>; bucketName: Map<string, string> }) {
  const entries = Object.entries(research).sort(([, x], [, y]) => (y.score ?? 0) - (x.score ?? 0));
  if (!entries.length) return null;
  return (
    <Card>
      <CardHeader title="Research" description="From the imported ABM research sheets. Public sources, checked by the researcher; problems and value are hypotheses to test on the first call." />
      <div className="divide-y divide-line">
        {entries.map(([slugKey, r]) => (
          <div key={slugKey} className="space-y-2 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{bucketName.get(slugKey) ?? "Research"}</span>
              {r.tier && <Badge tone={r.tier === "A" ? "accent" : r.tier === "B" ? "good" : "muted"}>Tier {r.tier}</Badge>}
              {r.score != null && <span className="tnum text-xs text-ink-muted">score {r.score} of 100</span>}
              {r.intent != null && <span className="tnum text-xs text-ink-muted">· intent {r.intent}</span>}
              {r.listId && (
                <Link href={`/c/${slug}/buyers/import/${r.listId}`} className="link text-xs">
                  {r.reportDate ? `sheet of ${r.reportDate}` : "source sheet"}
                </Link>
              )}
            </div>
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[9rem_1fr]">
              {r.signal && (
                <Row label="Why now">
                  {r.signal.url ? (
                    <a href={r.signal.url} target="_blank" rel="noreferrer" className="link">
                      {r.signal.title}
                    </a>
                  ) : (
                    r.signal.title
                  )}{" "}
                  <span className="tnum text-xs text-ink-muted">({r.signal.date})</span>
                </Row>
              )}
              {r.hook && <Row label="Suggested opening">&ldquo;{r.hook}&rdquo;</Row>}
              {r.problem && <Row label="Likely problem">{r.problem}</Row>}
              {r.useCase && <Row label="What we'd propose">{r.useCase}</Row>}
              {r.pilot && (
                <Row label="Paid first step">
                  {r.pilot}
                  {r.price && !r.pilot.includes("$") ? <span className="text-ink-muted"> ({r.price})</span> : null}
                </Row>
              )}
              {r.roi && <Row label="Value case">{r.roi}</Row>}
              {r.approach && <Row label="Approach">{r.approach}</Row>}
              {r.nextAction && <Row label="Next step">{r.nextAction}</Row>}
              {r.incumbent && <Row label="Already working with">{r.incumbent}</Row>}
              {r.caveats && (
                <Row label="Watch out">
                  <span className="text-near">{r.caveats}</span>
                </Row>
              )}
              {r.scale && <Row label="Size">{r.scale}</Row>}
              {r.tech && <Row label="Tech seen">{r.tech}</Row>}
              {r.contactRoute && <Row label="Public contact">{r.contactRoute}</Row>}
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-ink-muted sm:pt-0.5">{label}</dt>
      <dd className="text-ink-soft">{children}</dd>
    </>
  );
}
