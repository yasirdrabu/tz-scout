import Link from "next/link";
import { getCompanyContext } from "@/server/context";
import { ActionButton, Disclosure } from "@/components/client";
import { CopyButton } from "../../tests/library/copy-button";
import type { HandoffMessage } from "@/lib/handoff";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { relative } from "@/lib/format";
import type { FollowUp } from "@/server/crm";
import { refreshFollowUpAction, returnToQueueAction, writeHandoffMessagesAction } from "./actions";

export const metadata = { title: "Sent" };

/** Where an account stands after the handoff, in one word. */
function standing(f: FollowUp | null): { label: string; tone: "good" | "near" | "bad" | "neutral" } {
  if (!f) return { label: "Not checked", tone: "neutral" };
  if (f.meetings > 0 || f.deals > 0) return { label: f.deals > 0 ? "Deal created" : "Meeting held", tone: "good" };
  if (f.emails + f.calls > 0 || f.tasksDone > 0) return { label: "In progress", tone: "good" };
  if (f.overdue > 0) return { label: "Not started, overdue", tone: "bad" };
  return { label: "Not started", tone: "near" };
}

export default async function SentPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ owner?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const canAct = ctx.can("buyers.act");
  const batches = await ctx.db.handoffBatch.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      accounts: {
        where: sp.owner ? { sellerId: sp.owner } : {},
        orderBy: [{ sellerId: "asc" }, { bestTotal: "desc" }],
        include: { seller: { select: { id: true, name: true } }, matches: { include: { offering: { select: { name: true } } } }, contacts: { where: { isPrimary: true }, take: 1 } },
      },
    },
  });
  const sellers = await ctx.db.seller.findMany({ where: { accounts: { some: { batchId: { not: null } } } }, select: { id: true, name: true } });
  const all = batches.flatMap((b) => b.accounts);
  const tally = (pred: (f: FollowUp | null) => boolean) => all.filter((a) => pred(a.followUp as FollowUp | null)).length;
  const lastCheck = all.map((a) => a.followUpAt).filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0];
  const portal = process.env.HUBSPOT_PORTAL_ID;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers`} className="hover:text-ink">
            Buyers
          </Link>
        }
        title="Sent"
        description="Accounts handed to reps, by batch. Once sent, an account leaves the queue so new leads don't mix with handed-off ones. Follow-through is read from HubSpot."
        actions={
          canAct && all.length > 0 ? (
            <div className="flex flex-col items-end gap-1">
              <ActionButton action={refreshFollowUpAction.bind(null, slug, null)} pendingText="Checking HubSpot...">
                Check follow-through
              </ActionButton>
              {lastCheck && <span className="text-2xs text-ink-muted">Last checked {relative(lastCheck)}</span>}
            </div>
          ) : undefined
        }
      />

      {all.length === 0 ? (
        <EmptyState title="Nothing sent yet">When you push accounts to HubSpot from Buyers, they move here as a batch.</EmptyState>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Tile n={all.length} label="Accounts sent" />
            <Tile n={tally((f) => !!f && (f.emails + f.calls + f.meetings > 0 || f.tasksDone > 0))} label="Being worked" />
            <Tile n={tally((f) => !!f && f.meetings + f.deals > 0)} label="Meeting or deal" />
            <Tile n={tally((f) => !!f && f.overdue > 0 && f.tasksDone === 0 && f.emails + f.calls === 0)} label="Not started, overdue" tone="bad" />
          </div>

          {sellers.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="w-14 text-ink-muted">Owner</span>
              <Chip href={`/c/${slug}/buyers/sent`} active={!sp.owner}>
                Anyone
              </Chip>
              {sellers.map((s) => (
                <Chip key={s.id} href={`/c/${slug}/buyers/sent?owner=${s.id}`} active={sp.owner === s.id}>
                  {s.name}
                </Chip>
              ))}
            </div>
          )}

          <div className="space-y-5">
            {batches
              .filter((b) => b.accounts.length > 0)
              .map((b) => (
                <Card key={b.id}>
                  <CardHeader
                    title={b.name}
                    description={`Sent ${b.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}${b.createdBy ? ` by ${b.createdBy}` : ""} · ${b.accounts.length} ${b.accounts.length === 1 ? "account" : "accounts"}`}
                    actions={
                      canAct ? (
                        <ActionButton action={refreshFollowUpAction.bind(null, slug, b.id)} size="sm" variant="ghost" pendingText="Checking...">
                          Check this batch
                        </ActionButton>
                      ) : undefined
                    }
                  />
                  <HandoffMessages slug={slug} batchId={b.id} messages={b.messages as HandoffMessage[] | null} canAct={canAct} />
                  <Table>
                    <thead>
                      <tr>
                        <Th>Company</Th>
                        <Th>Owner</Th>
                        <Th>Offer</Th>
                        <Th>Where it stands</Th>
                        <Th numeric>Tasks done</Th>
                        <Th numeric>Since the handoff</Th>
                        {canAct && <Th />}
                      </tr>
                    </thead>
                    <tbody>
                      {b.accounts.map((a) => {
                        const f = a.followUp as FollowUp | null;
                        const st = standing(f);
                        const best = a.matches.find((m) => m.offeringId === a.bestOfferingId);
                        return (
                          <tr key={a.id} className="hover:bg-sunken/50">
                            <Td className="min-w-48">
                              <Link href={`/c/${slug}/buyers/${a.id}`} className="font-medium text-ink hover:text-accent">
                                {a.name}
                              </Link>
                              <div className="text-2xs text-ink-muted">
                                {a.contacts[0] ? `${a.contacts[0].firstName} ${a.contacts[0].lastName ?? ""}, ${a.contacts[0].title ?? ""}` : "No buyer contact found"}
                              </div>
                              {portal && a.hubspotCompanyId && (
                                <a href={`https://app.hubspot.com/contacts/${portal}/record/0-2/${a.hubspotCompanyId}`} target="_blank" rel="noreferrer" className="text-2xs text-accent hover:underline">
                                  Open in HubSpot
                                </a>
                              )}
                            </Td>
                            <Td className="whitespace-nowrap text-ink-soft">{a.seller?.name ?? "Unassigned"}</Td>
                            <Td className="text-ink-soft">{best?.offering.name ?? "n/a"}</Td>
                            <Td>
                              <Badge tone={st.tone}>{st.label}</Badge>
                              {/* Only activity since the handoff; older history belongs to the previous owner. */}
                              {f?.lastActivityAt && new Date(f.lastActivityAt) > b.createdAt && <div className="mt-0.5 text-2xs text-ink-muted">Last activity {relative(new Date(f.lastActivityAt))}</div>}
                            </Td>
                            <Td numeric className="tnum">
                              {f ? `${f.tasksDone} of ${f.tasksTotal}` : "n/a"}
                              {f && f.overdue > 0 ? <div className="text-2xs text-bad">{f.overdue} overdue</div> : null}
                            </Td>
                            <Td numeric className="text-xs text-ink-soft">
                              {f ? [f.emails && `${f.emails} emails`, f.calls && `${f.calls} calls`, f.meetings && `${f.meetings} meetings`, f.deals && `${f.deals} deals`].filter(Boolean).join(", ") || "Nothing yet" : "n/a"}
                            </Td>
                            {canAct && (
                              <Td>
                                <ActionButton action={returnToQueueAction.bind(null, slug, a.id)} size="sm" variant="ghost" confirm={`Move ${a.name} back into the Buyers queue? It stays in HubSpot as it is.`}>
                                  Back to queue
                                </ActionButton>
                              </Td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </Card>
              ))}
          </div>
        </>
      )}
    </>
  );
}

