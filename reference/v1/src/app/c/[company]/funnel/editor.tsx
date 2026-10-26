"use client";

// Funnel model editor and presentation view. All numbers on screen come from computeFunnel; this file only
// converts between what people type (dollars, percents) and what is stored (cents, decimals).

import { useEffect, useMemo, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, CardHeader, Field, Stat, cx } from "@/components/ui";
import { computeFunnel, STAGES, type FunnelInputs, type FunnelResult } from "@/lib/funnel";
import { money, multiple, num } from "@/lib/format";
import type { FormAction } from "@/server/action";
import { COST_LABEL, fmtRate, fromDisplay, SAMPLE_LABEL, shownCost, SLIDER, toDisplay, VOLUME_LABEL, type RateField } from "./labels";

type Props = {
  offeringId: string;
  offeringName: string;
  currency: string;
  initial: FunnelInputs;
  defaults: FunnelInputs;
  fromHistory: Partial<Record<RateField, boolean>>;
  samples: Partial<Record<RateField, number>>;
  historyDays: number;
  scenario: { id: string; name: string } | null;
  canEdit: boolean;
  saveAction: FormAction;
  saveRedirect: string;
  startPresent: boolean;
};

const count = (n: number) => num(n, Number.isInteger(n) ? 0 : 1);

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** A number box that lets people type freely and only reports values that parse. Empty reports null. */
function NumberBox({ value, onChange, digits = 2, label, prefix, suffix, disabled, className, allowEmpty }: { value: number | null; onChange: (n: number | null) => void; digits?: number; label: string; prefix?: string; suffix?: string; disabled?: boolean; className?: string; allowEmpty?: boolean }) {
  const fmt = (v: number | null) => (v == null ? "" : String(round(v, digits)));
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : fmt(value);
  return (
    <div className={cx("relative", className)}>
      {prefix && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-muted">{prefix}</span>}
      <input
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        className={cx("input tnum text-right", prefix && "pl-5", suffix && "pr-6")}
        value={shown}
        onFocus={() => {
          setText(fmt(value));
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const clean = t.replace(/[$,%\s]/g, "");
          if (clean === "") {
            if (allowEmpty) onChange(null);
            return;
          }
          const n = Number(clean);
          if (Number.isFinite(n) && n >= 0) onChange(n);
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-muted">{suffix}</span>}
    </div>
  );
}

function defaultNote(k: RateField, p: Pick<Props, "defaults" | "fromHistory" | "samples" | "historyDays" | "currency">) {
  const v = fmtRate(k, p.defaults[k], p.currency);
  if (p.fromHistory[k]) {
    const n = p.samples[k];
    return `From history: ${v}, last ${p.historyDays} days${n ? `, ${num(n)} ${SAMPLE_LABEL[k]}` : ""}`;
  }
  return `Company default: ${v}`;
}

export function FunnelEditor(props: Props) {
  const { currency, canEdit } = props;
  const [inputs, setInputs] = useState<FunnelInputs>(props.initial);
  const [present, setPresent] = useState(props.startPresent);
  const result = useMemo(() => computeFunnel(inputs), [inputs]);
  const dirty = JSON.stringify(inputs) !== JSON.stringify(props.initial);

  const setRate = (k: RateField, display: number) => setInputs((i) => ({ ...i, [k]: fromDisplay(k, display) }));
  const set = <K extends keyof FunnelInputs>(k: K, v: FunnelInputs[K]) => setInputs((i) => ({ ...i, [k]: v }));

  const togglePresent = (on: boolean) => {
    setPresent(on);
    syncPresentUrl(on);
  };

  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPresent(false);
      syncPresentUrl(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present]);

  if (present) return <Presentation {...props} inputs={inputs} result={result} setRate={setRate} onExit={() => togglePresent(false)} />;

  const exp = inputs.expansion ?? null;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Stages"
            description="Move a slider or type a number. Costs update as you go."
            actions={
              <button type="button" className="link text-xs" onClick={() => setInputs((i) => ({ ...i, ...pickRates(props.defaults) }))}>
                Reset all rates to defaults
              </button>
            }
          />
          <div className="divide-y divide-line">
            {STAGES.map((st, idx) => {
              const k = st.rateKey as RateField;
              const cfg = SLIDER[k];
              const display = toDisplay(k, inputs[k]);
              const max = Math.max(cfg.max, Math.ceil(display * 1.25));
              const changed = Math.abs(inputs[k] - props.defaults[k]) > 1e-9;
              const stage = result.stages[idx]!;
              return (
                <div key={st.key} className="grid items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(170px,1.1fr)_minmax(140px,1.4fr)_120px_minmax(130px,auto)]">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="tnum text-2xs text-ink-faint">{idx + 1}</span>
                      <span className="font-medium text-ink">{st.label}</span>
                    </div>
                    <div className="text-xs text-ink-soft">{st.rateLabel}</div>
                    <div className="mt-0.5 text-2xs text-ink-muted">
                      {defaultNote(k, props)}
                      {changed && (
                        <>
                          {" · "}
                          <button type="button" className="link" onClick={() => set(k, props.defaults[k])}>
                            Reset
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <input
                    type="range"
                    aria-label={`${st.label}: ${st.rateLabel}`}
                    min={0}
                    max={max}
                    step={cfg.step}
                    value={display}
                    onChange={(e) => setRate(k, Number(e.target.value))}
                    className="w-full accent-accent"
                  />
                  <NumberBox
                    label={`${st.rateLabel} for ${st.label}`}
                    value={round(display, cfg.digits)}
                    digits={cfg.digits}
                    prefix={k === "cpmCents" ? "$" : undefined}
                    suffix={k === "cpmCents" ? undefined : "%"}
                    onChange={(n) => n != null && setRate(k, k === "cpmCents" ? n : Math.min(100, n))}
                  />
                  <div className="text-right">
                    <div className="tnum font-semibold text-ink">{money(shownCost(stage), currency, { precise: idx < 2 })}</div>
                    <div className="text-2xs text-ink-muted">{COST_LABEL[stage.key].toLowerCase()}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader title="Deal economics and goals" description="Deal value and margin start from the offering. Budget and target start from Settings." />
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Deal value ($)">
              <NumberBox label="Deal value in dollars" digits={0} prefix="$" value={inputs.dealValueCents / 100} onChange={(n) => n != null && set("dealValueCents", Math.round(n * 100))} />
            </Field>
            <Field label="Gross margin (%)">
              <NumberBox label="Gross margin percent" digits={1} suffix="%" value={inputs.margin * 100} onChange={(n) => n != null && set("margin", Math.min(100, n) / 100)} />
            </Field>
            <Field label="Won clients wanted per month">
              <NumberBox label="Won clients wanted per month" digits={1} allowEmpty value={inputs.targetWonPerMonth ?? null} onChange={(n) => set("targetWonPerMonth", n)} />
            </Field>
            <Field label="Monthly budget ($)">
              <NumberBox label="Monthly budget in dollars" digits={0} prefix="$" allowEmpty value={inputs.budgetCents != null ? inputs.budgetCents / 100 : null} onChange={(n) => set("budgetCents", n == null ? null : Math.round(n * 100))} />
            </Field>
          </div>
          <div className="border-t border-line px-4 py-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-accent" checked={exp != null} onChange={(e) => set("expansion", e.target.checked ? { rate: 0.3, valueCents: inputs.dealValueCents * 2, margin: inputs.margin } : null)} />
              Include follow-on work
            </label>
            <p className="mt-0.5 text-2xs text-ink-muted">Some clients buy more after the first deal. This adds the expected profit from that work to each won client.</p>
            {exp && (
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <Field label="Clients who buy more (%)">
                  <NumberBox label="Share of clients who buy more" digits={1} suffix="%" value={exp.rate * 100} onChange={(n) => n != null && set("expansion", { ...exp, rate: Math.min(100, n) / 100 })} />
                </Field>
                <Field label="Follow-on value ($)">
                  <NumberBox label="Follow-on value in dollars" digits={0} prefix="$" value={exp.valueCents / 100} onChange={(n) => n != null && set("expansion", { ...exp, valueCents: Math.round(n * 100) })} />
                </Field>
                <Field label="Follow-on margin (%)">
                  <NumberBox label="Follow-on margin percent" digits={1} suffix="%" value={exp.margin * 100} onChange={(n) => n != null && set("expansion", { ...exp, margin: Math.min(100, n) / 100 })} />
                </Field>
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        <div className="space-y-5 xl:sticky xl:top-6">
          <Summary result={result} inputs={inputs} currency={currency} />
          <Card>
            <CardHeader
              title={props.scenario ? `Scenario: ${props.scenario.name}` : "Save as a scenario"}
              description={dirty ? "You have changes that are not saved." : props.scenario ? "Loaded from saved scenarios." : "Starting from defaults."}
              actions={
                <button type="button" className="link text-xs" onClick={() => togglePresent(true)}>
                  Present
                </button>
              }
            />
            {canEdit ? (
              <ActionForm action={props.saveAction} redirectTo={props.saveRedirect} className="space-y-3 p-4">
                <input type="hidden" name="inputs" value={JSON.stringify(inputs)} />
                {props.scenario && <input type="hidden" name="scenarioId" value={props.scenario.id} />}
                <Field label="Scenario name">
                  <input key={props.scenario?.id ?? "new"} name="name" className="input" defaultValue={props.scenario?.name ?? ""} placeholder="Show-up back to 75%" required />
                </Field>
                <div className="flex flex-wrap gap-2">
                  {props.scenario && (
                    <SubmitButton name="mode" value="update" pendingText="Saving...">
                      Update scenario
                    </SubmitButton>
                  )}
                  <SubmitButton name="mode" value="new" variant={props.scenario ? "secondary" : "primary"} pendingText="Saving...">
                    Save as new
                  </SubmitButton>
                  {dirty && (
                    <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setInputs(props.initial)}>
                      Undo changes
                    </button>
                  )}
                </div>
              </ActionForm>
            ) : (
              <p className="p-4 text-xs text-ink-muted">You can try numbers here. Owners and operators can save scenarios.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Keep ?present=1 in the address so a refresh stays in presentation mode. */
function syncPresentUrl(on: boolean) {
  const u = new URL(window.location.href);
  if (on) u.searchParams.set("present", "1");
  else u.searchParams.delete("present");
  window.history.replaceState(null, "", u.toString());
}

function pickRates(i: FunnelInputs) {
  return { cpmCents: i.cpmCents, ctr: i.ctr, formRate: i.formRate, validationRate: i.validationRate, discoveryShowRate: i.discoveryShowRate, qualificationRate: i.qualificationRate, salesShowRate: i.salesShowRate, closeRate: i.closeRate };
}

function Summary({ result, inputs, currency }: { result: FunnelResult; inputs: FunnelInputs; currency: string }) {
  const losing = result.profitPerClientCents != null && result.profitPerClientCents < 0;
  return (
    <Card>
      <CardHeader title="Summary" description="Per won client, and what the budget buys." />
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-4">
        <div className="col-span-2">
          <Stat size="lg" label="Cost per won client" value={money(result.costPerWonCents, currency)} />
        </div>
        <Stat label="Profit per client" value={money(result.profitPerClientCents, currency)} tone={losing ? "bad" : undefined} sub={result.expansionProfitCents > 0 ? "Includes follow-on work" : undefined} />
        <Stat label="Return" value={multiple(result.returnMultiple)} tone={result.returnMultiple != null && result.returnMultiple < 1 ? "bad" : undefined} sub="Gross profit per dollar spent to win a client" />
        <Stat label="Budget needed" value={money(result.budgetNeededCents, currency)} sub={inputs.targetWonPerMonth != null ? `For ${count(inputs.targetWonPerMonth)} won clients a month` : "Set a target to see this"} />
        <Stat label="Clients from budget" value={num(result.clientsFromBudget, 1)} sub={inputs.budgetCents != null ? `From ${money(inputs.budgetCents, currency)} a month` : "Set a budget to see this"} />
      </div>
      {inputs.budgetCents != null && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-1.5 text-xs font-medium text-ink-soft">What {money(inputs.budgetCents, currency)} a month buys</div>
          <table className="w-full text-xs">
            <tbody>
              {result.stages.map((s) => (
                <tr key={s.key}>
                  <td className="py-0.5 text-ink-muted">{s.label}</td>
                  <td className="tnum py-0.5 text-right text-ink">{num(s.volumeFromBudget, s.volumeFromBudget != null && s.volumeFromBudget < 10 ? 1 : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Presentation({ offeringName, scenario, currency, inputs, result, setRate, onExit }: Props & { inputs: FunnelInputs; result: FunnelResult; setRate: (k: RateField, d: number) => void; onExit: () => void }) {
  const losing = result.profitPerClientCents != null && result.profitPerClientCents < 0;
  const big = [
    { label: "Cost per won client", value: money(result.costPerWonCents, currency) },
    { label: "Profit per client", value: money(result.profitPerClientCents, currency), bad: losing },
    { label: "Return", value: multiple(result.returnMultiple), bad: result.returnMultiple != null && result.returnMultiple < 1 },
    inputs.targetWonPerMonth != null
      ? { label: `Budget for ${count(inputs.targetWonPerMonth)} clients a month`, value: money(result.budgetNeededCents, currency) }
      : { label: "Clients from budget", value: num(result.clientsFromBudget, 1) },
  ];
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-canvas">
      <style>{"[data-chrome]{display:none}"}</style>
      <div className="mx-auto max-w-7xl px-10 py-8">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <div className="text-lg text-ink-muted">Funnel model</div>
            <h1 className="text-4xl font-semibold tracking-tight text-ink">{offeringName}</h1>
            {scenario && <div className="mt-1 text-xl text-ink-soft">{scenario.name}</div>}
          </div>
          <button type="button" onClick={onExit} className="rounded border border-line-strong bg-surface px-4 py-2 text-base font-medium text-ink hover:bg-sunken">
            Exit presentation
          </button>
        </div>

        <div className="mb-10 grid gap-4 md:grid-cols-4">
          {big.map((b) => (
            <div key={b.label} className="rounded-lg border border-line bg-surface p-6 shadow-card">
              <div className="text-lg text-ink-muted">{b.label}</div>
              <div className={cx("tnum mt-2 text-5xl font-semibold tracking-tight", b.bad ? "text-bad" : "text-ink")}>{b.value}</div>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          <table className="w-full text-xl">
            <thead>
              <tr className="border-b border-line bg-sunken/60 text-left text-base text-ink-muted">
                <th className="px-6 py-3 font-medium">Stage</th>
                <th className="px-6 py-3 text-right font-medium">Rate</th>
                <th className="px-6 py-3 text-right font-medium">Cost at this stage</th>
                {inputs.budgetCents != null && <th className="px-6 py-3 text-right font-medium">From {money(inputs.budgetCents, currency)} a month</th>}
              </tr>
            </thead>
            <tbody>
              {STAGES.map((st, idx) => {
                const k = st.rateKey as RateField;
                const s = result.stages[idx]!;
                const cfg = SLIDER[k];
                const display = toDisplay(k, inputs[k]);
                return (
                  <tr key={st.key} className="border-b border-line last:border-0">
                    <td className="px-6 py-4">
                      <div className="font-semibold text-ink">{st.label}</div>
                      <div className="text-base text-ink-muted">{st.rateLabel}</div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="tnum text-3xl font-semibold text-ink">{fmtRate(k, inputs[k], currency)}</div>
                      <input type="range" aria-label={`${st.label}: ${st.rateLabel}`} min={0} max={Math.max(cfg.max, Math.ceil(display * 1.25))} step={cfg.step} value={display} onChange={(e) => setRate(k, Number(e.target.value))} className="mt-1 w-40 accent-accent opacity-60 hover:opacity-100" />
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="tnum text-3xl font-semibold text-ink">{money(shownCost(s), currency, { precise: idx < 2 })}</div>
                      <div className="text-base text-ink-muted">{COST_LABEL[s.key].toLowerCase()}</div>
                    </td>
                    {inputs.budgetCents != null && (
                      <td className="px-6 py-4 text-right">
                        <div className="tnum text-3xl font-semibold text-ink">{num(s.volumeFromBudget, s.volumeFromBudget != null && s.volumeFromBudget < 10 ? 1 : 0)}</div>
                        <div className="text-base text-ink-muted">{VOLUME_LABEL[s.key]}</div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-6 text-base text-ink-muted">
          Deal value {money(inputs.dealValueCents, currency)} at {Math.round(inputs.margin * 100)}% margin
          {inputs.expansion ? `, plus follow-on work from ${Math.round(inputs.expansion.rate * 100)}% of clients` : ""}. Press Escape to exit.
        </p>
      </div>
    </div>
  );
}
