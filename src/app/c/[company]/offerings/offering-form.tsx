"use client";

// Offering editor with the AI draft panel. The draft fills the form; nothing is used elsewhere until an
// owner approves the offering.

import { useActionState, useEffect, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, CardHeader, Field, cx } from "@/components/ui";
import type { ActionResult, FormAction } from "@/server/action";
import type { OfferingDraft } from "@/ai/offeringDraft";

export type OfferingFormValues = {
  name: string;
  promise: string;
  priceMin: string;
  priceMax: string;
  grossMargin: string;
  dealSize: string;
  salesCycleDays: string;
  targetTitles: string;
  companySizeMin: string;
  companySizeMax: string;
  revenueMinM: string;
  revenueMaxM: string;
  industries: string;
  regions: string;
  excludedDomains: string;
  excludedCategories: string;
  proofPoints: string;
  timelineWindowDays: string;
  caseStudyIds: string[];
};

const s = (n: number | null | undefined) => (n == null ? "" : String(n));

function applyDraft(v: OfferingFormValues, d: OfferingDraft): { values: OfferingFormValues; filled: string[] } {
  const filled: string[] = [];
  const next = { ...v };
  const set = (k: keyof OfferingFormValues, val: string, label: string) => {
    if (val && val !== next[k]) {
      (next[k] as string) = val;
      filled.push(label);
    }
  };
  if (!v.name) set("name", d.name, "name");
  set("promise", d.promise, "promise");
  set("targetTitles", d.targetTitles.join(", "), "target buyer");
  set("industries", d.industries.join(", "), "industries");
  set("companySizeMin", s(d.companySizeMin), "company size");
  set("companySizeMax", s(d.companySizeMax), "company size");
  set("priceMin", s(d.priceMinDollars), "price");
  set("priceMax", s(d.priceMaxDollars), "price");
  set("salesCycleDays", s(d.salesCycleDays), "sales cycle");
  set("proofPoints", d.proofPoints.join("\n"), "proof points");
  if (d.exclusions.length) set("excludedCategories", d.exclusions.join(", "), "exclusions");
  return { values: next, filled: [...new Set(filled)] };
}

