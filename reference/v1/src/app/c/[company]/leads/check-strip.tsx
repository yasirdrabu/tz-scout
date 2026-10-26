import type { CheckResult } from "@prisma/client";
import { cx } from "@/components/ui";
import { CHECKS } from "@/lib/leadChecks";
import { CHECK_LABEL } from "./labels";

const DOT: Record<CheckResult, string> = { PASS: "bg-good", FAIL: "bg-bad", UNKNOWN: "bg-near" };

/** Seven small marks, one per check in a fixed order. Hover for the label, result and reason. */
export function CheckStrip({ checks }: { checks: { check: string; result: CheckResult; reason: string }[] }) {
  return (
    <div className="flex items-center gap-1" aria-label="Check results">
      {CHECKS.map((c) => {
        const r = checks.find((x) => x.check === c.key);
        const tip = r ? `${c.label}: ${CHECK_LABEL[r.result]}. ${r.reason}` : `${c.label}: not run yet`;
        return <span key={c.key} title={tip} aria-label={tip} className={cx("inline-block h-2.5 w-2.5 rounded-sm", r ? DOT[r.result] : "border border-line-strong bg-surface")} />;
      })}
    </div>
  );
}
