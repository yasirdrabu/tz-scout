import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { Badge, Bar, Card, CardHeader, Notice, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { ActionButton, ActionForm, AutoRefresh, SubmitButton } from "@/components/client";
import { verdict } from "@/lib/verdict";
import { dateTime, money, num, pct } from "@/lib/format";
import { approveBatchAction, decideStatementAction, launchBatchAction, updateBatchSettingsAction } from "../actions";
import { BatchFields } from "../batch-fields";
import {
  BATCH_STATUS_LABEL,
  BATCH_STATUS_TONE,
  channelLabel,
  DECISION_BUTTON,
  DECISION_LABEL,
  DECISION_TONE,
  KIND_LABEL,
  missLabel,
  ruleText,
  VERDICT_LABEL,
  VERDICT_TONE,
  verdictReason,
  wordCount,
  type DecisionKey,
} from "../labels";
import { StatementEditor } from "./statement-editor";

/** Which decisions to offer for a statement, given the decision already made. */
function decisionsFor(current: string, hasFollowUp: boolean): DecisionKey[] {
  if (current === "PENDING") return ["KEEP", "DROP", "REWRITE", "RETEST"];
  if (hasFollowUp) return [];
  if (current === "KEEP") return ["DROP"];
  if (current === "DROP") return ["KEEP"];
  return [];
}

export default async function BatchPage({ params }: { params: Promise<{ company: string; id: string }> }) {
  const { company: slug, id } = await params;
  const ctx = await getCompanyContext(slug);
  const batch = await ctx.db.batch.findUnique({
    where: { id },
    include: {
      segment: { select: { id: true, buyer: true, offering: { select: { id: true, name: true } } } },
      statements: { orderBy: { createdAt: "asc" }, include: { result: true } },
    },
  });
  if (!batch) notFound();
  const cur = ctx.company.currency;
  const ids = batch.statements.map((s) => s.id);
  const followUps = await ctx.db.statement.findMany({ where: { rewriteOfId: { in: ids } }, select: { rewriteOfId: true, batch: { select: { id: true, name: true } } } });
  const followUpOf = new Map(followUps.map((f) => [f.rewriteOfId!, f.batch]));
  const originIds = batch.statements.map((s) => s.rewriteOfId).filter((x): x is string => !!x);
  const origins = originIds.length ? await ctx.db.statement.findMany({ where: { id: { in: originIds } }, select: { id: true, text: true, batch: { select: { name: true } } } }) : [];
  const originOf = new Map(origins.map((o) => [o.id, o]));

  const isDraft = batch.status === "DRAFT";
  const hasResults = batch.status === "RUNNING" || batch.status === "COMPLETE";
  const canEdit = ctx.can("batch.edit");
  const problems = batch.statements.filter((s) => s.kind === "PROBLEM").length;
  const outcomes = batch.statements.length - problems;
  const rows = batch.statements.map((s) => ({ ...s, v: verdict(s.result, batch) }));
  const passing = rows.filter((r) => r.v.status === "pass").length;
  const spent = rows.reduce((t, r) => t + (r.result?.spendCents ?? 0), 0);
  const impressions = rows.reduce((t, r) => t + (r.result?.impressions ?? 0), 0);
  const clicks = rows.reduce((t, r) => t + (r.result?.clicks ?? 0), 0);
  const followUpBatches = [...new Map(followUps.map((f) => [f.batch.id, f.batch])).values()].filter((b) => b.id !== batch.id);

  return (
    <>
      <AutoRefresh seconds={4} active={batch.status === "RUNNING"} />
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/tests`} className="hover:text-ink">
            Message tests
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {batch.name}
            <Badge tone={BATCH_STATUS_TONE[batch.status]}>{BATCH_STATUS_LABEL[batch.status]}</Badge>
          </span>
        }
        description={
          <>
            <Link className="link" href={`/c/${slug}/segments/${batch.segment.id}`}>
              {batch.segment.buyer}
            </Link>{" "}
            · {batch.segment.offering.name}
          </>
        }
        actions={
          <>
            {isDraft && ctx.can("batch.approve") && (
              <ActionButton
                action={approveBatchAction.bind(null, slug, batch.id)}
                variant="primary"
                pendingText="Approving..."
                confirm={`Approve a ${money(batch.budgetCents, cur)} budget for ${batch.statements.length} statements? The batch is locked after approval.`}
              >
                Approve budget
              </ActionButton>
            )}
            {batch.status === "APPROVED" && ctx.can("batch.launch") && (
              <ActionButton action={launchBatchAction.bind(null, slug, batch.id)} variant="primary" pendingText="Launching..." confirm={`Launch ${batch.statements.length} ad sets on ${channelLabel(batch.channel)}?`}>
                Launch on {channelLabel(batch.channel)}
              </ActionButton>
            )}
          </>
        }
      />

      {isDraft && !ctx.can("batch.approve") && (
        <Notice tone="near" className="mb-4" title="Waiting for budget approval">
          An owner approves the budget before this batch can launch. Edit the statements until they read right.
        </Notice>
      )}
      {batch.status === "APPROVED" && (
        <Notice tone="accent" className="mb-4" title="Approved and locked">
          The budget is approved. Statements and settings can no longer change. {ctx.can("batch.launch") ? "Launch when ready." : "An owner or operator launches it."}
        </Notice>
      )}
      {followUpBatches.length > 0 && (
        <Notice className="mb-4" title="Follow-up batch">
          Rewrites and retests from this batch are collected in{" "}
          {followUpBatches.map((b, i) => (
            <span key={b.id}>
              {i > 0 && ", "}
              <Link className="link" href={`/c/${slug}/tests/${b.id}`}>
                {b.name}
              </Link>
            </span>
          ))}
          .
        </Notice>
      )}

      <Card className="mb-5 grid grid-cols-2 gap-4 px-4 py-4 md:grid-cols-5">
        <Stat label="Budget" value={money(batch.budgetCents, cur)} sub={`${money(Math.round(batch.budgetCents / Math.max(1, batch.statements.length)), cur)} per statement`} />
        <Stat label="Duration" value={`${num(batch.durationHours)} hours`} sub={channelLabel(batch.channel)} />
        <Stat label="Statements" value={batch.statements.length} sub={`${problems} problems, ${outcomes} outcomes`} />
        <Stat label="Targets" value={pct(batch.targetCtr)} sub={`clickthrough, ${money(batch.targetCpcCents, cur, { precise: true })} per click`} />
        <Stat label="Passing" value={hasResults ? `${passing} of ${rows.length}` : "n/a"} sub={hasResults ? `${num(impressions)} impressions, ${num(clicks)} clicks` : "After launch"} tone={hasResults && passing > 0 ? "good" : undefined} />
      </Card>
      <p className="mb-5 text-xs text-ink-muted">{ruleText(batch, cur)}</p>

      {isDraft && (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Statements"
              description={`${problems} problems and ${outcomes} outcomes. Buyer's words, under 25 words each, no product names. Aim for an even split.`}
            />
            <StatementEditor
              slug={slug}
              batchId={batch.id}
              canEdit={canEdit}
              rows={batch.statements.map((s) => {
                const o = s.rewriteOfId ? originOf.get(s.rewriteOfId) : undefined;
                return { id: s.id, text: s.text, kind: s.kind, rewriteOf: o ? `${o.batch.name}: "${o.text}"` : null };
              })}
            />
          </Card>
          <Card>
            <CardHeader title="Batch settings" description="Locked once the budget is approved." />
            <ActionForm action={updateBatchSettingsAction.bind(null, slug, batch.id)} className="p-4">
              <BatchFields values={batch} disabled={!canEdit} showName />
              {canEdit && (
                <div className="mt-4">
                  <SubmitButton variant="secondary" pendingText="Saving...">
                    Save settings
                  </SubmitButton>
                </div>
              )}
            </ActionForm>
          </Card>
        </div>
      )}

      {batch.status === "APPROVED" && (
        <Card>
          <CardHeader title="Statements" description={`${problems} problems and ${outcomes} outcomes.`} />
          <Table>
            <thead>
              <tr>
                <Th>Kind</Th>
                <Th>Statement</Th>
                <Th numeric>Words</Th>
              </tr>
            </thead>
            <tbody>
              {batch.statements.map((s) => (
                <tr key={s.id}>
                  <Td className="whitespace-nowrap text-ink-soft">{KIND_LABEL[s.kind]}</Td>
                  <Td>{s.text}</Td>
                  <Td numeric className="text-ink-muted">{wordCount(s.text)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {hasResults && (
        <>
          {batch.status === "RUNNING" && (
            <Card className="mb-5 px-4 py-3">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">Running on {channelLabel(batch.channel)}</span>
                <span className="tnum text-xs text-ink-muted">
                  {money(spent, cur)} of {money(batch.budgetCents, cur)} spent · {rows.filter((r) => r.result).length} of {rows.length} ad sets reporting
                </span>
              </div>
              <Bar value={spent} max={batch.budgetCents} />
              <div className="mt-1.5 text-2xs text-ink-muted">
                Launched {dateTime(batch.launchedAt)}
                {batch.endsAt && `, scheduled to end ${dateTime(batch.endsAt)}`}. Results refresh every few seconds.
              </div>
            </Card>
          )}
          <Card>
            <CardHeader
              title="Results"
              description={batch.status === "COMPLETE" ? `Finished ${dateTime(batch.completedAt)}. Keep the winners for the library, drop the rest, or send them back for a rewrite or retest.` : "Numbers fill in as the ads run. You can decide early, but verdicts firm up after the minimum impressions."}
            />
            <Table>
              <thead>
                <tr>
                  <Th>Kind</Th>
                  <Th>Statement</Th>
                  <Th numeric>Impressions</Th>
                  <Th numeric>Clicks</Th>
                  <Th numeric>Clickthrough rate</Th>
                  <Th numeric>Cost per click</Th>
                  <Th numeric>Spend</Th>
                  <Th>Verdict</Th>
                  <Th>Decision</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const fu = followUpOf.get(s.id);
                  const options = s.result && canEdit ? decisionsFor(s.decision, !!fu) : [];
                  const reason = verdictReason(s.v, batch, s.result?.impressions ?? null, cur);
                  const miss = missLabel(s.v);
                  return (
                    <tr key={s.id} className={cx(s.decision === "DROP" && "text-ink-muted")}>
                      <Td className="whitespace-nowrap text-ink-soft">{KIND_LABEL[s.kind]}</Td>
                      <Td className="min-w-[260px] max-w-md">{s.text}</Td>
                      <Td numeric>{s.result ? num(s.result.impressions) : ""}</Td>
                      <Td numeric>{s.result ? num(s.result.clicks) : ""}</Td>
                      <Td numeric className={cx(s.v.ctrPass === true && "text-good", s.v.ctrPass === false && "text-bad")}>
                        {s.result ? pct(s.v.ctr, 2) : ""}
                      </Td>
                      <Td numeric className={cx(s.v.cpcPass === true && "text-good", s.v.cpcPass === false && "text-bad")}>
                        {s.result ? money(s.v.cpcCents, cur, { precise: true }) : ""}
                      </Td>
                      <Td numeric>{s.result ? money(s.result.spendCents, cur, { precise: true }) : ""}</Td>
                      <Td className="whitespace-nowrap">
                        <Badge tone={VERDICT_TONE[s.v.status]} title={reason}>
                          {VERDICT_LABEL[s.v.status]}
                        </Badge>
                        <div className="mt-0.5 max-w-[160px] whitespace-normal text-2xs text-ink-muted" title={reason}>
                          {miss ?? (s.v.status === "not_enough_data" ? (s.result ? `${num(s.result.impressions)} of ${num(batch.minImpressions)} impressions` : "Waiting for results") : "Both targets met")}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {s.decision !== "PENDING" && <Badge tone={DECISION_TONE[s.decision]}>{DECISION_LABEL[s.decision]}</Badge>}
                        {fu && (
                          <div className="mt-0.5 text-2xs">
                            <Link className="link" href={`/c/${slug}/tests/${fu.id}`}>
                              In {fu.name}
                            </Link>
                          </div>
                        )}
                        {options.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {options.map((d) => (
                              <ActionButton
                                key={d}
                                action={decideStatementAction.bind(null, slug, s.id, d)}
                                size="sm"
                                variant={d === "KEEP" && s.v.status === "pass" ? "secondary" : "ghost"}
                                pendingText={d === "REWRITE" ? "Rewriting..." : "Saving..."}
                                title={d === "REWRITE" ? "Claude rewrites it using this segment's winners and adds it to the follow-up draft." : d === "RETEST" ? "Adds it unchanged to the follow-up draft." : undefined}
                              >
                                {DECISION_BUTTON[d]}
                              </ActionButton>
                            ))}
                          </div>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