/** One message per rep, to post in Teams in place of HubSpot's per-task alerts. */
function HandoffMessages({ slug, batchId, messages, canAct }: { slug: string; batchId: string; messages: HandoffMessage[] | null; canAct: boolean }) {
  if (!messages?.length)
    return canAct ? (
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-xs text-ink-muted">
        <span>No handoff message for this batch yet.</span>
        <ActionButton action={writeHandoffMessagesAction.bind(null, slug, batchId)} size="sm" variant="ghost" pendingText="Writing...">
          Write handoff messages
        </ActionButton>
      </div>
    ) : null;
  return (
    <div className="border-b border-line px-4 py-2.5">
      <Disclosure summary={<span className="text-xs font-medium text-ink-soft">Handoff {messages.length === 1 ? "message" : `messages (${messages.length})`}: {messages.map((m) => m.seller.split(" ")[0]).join(", ")}</span>}>
        <div className="mt-2 grid gap-3 lg:grid-cols-2">
          {messages.map((m) => (
            <div key={m.sellerId ?? "none"} className="rounded-md border border-line bg-sunken/40">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <span className="text-xs font-medium text-ink">
                  To {m.seller} · {m.count} {m.count === 1 ? "account" : "accounts"}
                </span>
                <CopyButton text={m.text} />
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 font-sans text-xs leading-relaxed text-ink-soft">{m.text}</pre>
            </div>
          ))}
        </div>
        <p className="mt-2 text-2xs text-ink-muted">Copy it into Teams, or ask Claude to post it to the group chat for you.</p>
      </Disclosure>
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "bad" }) {
  return (
    <Card className="p-4">
      <div className={`tnum text-2xl font-semibold ${tone === "bad" && n > 0 ? "text-bad" : "text-ink"}`}>{n}</div>
      <div className="text-xs text-ink-muted">{label}</div>
    </Card>
  );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={`inline-flex h-6 items-center rounded-full border px-2.5 ${active ? "border-accent-line bg-accent-soft font-medium text-accent-ink" : "border-line bg-surface text-ink-soft hover:text-ink"}`}>
      {children}
    </Link>
  );
}
