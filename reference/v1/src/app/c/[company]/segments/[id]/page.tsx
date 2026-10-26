import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { getSettings } from "@/server/settings";
import { Badge, Bar, Card, CardHeader, KeyValue, LinkButton, Notice, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { FACTOR_BY_KEY, scoreSegment } from "@/lib/scoring";
import { compact, date, money, num } from "@/lib/format";
import { clearOverrideAction, overrideFactorAction, setSegmentStatusAction } from "../actions";
import { moveNeeds, ORIGIN_LABEL, SEGMENT_STATUS_LABEL, SEGMENT_STATUS_TONE, STATUS_MOVES } from "../labels";
import { BATCH_STATUS_LABEL, BATCH_STATUS_TONE, channelLabel, passCount } from "../../tests/labels";
import { FactorOverride } from "./factor-override";

const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

export default async function SegmentPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  const seg = await ctx.db.segment.findUnique({
    where: { id },
    include: {
      offering: { select: { id: true, name: true } },
      factors: true,
      batches: { orderBy: { createdAt: "desc" }, include: { statements: { select: { result: { select: { impressions: true, clicks: true, spendCents: true } } } } } },
    },
  });
  if (!seg) notFound();
  const settings = await getSettings(ctx.db);
  const b = scoreSegment(seg.factors, settings.weights);
  const byKey = new Map(seg.factors.map((f) => [f.factor, f]));
  const cur = ctx.company.currency;
  const canOverride = ctx.can("segment.override");
  const moves = STATUS_MOVES[seg.status].filter((m) => ctx.can(moveNeeds(seg.status, m.to)));
  const segId = seg.id;
  const activeCount = seg.status === "ACTIVE" ? null : await ctx.db.segment.count({ where: { offeringId: seg.offeringId, status: "ACTIVE" } });

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/segments?offering=${seg.offeringId}`} className="hover:text-ink">
            Segments · {seg.offering.name}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {seg.buyer}
            <Badge tone={SEGMENT_STATUS_TONE[seg.status]}>{SEGMENT_STATUS_LABEL[seg.status]}</Badge>
          </span>
        }
        description={seg.problem}
        actions={moves.map((m) => (
          <ActionButton key={m.to} action={setSegmentStatusAction.bind(null, slug, seg.id, m.to)} variant={m.to === "ACTIVE" ? "primary" : "secondary"} pendingText="Saving...">
            {m.label}
          </ActionButton>
        ))}
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          <Card className="grid grid-cols-3 gap-4 px-4 py-4">
            <Stat label="Total score" value={Math.round(b.total)} sub="out of 100" size="lg" />
            <Stat label="Market" value={`${Math.round(b.market)} of ${Math.round(b.marketMax)}`} sub="Pain, urgency, audience, budget, competition" />
            <Stat label="Fit" value={`${Math.round(b.fit)} of ${Math.round(b.fitMax)}`} sub="Proof, delivery, deal size, committee, cycle" />
          </Card>

          <Card>
            <CardHeader title="Factor breakdown" description="Each factor is rated 0 to 10 and earns that share of its weight. Inverted factors count as 10 minus the rating." />
            <Table>
              <thead>
                <tr>
                  <Th>Factor</Th>
                  <Th numeric>Rating</Th>
                  <Th numeric>Weight</Th>
                  <Th className="w-[220px]">Points</Th>
                  {canOverride && <Th />}
                </tr>
              </thead>
              <tbody>
                {halfRows("market")}
                {halfRows("fit")}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader
              title="Message tests"
              description={seg.status === "ACTIVE" ? "Statements tested on this buyer, newest batch first." : undefined}
              actions={seg.status === "ACTIVE" && ctx.can("batch.edit") && <LinkButton href={`/c/${slug}/tests/new?segment=${seg.id}`} variant="primary" size="sm">New test batch</LinkButton>}
            />
            {seg.status !== "ACTIVE" && (
              <div className="p-4">
                <Notice>
                  Make this segment active before writing message tests. Up to {settings.maxActiveSegments} segments can be active per offering
                  {activeCount != null && `, and ${activeCount} ${activeCount === 1 ? "is" : "are"} active now`}.
                </Notice>
              </div>
            )}
            {seg.batches.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Batch</Th>
                    <Th>Status</Th>
                    <Th>Channel</Th>
                    <Th numeric>Statements</Th>
                    <Th numeric>Passing</Th>
                    <Th numeric>Launched</Th>
                  </tr>
                </thead>
                <tbody>
                  {seg.batches.map((batch) => (
                    <tr key={batch.id} className="hover:bg-sunken/50">
                      <Td>
                        <Link href={`/c/${slug}/tests/${batch.id}`} className="font-medium hover:text-accent">
                          {batch.name}
                        </Link>
                      </Td>
                      <Td>
                        <Badge tone={BATCH_STATUS_TONE[batch.status]}>{BATCH_STATUS_LABEL[batch.status]}</Badge>
                      </Td>
                      <Td className="text-ink-soft">{channelLabel(batch.channel)}</Td>
                      <Td numeric>{batch.statements.length}</Td>
                      <Td numeric>{batch.status === "RUNNING" || batch.status === "COMPLETE" ? passCount(batch) : "n/a"}</Td>
                      <Td numeric className="text-ink-soft">{batch.launchedAt ? date(batch.launchedAt) : "Not yet"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              seg.status === "ACTIVE" && <p className="px-4 py-6 text-center text-sm text-ink-muted">No test batches yet.</p>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Data" description="From the ad and search adapters and our case studies." />
            <div className="p-4">
              <KeyValue
                items={[
                  ["LinkedIn audience", <span key="a" className="tnum">{compact(seg.audienceSize)}</span>],
                  ["Monthly searches", <span key="s" className="tnum">{num(seg.searchVolume)}</span>],
                  ["Average cost per click", <span key="c" className="tnum">{money(seg.cpcCents, cur, { precise: true })}</span>],
                  ["Matching case studies", <span key="m" className="tnum">{seg.caseStudyCount}</span>],
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="About" />
            <div className="p-4">
              <KeyValue
                items={[
                  [
                    "Offering",
                    <Link key="o" className="link" href={`/c/${slug}/offerings/${seg.offering.id}`}>
                      {seg.offering.name}
                    </Link>,
                  ],
                  ["Industry", seg.industry ?? "n/a"],
                  ["Origin", ORIGIN_LABEL[seg.origin]],
                  ["Added", date(seg.createdAt, { month: "short", day: "numeric", year: "numeric" })],
                ]}
              />
            </div>
          </Card>
        </div>
      </div>
    </>
  );

  function halfRows(half: "market" | "fit") {
    const rows = b.factors.filter((f) => f.half === half);
    return (
      <>
        <tr className="bg-sunken/40">
          <Td className="text-xs font-semibold text-ink">{half === "market" ? "Market" : "Fit"}</Td>
          <Td />
          <Td numeric className="text-xs text-ink-muted">{one(half === "market" ? b.marketMax : b.fitMax)}</Td>
          <Td className="tnum text-xs font-semibold">
            {one(half === "market" ? b.market : b.fit)} of {one(half === "market" ? b.marketMax : b.fitMax)}
          </Td>
          {canOverride && <Td />}
        </tr>
        {rows.map((r) => {
          const def = FACTOR_BY_KEY[r.key];
          const f = byKey.get(r.key);
          return (
            <tr key={r.key}>
              <Td className="max-w-md">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium" title={def.help}>
                    {r.label}
                  </span>
                  {def.inverted && <span className="text-2xs text-ink-faint">inverted</span>}
                  {f?.overrideValue != null && (
                    <Badge tone="accent" title={f.overrideNote ?? undefined}>
                      Overridden by {f.overriddenBy ?? "a teammate"}
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-ink-muted">{f ? f.reason : "Not scored yet."}</div>
                {f?.overrideValue != null && (
                  <div className="mt-0.5 text-xs text-ink-soft">
                    Proposed {one(f.value)}, changed to {one(f.overrideValue)}
                    {f.overriddenAt && ` on ${date(f.overriddenAt)}`}.{f.overrideNote && ` Note: ${f.overrideNote}`}
                  </div>
                )}
              </Td>
              <Td numeric>
                <span className={cx(r.overridden && "font-semibold text-accent")}>{f ? one(r.raw) : "n/a"}</span>
                {def.inverted && f && <div className="text-2xs text-ink-muted">counts as {one(r.oriented)}</div>}
              </Td>
              <Td numeric className="text-ink-soft">{one(r.weight)}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <Bar value={r.points} max={r.weight} className="flex-1" />
                  <span className="tnum w-20 whitespace-nowrap text-right text-xs text-ink-soft">
                    {one(r.points)} of {one(r.weight)}
                  </span>
                </div>
              </Td>
              {canOverride && (
                <Td className="whitespace-nowrap">
                  {f && (
                    <FactorOverride
                      label={r.label}
                      proposed={f.value}
                      current={f.overrideValue}
                      note={f.overrideNote}
                      inverted={def.inverted}
                      saveAction={overrideFactorAction.bind(null, slug, segId, r.key)}
                      clearAction={clearOverrideAction.bind(null, slug, segId, r.key)}
                    />
                  )}
                </Td>
              )}
            </tr>
          );
        })}
      </>
    );
  }
}
