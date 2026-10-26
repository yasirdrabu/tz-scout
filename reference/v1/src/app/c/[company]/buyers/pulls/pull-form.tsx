// The pull form, shared by new and edit. Filters are typed as plain lists; revenue is in $ millions.

import { ActionForm, SubmitButton } from "@/components/client";
import { Card, CardHeader, Field } from "@/components/ui";
import type { ProspectFilters } from "@/integrations/prospects/types";
import { savePullAction } from "./actions";
import { MaxCompaniesField } from "./estimate";
import { SCHEDULES, toMillions, type Estimate } from "./labels";

export type PullValues = {
  name: string;
  offeringId: string | null;
  segmentId: string | null;
  filters: ProspectFilters;
  maxCompanies: number;
  schedule: string;
};

const joined = (xs: string[]) => xs.join(", ");

export function PullForm({
  slug,
  id,
  values,
  offerings,
  segments,
  estimates,
}: {
  slug: string;
  id: string | null;
  values: PullValues;
  offerings: { id: string; name: string }[];
  segments: { id: string; name: string; status: string }[];
  estimates: Estimate[];
}) {
  const f = values.filters;
  return (
    <ActionForm action={savePullAction.bind(null, slug, id)} redirectTo={`/c/${slug}/buyers/pulls`} className="max-w-4xl space-y-5">
      <Card>
        <CardHeader title="What this pull is for" />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <input name="name" className="input" defaultValue={values.name} required minLength={2} />
          </Field>
          <Field label="Offering" hint="Pulled companies are matched to every approved offering. This one sets the starting filters.">
            <select name="offeringId" className="input" defaultValue={values.offeringId ?? ""}>
              <option value="">No offering</option>
              {offerings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          {segments.length > 0 ? (
            <Field label="Segment" hint="Optional. One of this offering's segments.">
              <select name="segmentId" className="input" defaultValue={values.segmentId ?? ""}>
                <option value="">No segment</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === "ACTIVE" ? "" : " (shortlisted)"}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <input type="hidden" name="segmentId" value="" />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Which companies" description="Separate entries with commas. Leave a field empty for no limit." />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Industries" className="sm:col-span-2">
            <input name="industries" className="input" defaultValue={joined(f.industries)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Employees from">
              <input name="employeeMin" className="input tnum" inputMode="numeric" defaultValue={f.employeeMin ?? ""} />
            </Field>
            <Field label="Employees to">
              <input name="employeeMax" className="input tnum" inputMode="numeric" defaultValue={f.employeeMax ?? ""} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Revenue from ($ millions)">
              <input name="revenueMinM" className="input tnum" inputMode="decimal" defaultValue={toMillions(f.revenueMinCents)} />
            </Field>
            <Field label="Revenue to ($ millions)">
              <input name="revenueMaxM" className="input tnum" inputMode="decimal" defaultValue={toMillions(f.revenueMaxCents)} />
            </Field>
          </div>
          <Field label="Headquarters locations" hint="Cities, states or countries.">
            <input name="locations" className="input" defaultValue={joined(f.locations)} />
          </Field>
          <Field label="Company keywords">
            <input name="keywords" className="input" defaultValue={joined(f.keywords)} />
          </Field>
          <Field label="Only companies hiring for" hint="Job titles. Hiring is a buying signal, used here as a filter.">
            <input name="hiringTitles" className="input" defaultValue={joined(f.hiringTitles)} />
          </Field>
          <Field label="Only companies using" hint="Technologies, for example Snowflake or Microsoft Access.">
            <input name="technologies" className="input" defaultValue={joined(f.technologies)} />
          </Field>
          <Field label="Domains to leave out" className="sm:col-span-2">
            <input name="excludeDomains" className="input" defaultValue={joined(f.excludeDomains)} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Who to find and how often" />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Buyer titles to find at each company" hint="Empty uses the target titles of every approved offering." className="sm:col-span-2">
            <input name="titles" className="input" defaultValue={joined(f.titles)} />
          </Field>
          <MaxCompaniesField defaultValue={values.maxCompanies} table={estimates} />
          <Field label="Schedule" hint="Scheduled pulls run early in the morning.">
            <select name="schedule" className="input" defaultValue={values.schedule}>
              {SCHEDULES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <SubmitButton name="intent" value="run" pendingText="Saving...">
          Save and run
        </SubmitButton>
        <SubmitButton name="intent" value="save" variant="secondary" pendingText="Saving...">
          Save
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
