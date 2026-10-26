// Side by side comparison of up to three saved scenarios. Outputs come from computeFunnel.

import Link from "next/link";
import { Card, CardHeader, Table, Td, Th, cx } from "@/components/ui";
import { computeFunnel, type FunnelInputs, type FunnelResult } from "@/lib/funnel";
import { money, multiple, num, pct } from "@/lib/format";
import { INPUT_ROWS } from "./labels";

type Fmt = "money" | "moneyPrecise" | "rate" | "count" | "multiple";

const fmt = (v: number | null | undefined, f: Fmt, currency: string) => {
  if (v == null) return "n/a";
  if (f === "money") return money(v, currency);
  if (f === "moneyPrecise") return money(v, currency, { precise: true });
  if (f === "rate") return pct(v, v < 0.1 ? 2 : 1);
  if (f === "multiple") return multiple(v);
  return num(v, Number.isInteger(v) ? 0 : 1);
};

const OUTPUT_ROWS: { label: string; get: (r: FunnelResult) => number | null; fmt: Fmt }[] = [
  { label: "Cost per click", get: (r) => r.costPerClickCents, fmt: "moneyPrecise" },
  { label: "Cost per won client", get: (r) => r.costPerWonCents, fmt: "money" },
  { label: "Profit per client", get: (r) => r.profitPerClientCents, fmt: "money" },
  { label: "Return", get: (r) => r.returnMultiple, fmt: "multiple" },
  { label: "Budget needed for the target", get: (r) => r.budgetNeededCents, fmt: "money" },
  { label: "Clients from the budget", get: (r) => r.clientsFromBudget, fmt: "count" },
];

export function CompareTable({ scenarios, currency, clearHref }: { scenarios: { id: string; name: string; inputs: FunnelInputs }[]; currency: string; clearHref: string }) {
  const results = scenarios.map((s) => computeFunnel(s.inputs));
  const same = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);

  const row = (label: string, values: (number | null | undefined)[], f: Fmt, strong?: boolean) => (
    <tr key={label}>
      <Td className={cx("text-ink-soft", strong && "font-medium text-ink")}>{label}</Td>
      {values.map((v, i) => {
        const differs = i > 0 && !same(v, values[0]);
        return (
          <Td key={i} numeric className={cx(differs && "bg-accent-soft font-medium text-accent-ink", strong && "font-semibold")}>
            {fmt(v, f, currency)}
          </Td>
        );
      })}
    </tr>
  );

  return (
    <Card id="compare">
      <CardHeader
        title="Compare scenarios"
        description="Highlighted cells differ from the first scenario."
        actions={
          <Link href={clearHref} className="link text-xs">
            Close comparison
          </Link>
        }
      />
      <Table>
        <thead>
          <tr>
            <Th className="w-64" />
            {scenarios.map((s) => (
              <Th key={s.id} numeric className="normal-case tracking-normal text-ink">
                {s.name}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td colSpan={scenarios.length + 1} className="bg-sunken/40 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              Results
            </Td>
          </tr>
          {OUTPUT_ROWS.map((r) => row(r.label, results.map(r.get), r.fmt, true))}
          <tr>
            <Td colSpan={scenarios.length + 1} className="bg-sunken/40 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              Inputs
            </Td>
          </tr>
          {INPUT_ROWS.map((r) => row(r.label, scenarios.map((s) => r.get(s.inputs)), r.fmt))}
        </tbody>
      </Table>
    </Card>
  );
}
