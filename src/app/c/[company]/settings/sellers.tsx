// Settings, Team: who follows up on accounts (HubSpot owners), and our fields in HubSpot.

import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, CardHeader, Notice, Table, Td, Th } from "@/components/ui";
import { adapters } from "@/integrations";
import { modeOf } from "@/integrations/mode";
import { TAAZAA_PROPERTIES } from "@/integrations/hubspot/properties";
import type { CompanyContext } from "@/server/context";
import { listSellers } from "@/server/crm";
import { addToTeamAction, setOnTeamAction, setUpHubSpotFieldsAction, syncSellersAction } from "./actions";

export async function SellersSection({ ctx, slug, canEdit }: { ctx: CompanyContext; slug: string; canEdit: boolean }) {
  const sellers = await listSellers(ctx.db);
  const team = sellers.filter((s) => s.onTeam);
  const roster = sellers.filter((s) => !s.onTeam && s.active);
  const counts = await ctx.db.account.groupBy({ by: ["sellerId"], _count: true, where: { sellerId: { not: null } } });
  const assigned = new Map(counts.map((c) => [c.sellerId, c._count]));

  let fields: Set<string> | null = null;
  let fieldsError: string | null = null;
  if (modeOf("hubspot") === "live") {
    try {
      fields = await adapters(ctx.db, ctx.company.id).hubspot.existingProperties();
    } catch (e) {
      fieldsError = (e as Error).message;
    }
  }
  const missing = fields ? TAAZAA_PROPERTIES.filter((p) => !fields!.has(p.name)) : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Who follows up"
          description="The people you can assign accounts to. They're HubSpot owners, so a pushed account lands in HubSpot under them with a task. They don't need to log in here."
          actions={canEdit ? <ActionButton action={syncSellersAction.bind(null, slug)} size="sm" variant="ghost" pendingText="Syncing...">Sync owners from HubSpot</ActionButton> : undefined}
        />
        {team.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">Nobody yet. Add people from the HubSpot owner list below.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>HubSpot owner</Th>
                <Th className="text-right">Accounts assigned</Th>
                {canEdit && <Th />}
              </tr>
            </thead>
            <tbody>
              {team.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium text-ink">
                    {s.name}
                    {s.email && <div className="text-2xs font-normal text-ink-muted">{s.email}</div>}
                  </Td>
                  <Td className="text-ink-soft">
                    <span className="font-mono text-xs">{s.hubspotOwnerId}</span> {!s.active && <Badge tone="near">Inactive in HubSpot</Badge>}
                  </Td>
                  <Td className="tnum text-right">{assigned.get(s.id) ?? 0}</Td>
                  {canEdit && (
                    <Td className="text-right">
                      <ActionButton action={setOnTeamAction.bind(null, slug, s.id, false)} size="sm" variant="ghost" confirm={`Remove ${s.name} from the team? Accounts already assigned keep their owner.`}>
                        Remove
                      </ActionButton>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canEdit && roster.length > 0 && (
          <ActionForm action={addToTeamAction.bind(null, slug)} className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
            <label className="text-xs text-ink-muted" htmlFor="add-seller">
              Add from HubSpot owners
              <select id="add-seller" name="sellerId" className="input mt-1 h-8 w-64 py-0" defaultValue="">
                <option value="">Pick someone</option>
                {roster.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <SubmitButton size="sm" pendingText="Adding...">
              Add to team
            </SubmitButton>
          </ActionForm>
        )}
      </Card>

      <Card>
        <CardHeader title="Fields in HubSpot" description="Our company fields in HubSpot let reps filter and sort on why an account is a lead: best offer, tier, scores, why now, top signals, research topics. The full context also goes in a note on each company either way." />
        <div className="space-y-3 p-4 text-sm">
          {modeOf("hubspot") !== "live" ? (
            <Notice tone="neutral">HubSpot is on sample mode. Fields are created once it&apos;s live.</Notice>
          ) : fieldsError ? (
            <Notice tone="bad">{fieldsError}</Notice>
          ) : missing.length === 0 ? (
            <p className="text-ink-soft">All {TAAZAA_PROPERTIES.length} fields are set up in the &ldquo;Taazaa buyer signals&rdquo; group on companies.</p>
          ) : (
            <>
              <p className="text-ink-soft">
                {missing.length} of {TAAZAA_PROPERTIES.length} fields aren&apos;t in HubSpot yet: {missing.map((p) => p.label).join(", ")}. Until they are, pushes still send the note, contacts and task.
              </p>
              {canEdit && (
                <ActionButton action={setUpHubSpotFieldsAction.bind(null, slug)} size="sm" pendingText="Creating..." confirm="Create the Taazaa buyer signals field group and its company fields in HubSpot? This changes HubSpot settings for everyone.">
                  Create the fields in HubSpot
                </ActionButton>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
