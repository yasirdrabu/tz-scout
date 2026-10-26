import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { newBatchDefaults } from "@/server/tests";
import { Card, CardHeader, EmptyState, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/client";
import { createBatchAction } from "../actions";
import { BatchFields } from "../batch-fields";

export const metadata = { title: "New test batch" };

export default async function NewBatchPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ segment?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  if (!ctx.can("batch.edit")) notFound();

  const requested = sp.segment ? await ctx.db.segment.findUnique({ where: { id: sp.segment }, select: { id: true, buyer: true, status: true } }) : null;
  if (sp.segment && !requested) notFound();
  const active = await ctx.db.segment.findMany({
    where: { status: "ACTIVE", offering: { status: "APPROVED" } },
    select: { id: true, buyer: true, problem: true, offering: { select: { id: true, name: true } } },
    orderBy: [{ offering: { name: "asc" } }, { buyer: "asc" }],
  });
  const defaults = await newBatchDefaults(ctx.db);
  const preselected = requested && active.some((s) => s.id === requested.id) ? requested.id : undefined;

  const groups = new Map<string, { name: string; segments: typeof active }>();
  for (const s of active) {
    const g = groups.get(s.offering.id) ?? { name: s.offering.name, segments: [] };
    g.segments.push(s);
    groups.set(s.offering.id, g);
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/tests`} className="hover:text-ink">
            Message tests
          </Link>
        }
        title="New test batch"
        description="Claude writes 12 to 15 statements for the segment, half problems and half outcomes, in the buyer's words. You edit them, an owner approves the budget, then you launch."
      />
      {requested && !preselected && (
        <Notice tone="near" className="mb-4" title="That segment is not active">
          Only active segments can be tested.{" "}
          <Link className="link" href={`/c/${slug}/segments/${requested.id}`}>
            Open {requested.buyer}
          </Link>{" "}
          to activate it.
        </Notice>
      )}
      {active.length === 0 ? (
        <EmptyState title="No active segments" action={<LinkButton href={`/c/${slug}/segments`}>Go to segments</LinkButton>}>
          Activate a segment on an approved offering first. Tests are written for one buyer at a time.
        </EmptyState>
      ) : (
        <ActionForm action={createBatchAction.bind(null, slug)} redirectTo={`/c/${slug}/tests/{id}`} className="max-w-4xl space-y-5">
          <Card>
            <CardHeader title="Segment" description="Active segments on approved offerings." />
            <div className="p-4">
              <Field label="Who this batch speaks to">
                <select name="segmentId" className="input" defaultValue={preselected ?? active[0]!.id} required>
                  {[...groups.values()].map((g) => (
                    <optgroup key={g.name} label={g.name}>
                      {g.segments.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.buyer}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
            </div>
          </Card>
          <Card>
            <CardHeader title="Settings" description="Company defaults from Settings. You can change them again while the batch is a draft." />
            <div className="p-4">
              <BatchFields values={{ ...defaults, channel: defaults.channel ?? "meta" }} showCount />
            </div>
          </Card>
          <SubmitButton pendingText="Claude is writing statements...">Write statements</SubmitButton>
        </ActionForm>
      )}
    </>
  );
}
