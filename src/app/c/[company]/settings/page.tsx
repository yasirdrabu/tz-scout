import Link from "next/link";
import { getCompanyContext } from "@/server/context";
import { getSettings } from "@/server/settings";
import { STAGES } from "@/lib/funnel";
import { METRICS } from "@/lib/scorecard";
import { ROLE_LABEL } from "@/lib/permissions";
import { date, dateTime } from "@/lib/format";
import { PROVIDERS, PROVIDER_LABEL, modeOf } from "@/integrations/mode";
import { ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, CardHeader, Field, Notice, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { saveBuyersAction, saveFunnelAction, saveScorecardAction, saveScoringAction, saveSequenceAction, saveTestsAction } from "./actions";
import { WeightsFields } from "./weights";
import { BuyersSplitFields } from "./buyers-split";
import { SellersSection } from "./sellers";
import { buyerSettings } from "@/server/buyers";
import { dollars, ENV_VAR, GOES_LIVE, percent, plain, TABS, targetToInput, UNIT_LABEL, type TabKey } from "./values";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ company: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const ctx = await getCompanyContext(slug);
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "scoring";
  const canEdit = ctx.can("settings.edit");
  const s = await getSettings(ctx.db);

  return (
    <>
      <PageHeader title="Settings" description={`Defaults and targets for ${ctx.company.name}. Money is in ${ctx.company.currency}.`} />
      <Tabs current={tab} items={TABS.map((t) => ({ key: t.key, label: t.label, href: `/c/${slug}/settings?tab=${t.key}` }))} />
      {!canEdit && tab !== "integrations" && tab !== "team" && (
        <Notice className="mb-4" tone="neutral">
          You can view these settings. Only an owner can change them.
        </Notice>
      )}

      {tab === "scoring" && (
        <Section title="Segment scoring" description="How much each factor counts toward a segment's score, and how many segments can be active at once.">
          <ActionForm action={saveScoringAction.bind(null, slug)} className="p-4">
            <fieldset disabled={!canEdit} className="space-y-5">
              <WeightsFields initial={s.weights} disabled={!canEdit} />
              <Field label="Most active segments per offering" hint="Keeps the test budget focused." className="max-w-xs">
                <input name="maxActiveSegments" className="input tnum" inputMode="numeric" defaultValue={s.maxActiveSegments} />
              </Field>
            </fieldset>
            <Save canEdit={canEdit} />
          </ActionForm>
        </Section>
      )}

      {tab === "tests" && (
        <Section title="Message tests" description="Starting values for each new test batch. You can change them per batch.">
          {(() => {
            const t = s.testDefaults as typeof s.testDefaults & { channel?: string };
            return (
              <ActionForm action={saveTestsAction.bind(null, slug)} className="p-4">
                <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Budget per batch ($)">
                    <input name="budget" className="input tnum" inputMode="decimal" defaultValue={dollars(t.budgetCents)} />
                  </Field>
                  <Field label="How long a test runs (hours)">
                    <input name="durationHours" className="input tnum" inputMode="numeric" defaultValue={plain(t.durationHours)} />
                  </Field>
                  <Field label="Ad channel">
                    <select name="channel" className="input" defaultValue={t.channel ?? "meta"}>
                      <option value="meta">Meta ads</option>
                      <option value="linkedin">LinkedIn ads</option>
                    </select>
                  </Field>
                  <Field label="Target clickthrough rate (%)" hint="A statement at or above this keeps going.">
                    <input name="targetCtr" className="input tnum" inputMode="decimal" defaultValue={percent(t.targetCtr)} />
                  </Field>
                  <Field label="Target cost per click ($)">
                    <input name="targetCpc" className="input tnum" inputMode="decimal" defaultValue={dollars(t.targetCpcCents)} />
                  </Field>
                  <Field label="Minimum impressions" hint="Below this a statement has no verdict yet.">
                    <input name="minImpressions" className="input tnum" inputMode="numeric" defaultValue={plain(t.minImpressions)} />
                  </Field>
                  <Field label="Statements per batch">
                    <input name="statementCount" className="input tnum" inputMode="numeric" defaultValue={plain(t.statementCount)} />
                  </Field>
                </fieldset>
                <Save canEdit={canEdit} />
              </ActionForm>
            );
          })()}
        </Section>
      )}

      {tab === "funnel" && (
        <Section title="Funnel defaults" description="Used in the funnel model when there isn't enough history for a stage. History from ads, validation and HubSpot replaces these as it builds up.">
          <ActionForm action={saveFunnelAction.bind(null, slug)} className="p-4">
            <fieldset disabled={!canEdit} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {STAGES.map((st) =>
                  st.rateKey === "cpmCents" ? (
                    <Field key={st.key} label="Cost per 1,000 impressions ($)">
                      <input name="cpm" className="input tnum" inputMode="decimal" defaultValue={dollars(s.funnelDefaults.cpmCents)} />
                    </Field>
                  ) : (
                    <Field key={st.key} label={`${st.rateLabel} (%)`} hint={st.label}>
                      <input name={st.rateKey} className="input tnum" inputMode="decimal" defaultValue={percent(s.funnelDefaults[st.rateKey])} />
                    </Field>
                  ),
                )}
              </div>
              <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Deal value ($)" hint="Used when an offering has no deal size.">
                  <input name="dealValue" className="input tnum" inputMode="decimal" defaultValue={dollars(s.funnelDefaults.dealValueCents)} />
                </Field>
                <Field label="Gross margin (%)" hint="Used when an offering has no margin.">
                  <input name="margin" className="input tnum" inputMode="decimal" defaultValue={percent(s.funnelDefaults.margin)} />
                </Field>
                <Field label="Won clients wanted per month">
                  <input name="targetWonPerMonth" className="input tnum" inputMode="decimal" defaultValue={plain(s.funnelDefaults.targetWonPerMonth)} />
                </Field>
                <Field label="Monthly budget ($)">
                  <input name="budget" className="input tnum" inputMode="decimal" defaultValue={dollars(s.funnelDefaults.budgetCents)} />
                </Field>
              </div>
            </fieldset>
            <Save canEdit={canEdit} />
          </ActionForm>
        </Section>
      )}

      {tab === "sequence" && (
        <Section title="Show-up sequence" description="Reminders and rebooking for discovery and sales calls.">
          <ActionForm action={saveSequenceAction.bind(null, slug)} className="p-4">
            <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
              <Field label="Reminders (hours before the call)" hint="Comma separated, for example 24, 1.">
                <input name="reminderHours" className="input tnum" defaultValue={s.sequence.reminderHours.join(", ")} />
              </Field>
              <Field label="Rebook attempts (days after a no-show)" hint="Comma separated, for example 0, 3, 7.">
                <input name="rebookDays" className="input tnum" defaultValue={s.sequence.rebookDays.join(", ")} />
              </Field>
              <Field label="Send the booking link after (minutes)" hint="0 sends it as soon as the lead is validated.">
                <input name="bookingLinkDelayMinutes" className="input tnum" inputMode="numeric" defaultValue={plain(s.sequence.bookingLinkDelayMinutes)} />
              </Field>
              <div>
                <span className="label">Text message reminders</span>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="smsReminders" className="accent-accent" defaultChecked={s.sequence.smsReminders} />
                  Send reminders by text to leads who agreed to texts
                </label>
              </div>
            </fieldset>
            <Save canEdit={canEdit} />
          </ActionForm>
        </Section>
      )}

      {tab === "scorecard" && (
        <Section title="Scorecard targets" description="Weekly targets and the smallest sample worth colouring. Leave a target empty to show the number without a colour.">
          <ActionForm action={saveScorecardAction.bind(null, slug)}>
            <fieldset disabled={!canEdit}>
              <Table>
                <thead>
                  <tr>
                    <Th>Metric</Th>
                    <Th>Group</Th>
                    <Th numeric>Unit</Th>
                    <Th numeric>Weekly target</Th>
                    <Th numeric>Minimum sample</Th>
                  </tr>
                </thead>
                <tbody>
                  {METRICS.map((m) => {
                    const cfg = s.scorecard[m.key] ?? {};
                    return (
                      <tr key={m.key}>
                        <Td className="font-medium">
                          {m.label}
                          {m.direction === "band" && <div className="text-2xs font-normal text-ink-muted">Green within 5% either side</div>}
                          {m.direction === "lower" && <div className="text-2xs font-normal text-ink-muted">Lower is better</div>}
                        </Td>
                        <Td className="text-ink-muted">{m.group}</Td>
                        <Td numeric className="text-ink-muted">
                          {UNIT_LABEL[m.format]}
                        </Td>
                        <Td numeric className="w-36 py-1">
                          <input name={`t_${m.key}`} aria-label={`Weekly target for ${m.label}`} className="input tnum text-right" inputMode="decimal" defaultValue={targetToInput(m.format, cfg.target)} />
                        </Td>
                        <Td numeric className="w-32 py-1">
                          <input name={`m_${m.key}`} aria-label={`Minimum sample for ${m.label}`} className="input tnum text-right" inputMode="numeric" defaultValue={plain(cfg.minSample ?? 0)} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </fieldset>
            <div className="px-4 pb-4">
              <Save canEdit={canEdit} />
            </div>
          </ActionForm>
        </Section>
      )}

      {tab === "buyers" &&
        (await (async () => {
          const b = await buyerSettings(ctx.db);
          return (
            <Section title="Buyers" description="How accounts are ranked against your offerings. Saving re-ranks every account.">
              <ActionForm action={saveBuyersAction.bind(null, slug)} className="p-4">
                <fieldset disabled={!canEdit} className="space-y-5">
                  <BuyersSplitFields fit={b.fitWeight * 100} disabled={!canEdit} />
                  <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                    <Field label="Accounts Claude briefs per pull" hint="The strongest new matches from each pull get a written brief: why now, the angle and an opener.">
                      <input name="briefLimit" className="input tnum" inputMode="numeric" defaultValue={plain(b.briefLimit)} />
                    </Field>
                    <Field label="Days of signals to read" hint="How far back a pull looks for news and other signals.">
                      <input name="lookbackDays" className="input tnum" inputMode="numeric" defaultValue={plain(b.lookbackDays)} />
                    </Field>
                  </div>
                </fieldset>
                <Save canEdit={canEdit} />
              </ActionForm>
            </Section>
          );
        })())}

      {tab === "integrations" && <Integrations companyName={ctx.company.name} rows={await ctx.db.integrationConnection.findMany()} />}

      {tab === "team" && <div className="mb-4"><SellersSection ctx={ctx} slug={slug} canEdit={canEdit} /></div>}
      {tab === "team" && (
        <Section
          title="Access to this app"
          description={
            <>
              People with access to {ctx.company.name}. Admins manage access in{" "}
              {ctx.user.isAdmin ? (
                <Link href="/admin/users" className="link">
                  Admin
                </Link>
              ) : (
                "Admin"
              )}
              .
            </>
          }
        >
          <TeamTable members={await ctx.db.membership.findMany({ include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: "asc" } })} />
        </Section>
      )}
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {children}
    </Card>
  );
}

function Save({ canEdit }: { canEdit: boolean }) {
  if (!canEdit) return null;
  return (
    <div className="mt-4">
      <SubmitButton pendingText="Saving...">Save</SubmitButton>
    </div>
  );
}

function Integrations({ companyName, rows }: { companyName: string; rows: { provider: string; status: string; note: string | null; lastSyncAt: Date | null }[] }) {
  const anyMock = PROVIDERS.some((p) => modeOf(p) === "mock");
  return (
    <div className="space-y-4">
      {anyMock && (
        <Notice tone="near" title="Running on sample data">
          The app works end to end on sample data until real credentials are added. Each integration switches to live with its setting on the server, once its credentials are in place. HubSpot goes live in milestone 8, Meta ads in milestone 9, and LinkedIn and Google ads in milestone 10.
        </Notice>
      )}
      <Card>
        <CardHeader title="Integrations" description={`Connections for ${companyName}.`} />
        <Table>
          <thead>
            <tr>
              <Th>Service</Th>
              <Th>Mode</Th>
              <Th>Switch</Th>
              <Th>Connection</Th>
              <Th>Goes live</Th>
              <Th numeric>Last sync</Th>
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map((p) => {
              const mode = modeOf(p);
              const c = rows.find((r) => r.provider === p);
              return (
                <tr key={p}>
                  <Td className="font-medium">{PROVIDER_LABEL[p]}</Td>
                  <Td>{mode === "live" ? <Badge tone="good">Live</Badge> : <Badge tone="near">Sample data</Badge>}</Td>
                  <Td>
                    <code className="rounded bg-sunken px-1 py-0.5 font-mono text-2xs text-ink-soft">{ENV_VAR[p]}=live</code>
                  </Td>
                  <Td className="text-ink-soft">
                    {c ? (
                      <>
                        <span className="capitalize">{c.status.replace(/_/g, " ")}</span>
                        {c.note && <span className="text-ink-muted"> · {c.note}</span>}
                      </>
                    ) : (
                      <span className="text-ink-muted">Not set up</span>
                    )}
                  </Td>
                  <Td className="text-ink-muted">{mode === "live" ? "Live now" : GOES_LIVE[p]}</Td>
                  <Td numeric className="text-ink-muted">
                    {c?.lastSyncAt ? dateTime(c.lastSyncAt) : ""}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function TeamTable({ members }: { members: { id: string; role: keyof typeof ROLE_LABEL; createdAt: Date; user: { name: string; email: string } }[] }) {
  if (members.length === 0) return <p className="p-4 text-sm text-ink-muted">No members yet.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Email</Th>
          <Th>Role</Th>
          <Th numeric>Added</Th>
        </tr>
      </thead>
      <tbody>
        {members.map((m) => (
          <tr key={m.id}>
            <Td className="font-medium">{m.user.name}</Td>
            <Td className="text-ink-soft">{m.user.email}</Td>
            <Td>
              <Badge tone={m.role === "OWNER" ? "accent" : "neutral"}>{ROLE_LABEL[m.role]}</Badge>
            </Td>
            <Td numeric className="text-ink-muted">
              {date(m.createdAt, { month: "short", day: "numeric", year: "numeric" })}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
