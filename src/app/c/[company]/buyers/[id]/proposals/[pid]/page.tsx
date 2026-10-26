import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { relative } from "@/lib/format";
import { proposalText, type ProposalDraft } from "@/ai/proposal";
import { CopyButton } from "../../controls";
import { pushProposalAction, saveProposalAction, setProposalStatusAction } from "../../../actions";

export const metadata = { title: "Proposal" };

export default async function ProposalPage({ params }: { params: Promise<{ company: string; id: string; pid: string }> }) {
  const { company: slug, id, pid } = await params;
  const ctx = await getCompanyContext(slug);
  const p = await ctx.db.proposal.findUnique({ where: { id: pid }, include: { account: true } });
  if (!p || p.accountId !== id) notFound();
  const run = p.aiRunId ? await ctx.db.aiRun.findUnique({ where: { id: p.aiRunId }, select: { mock: true } }) : null;
  const b = p.body as unknown as ProposalDraft;
  const canAct = ctx.can("buyers.act");
  const text = proposalText(b);
  const phasesText = b.phases.map((ph) => [`${ph.name} (${ph.duration})`, ...ph.activities.map((x) => `- ${x}`), ph.deliverables.length ? `You get: ${ph.deliverables.join(", ")}` : ""].filter(Boolean).join("\n")).join("\n\n");

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers/${id}`} className="hover:text-ink">
            {p.account.name}
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            {b.title}
            <Badge tone={p.status === "sent" ? "good" : "neutral"}>{p.status === "sent" ? "Sent" : "Draft"}</Badge>
          </span>
        }
        description={`Drafted ${relative(p.createdAt)}${p.createdBy ? ` by ${p.createdBy}` : ""}${run?.mock ? ". Assembled from rules (Claude isn't connected yet): edit before sending." : "."}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <CopyButton text={text} label="Copy as text" />
            {canAct && p.account.hubspotCompanyId && (
              <ActionButton action={pushProposalAction.bind(null, slug, id, pid)} pendingText="Adding...">
                {p.hubspotNoteId ? "Update in HubSpot" : "Add to HubSpot"}
              </ActionButton>
            )}
            {canAct && (
              <ActionButton action={setProposalStatusAction.bind(null, slug, id, pid, p.status === "sent" ? "draft" : "sent")} variant={p.status === "sent" ? "ghost" : "primary"}>
                {p.status === "sent" ? "Back to draft" : "Mark as sent"}
              </ActionButton>
            )}
          </div>
        }
      />

      <Card className="mb-5">
        <article className="mx-auto max-w-3xl space-y-5 p-6 text-sm leading-relaxed text-ink">
          <Section title="Where you are">
            <p>{b.situation}</p>
          </Section>
          <Section title="What you want">
            <List items={b.objectives} />
          </Section>
          <Section title="How we'll do it">
            <div className="space-y-3">
              {b.phases.map((ph) => (
                <div key={ph.name} className="rounded border border-line p-3">
                  <div className="font-medium">
                    {ph.name} <span className="font-normal text-ink-muted">· {ph.duration}</span>
                  </div>
                  <List items={ph.activities} />
                  {ph.deliverables.length > 0 && <p className="mt-1 text-xs text-ink-soft">You get: {ph.deliverables.join(", ")}</p>}
                </div>
              ))}
            </div>
          </Section>
          <Section title="What you get">
            <List items={b.deliverables} />
          </Section>
          <Section title="Timeline and investment">
            <p>{b.timeline}</p>
            <p className="mt-1">
              <span className="font-medium">{b.investment.price}.</span> {b.investment.terms}
            </p>
          </Section>
          <Section title="Assumptions">
            <List items={b.assumptions} />
          </Section>
          <Section title="Why us">
            <List items={b.whyUs} />
          </Section>
          <Section title="Next steps">
            <List items={b.nextSteps} />
          </Section>
        </article>
      </Card>

      {canAct && (
        <Card>
          <CardHeader title="Edit" description="One item per line for lists. Phases: a line with the name and (duration), then '- ' activities, then 'You get: ' deliverables, with a blank line between phases." />
          <ActionForm action={saveProposalAction.bind(null, slug, id, pid)} className="grid gap-3 p-4 text-xs">
            <Field label="Title" name="title" value={b.title} />
            <Field label="Where you are" name="situation" value={b.situation} rows={4} />
            <Field label="What you want" name="objectives" value={b.objectives.join("\n")} rows={4} />
            <Field label="How we'll do it" name="phases" value={phasesText} rows={10} />
            <Field label="What you get" name="deliverables" value={b.deliverables.join("\n")} rows={3} />
            <Field label="Timeline" name="timeline" value={b.timeline} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Price" name="price" value={b.investment.price} />
              <Field label="Terms" name="terms" value={b.investment.terms} />
            </div>
            <Field label="Assumptions" name="assumptions" value={b.assumptions.join("\n")} rows={3} />
            <Field label="Why us" name="whyUs" value={b.whyUs.join("\n")} rows={3} />
            <Field label="Next steps" name="nextSteps" value={b.nextSteps.join("\n")} rows={3} />
            <div>
              <SubmitButton pendingText="Saving...">Save</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function Field({ label, name, value, rows }: { label: string; name: string; value: string; rows?: number }) {
  return (
    <label className="block text-ink-muted">
      {label}
      {rows ? <textarea name={name} defaultValue={value} rows={rows} className="input mt-1 w-full text-xs" /> : <input name={name} defaultValue={value} className="input mt-1 h-8 w-full py-0 text-xs" />}
    </label>
  );
}