export function OfferingForm({
  initial,
  saveAction,
  draftAction,
  caseStudies,
  canEdit,
  redirectTo,
  submitLabel = "Save",
}: {
  initial: OfferingFormValues;
  saveAction: FormAction;
  draftAction: FormAction;
  caseStudies: { id: string; title: string; client: string; industry: string }[];
  canEdit: boolean;
  redirectTo?: string;
  submitLabel?: string;
}) {
  const [values, setValues] = useState(initial);
  const [filled, setFilled] = useState<string[]>([]);
  const [draftState, runDraft] = useActionState<ActionResult | null, FormData>(draftAction, null);

  useEffect(() => {
    if (draftState?.ok && draftState.data) {
      const r = applyDraft(values, draftState.data as OfferingDraft);
      setValues(r.values);
      setFilled(r.filled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftState]);

  const bind = (k: keyof OfferingFormValues) => ({
    name: k,
    value: values[k] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [k]: e.target.value })),
    disabled: !canEdit,
    className: cx("input", filled.length > 0 && hl(k) && "border-accent-line bg-accent-soft/40"),
  });
  const hl = (k: keyof OfferingFormValues) => {
    const map: Record<string, string> = { promise: "promise", targetTitles: "target buyer", industries: "industries", proofPoints: "proof points", priceMin: "price", priceMax: "price", salesCycleDays: "sales cycle", companySizeMin: "company size", companySizeMax: "company size", name: "name", excludedCategories: "exclusions" };
    return map[k] ? filled.includes(map[k]!) : false;
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <ActionForm action={saveAction} redirectTo={redirectTo} className="space-y-5">
        <Card>
          <CardHeader title="The offer" description="What we sell and what the buyer gets." />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <input {...bind("name")} required placeholder="AI Opportunity Map" />
            </Field>
            <Field label="One-line promise" hint="One plain sentence a buyer would understand. Under 20 words." className="sm:col-span-2">
              <textarea {...bind("promise")} rows={2} />
            </Field>
            <Field label="Price from ($)">
              <input {...bind("priceMin")} inputMode="decimal" placeholder="10000" />
            </Field>
            <Field label="Price to ($)">
              <input {...bind("priceMax")} inputMode="decimal" placeholder="10000" />
            </Field>
            <Field label="Typical deal size ($)" hint="Used as the default deal value in the funnel model.">
              <input {...bind("dealSize")} inputMode="decimal" />
            </Field>
            <Field label="Gross margin (%)">
              <input {...bind("grossMargin")} inputMode="decimal" placeholder="55" />
            </Field>
            <Field label="Sales cycle (days)">
              <input {...bind("salesCycleDays")} inputMode="numeric" />
            </Field>
            <Field label="Timeline window (days)" hint="Leads whose timeline is longer than this fail validation.">
              <input {...bind("timelineWindowDays")} inputMode="numeric" />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Who buys it" description="Used to score segments and validate leads." />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Target titles" hint="Comma separated. The economic buyer." className="sm:col-span-2">
              <input {...bind("targetTitles")} placeholder="CEO, COO, VP Operations" />
            </Field>
            <Field label="Company size from (employees)">
              <input {...bind("companySizeMin")} inputMode="numeric" />
            </Field>
            <Field label="Company size to (employees)">
              <input {...bind("companySizeMax")} inputMode="numeric" />
            </Field>
            <Field label="Revenue from ($ millions)">
              <input {...bind("revenueMinM")} inputMode="decimal" placeholder="50" />
            </Field>
            <Field label="Revenue to ($ millions)">
              <input {...bind("revenueMaxM")} inputMode="decimal" placeholder="500" />
            </Field>
            <Field label="Industries" hint="Comma separated." className="sm:col-span-2">
              <textarea {...bind("industries")} rows={2} />
            </Field>
            <Field label="Regions" hint="Comma separated.">
              <input {...bind("regions")} placeholder="United States" />
            </Field>
            <Field label="Excluded categories" hint="Leads in these industries fail validation.">
              <input {...bind("excludedCategories")} />
            </Field>
            <Field label="Excluded domains" hint="Comma separated, e.g. competitors." className="sm:col-span-2">
              <input {...bind("excludedDomains")} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Proof" description="Specific results with numbers where we have them." />
          <div className="space-y-4 p-4">
            <Field label="Proof points" hint="One per line.">
              <textarea {...bind("proofPoints")} rows={4} />
            </Field>
            <div>
              <span className="label">Linked case studies</span>
              {caseStudies.length === 0 ? (
                <p className="text-xs text-ink-muted">No case studies yet. Add them under Case studies.</p>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {caseStudies.map((c) => (
                    <label key={c.id} className="flex items-start gap-2 rounded border border-line px-2.5 py-1.5 text-sm hover:bg-sunken">
                      <input
                        type="checkbox"
                        name="caseStudyIds"
                        value={c.id}
                        disabled={!canEdit}
                        checked={values.caseStudyIds.includes(c.id)}
                        onChange={(e) => setValues((v) => ({ ...v, caseStudyIds: e.target.checked ? [...v.caseStudyIds, c.id] : v.caseStudyIds.filter((x) => x !== c.id) }))}
                        className="mt-0.5 accent-accent"
                      />
                      <span>
                        <span className="block font-medium">{c.client}</span>
                        <span className="block text-2xs text-ink-muted">
                          {c.title} · {c.industry}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>

        {canEdit && (
          <div className="flex items-center gap-3">
            <SubmitButton pendingText="Saving...">{submitLabel}</SubmitButton>
            {filled.length > 0 && <span className="text-xs text-ink-muted">Review the highlighted fields before saving.</span>}
          </div>
        )}
      </ActionForm>

      {canEdit && (
        <div>
          <Card className="sticky top-6">
            <CardHeader title="Draft with Claude" description="Paste a page or upload a deck or case study. Claude fills the fields; you review and save." />
            <form action={runDraft} className="space-y-3 p-4">
              <input type="hidden" name="name" value={values.name} />
              <Field label="Web address">
                <input name="url" className="input" placeholder="https://www.taazaa.com/..." />
              </Field>
              <div className="text-center text-2xs text-ink-faint">or</div>
              <Field label="File" hint="PDF, Word, PowerPoint, HTML or text. Up to 8 MB.">
                <input type="file" name="file" accept=".pdf,.docx,.pptx,.html,.htm,.txt,.md" className="block w-full text-xs text-ink-soft file:mr-2 file:rounded file:border file:border-line-strong file:bg-surface file:px-2 file:py-1 file:text-xs" />
              </Field>
              <SubmitButton variant="secondary" pendingText="Reading and drafting...">
                Draft fields
              </SubmitButton>
              {draftState && !draftState.ok && <p className="text-xs text-bad">{draftState.error}</p>}
              {draftState?.ok && (
                <div className="rounded border border-accent-line bg-accent-soft px-2.5 py-2 text-xs text-accent-ink">
                  {filled.length ? (
                    <>
                      Filled: {filled.map((f) => <Badge key={f} tone="accent" className="mr-1 mt-1">{f}</Badge>)}
                    </>
                  ) : (
                    "Claude didn't find anything new in that source."
                  )}
                </div>
              )}
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
