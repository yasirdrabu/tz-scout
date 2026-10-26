"use client";

// Saved scenarios for one offering: load, delete, and pick up to three to compare.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionButton } from "@/components/client";
import { Badge, Button, Card, CardHeader, cx } from "@/components/ui";
import { deleteScenarioAction } from "./actions";

export type ScenarioRow = { id: string; name: string; createdBy: string | null; created: string; costPerWon: string; returnMultiple: string };

export function ScenarioList({ slug, offeringId, scenarios, loadedId, compareIds, canEdit }: { slug: string; offeringId: string; scenarios: ScenarioRow[]; loadedId: string | null; compareIds: string[]; canEdit: boolean }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>(compareIds);
  const base = `/c/${slug}/funnel?offering=${offeringId}`;
  const href = (opts: { scenario?: string | null; compare?: string[] }) => {
    const parts = [base];
    const sc = opts.scenario === undefined ? loadedId : opts.scenario;
    if (sc) parts.push(`scenario=${sc}`);
    const cmp = opts.compare ?? compareIds;
    if (cmp.length) parts.push(`compare=${cmp.join(",")}`);
    return parts.join("&");
  };

  return (
    <Card>
      <CardHeader
        title="Saved scenarios"
        description="Load one into the editor, or tick up to three to compare side by side."
        actions={
          <Button size="sm" disabled={picked.length < 2} onClick={() => router.push(href({ compare: picked }) + "#compare")}>
            Compare {picked.length ? `(${picked.length})` : ""}
          </Button>
        }
      />
      {scenarios.length === 0 ? (
        <p className="p-4 text-sm text-ink-muted">No scenarios saved for this offering yet. Adjust the numbers above and save one.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="w-8 border-b border-line bg-sunken/60 px-3 py-2" />
              <th className="border-b border-line bg-sunken/60 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Scenario</th>
              <th className="border-b border-line bg-sunken/60 px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wide text-ink-muted">Cost per won client</th>
              <th className="border-b border-line bg-sunken/60 px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wide text-ink-muted">Return</th>
              <th className="border-b border-line bg-sunken/60 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => {
              const on = picked.includes(s.id);
              const full = !on && picked.length >= 3;
              return (
                <tr key={s.id} className={cx(s.id === loadedId && "bg-accent-soft/40")}>
                  <td className="border-b border-line px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Compare ${s.name}`}
                      className="accent-accent"
                      checked={on}
                      disabled={full}
                      title={full ? "Compare up to three at a time" : undefined}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                    />
                  </td>
                  <td className="border-b border-line px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Link href={href({ scenario: s.id })} className="font-medium text-ink hover:text-accent">
                        {s.name}
                      </Link>
                      {s.id === loadedId && <Badge tone="accent">In the editor</Badge>}
                    </div>
                    <div className="text-2xs text-ink-muted">
                      {s.createdBy ? `${s.createdBy}, ` : ""}
                      {s.created}
                    </div>
                  </td>
                  <td className="tnum border-b border-line px-3 py-2 text-right">{s.costPerWon}</td>
                  <td className="tnum border-b border-line px-3 py-2 text-right">{s.returnMultiple}</td>
                  <td className="border-b border-line px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {s.id !== loadedId && (
                        <Link href={href({ scenario: s.id })} className="link text-xs">
                          Load
                        </Link>
                      )}
                      {canEdit && (
                        <ActionButton action={deleteScenarioAction.bind(null, slug, s.id)} variant="ghost" size="sm" confirm={`Delete the scenario "${s.name}"?`}>
                          Delete
                        </ActionButton>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {loadedId && (
        <div className="border-t border-line px-4 py-2 text-xs">
          <Link className="link" href={href({ scenario: null })}>
            Start again from defaults
          </Link>
        </div>
      )}
    </Card>
  );
}

/** Offering picker that navigates on change. */
export function OfferingPicker({ slug, current, offerings }: { slug: string; current: string; offerings: { id: string; name: string }[] }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">Offering</span>
      <select aria-label="Offering" className="input w-auto min-w-[220px]" value={current} onChange={(e) => router.push(`/c/${slug}/funnel?offering=${e.target.value}`)}>
        {offerings.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
