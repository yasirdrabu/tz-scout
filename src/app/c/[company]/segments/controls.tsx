"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, Dialog, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import { FACTOR_BY_KEY } from "@/lib/scoring";
import type { FormAction } from "@/server/action";
import { MANUAL_FACTORS } from "./labels";

/** Offering picker. Changing it loads that offering's segments. */
export function OfferingPicker({ slug, current, offerings }: { slug: string; current: string | null; offerings: { id: string; name: string; segments: number }[] }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">Offering</span>
      <select className="input w-auto min-w-[240px]" value={current ?? ""} onChange={(e) => router.push(`/c/${slug}/segments?offering=${e.target.value}`)}>
        {!current && <option value="">Choose an approved offering</option>}
        {offerings.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.segments} segments)
          </option>
        ))}
      </select>
    </label>
  );
}

function FactorSlider({ k }: { k: (typeof MANUAL_FACTORS)[number] }) {
  const def = FACTOR_BY_KEY[k];
  const [v, setV] = useState(5);
  return (
    <label className="block" title={def.help}>
      <span className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink-soft">{def.label}</span>
        <span className="tnum font-semibold text-ink">{v}</span>
      </span>
      <input type="range" name={k} min={0} max={10} step={1} value={v} onChange={(e) => setV(Number(e.target.value))} className="w-full accent-accent" />
      <span className="block text-2xs text-ink-muted">
        {def.help}
        {def.inverted && " Higher counts against the score."}
      </span>
    </label>
  );
}

export function ManualSegmentDialog({ action }: { action: FormAction }) {
  return (
    <Dialog trigger="Add segment by hand" title="Add a segment by hand" wide>
      {(close) => (
        <ActionForm action={action} onDone={(r) => r.ok && close()} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Buyer" hint="Who buys, with company size and type." className="sm:col-span-2">
              <input name="buyer" className="input" required placeholder="Operations leaders at 200 to 1,000 person logistics firms" />
            </Field>
            <Field label="Problem" hint="What they struggle with, in their words." className="sm:col-span-2">
              <input name="problem" className="input" required placeholder="running dispatch on spreadsheets" />
            </Field>
            <Field label="Industry" hint="Used to match case studies.">
              <input name="industry" className="input" required placeholder="Logistics" />
            </Field>
            <Field label="Likely first deal ($)" hint="Leave blank to use the offering's deal size.">
              <input name="expectedDeal" className="input" inputMode="decimal" placeholder="25000" />
            </Field>
            <Field label="Search keywords" hint="Comma separated. Used for search volume and cost per click." className="sm:col-span-2">
              <input name="keywords" className="input" placeholder="dispatch software, route planning" />
            </Field>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold text-ink">Your ratings, 0 to 10</div>
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
              {MANUAL_FACTORS.map((k) => (
                <FactorSlider key={k} k={k} />
              ))}
            </div>
            <p className="mt-2 text-2xs text-ink-muted">Audience size, competition, proof and deal size are filled in from data when you save.</p>
          </div>
          <SubmitButton pendingText="Scoring...">Add and score</SubmitButton>
        </ActionForm>
      )}
    </Dialog>
  );
}
