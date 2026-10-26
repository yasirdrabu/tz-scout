// Shared UI primitives. Server-safe (no hooks). Interactive pieces live in ./client.tsx.

import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { Colour } from "@/lib/scorecard";

export const cx = clsx;

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium text-ink-muted">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ className, children, ...rest }: ComponentProps<"div">) {
  return (
    <div className={cx("rounded-lg border border-line bg-surface shadow-card", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = "neutral" | "accent" | "good" | "near" | "bad" | "muted";

const TONES: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-soft border-line",
  accent: "bg-accent-soft text-accent-ink border-accent-line",
  good: "bg-good-soft text-good border-good-line",
  near: "bg-near-soft text-near border-near-line",
  bad: "bg-bad-soft text-bad border-bad-line",
  muted: "bg-surface text-ink-faint border-line",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-2xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const c = { neutral: "bg-ink-faint", accent: "bg-accent", good: "bg-good", near: "bg-near", bad: "bg-bad", muted: "bg-line-strong" }[tone];
  return <span className={cx("inline-block h-1.5 w-1.5 rounded-full", c)} />;
}

export const colourTone = (c: Colour): Tone => (c === "green" ? "good" : c === "amber" ? "near" : c === "red" ? "bad" : c === "grey" ? "muted" : "neutral");

const BTN = {
  primary: "bg-accent text-white hover:bg-accent-hover border-transparent",
  secondary: "bg-surface text-ink border-line-strong hover:bg-sunken",
  ghost: "bg-transparent text-ink-soft border-transparent hover:bg-sunken",
  danger: "bg-surface text-bad border-bad-line hover:bg-bad-soft",
} as const;
export type ButtonVariant = keyof typeof BTN;

export function buttonClass(variant: ButtonVariant = "secondary", size: "sm" | "md" = "md") {
  return cx(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
    BTN[variant],
  );
}

export function Button({ variant = "secondary", size = "md", className, ...rest }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return <button className={cx(buttonClass(variant, size), className)} {...rest} />;
}

export function LinkButton({ variant = "secondary", size = "md", className, ...rest }: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return <Link className={cx(buttonClass(variant, size), className)} {...rest} />;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, numeric, className, ...rest }: ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th className={cx("whitespace-nowrap border-b border-line bg-sunken/60 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted", numeric && "text-right", className)} {...rest}>
      {children}
    </th>
  );
}

export function Td({ children, numeric, className, ...rest }: ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td className={cx("border-b border-line px-3 py-2 align-top text-ink", numeric && "tnum whitespace-nowrap text-right", className)} {...rest}>
      {children}
    </td>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
      <div className="text-sm font-medium text-ink">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-ink-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "neutral", title, children, className }: { tone?: "neutral" | "near" | "bad" | "good" | "accent"; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded border px-3 py-2 text-sm", TONES[tone], className)}>
      {title && <div className="font-medium">{title}</div>}
      {children && <div className={cx(title && "mt-0.5", "text-ink-soft")}>{children}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone, size = "md" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; size?: "md" | "lg" }) {
  const valueTone = tone === "good" ? "text-good" : tone === "near" ? "text-near" : tone === "bad" ? "text-bad" : tone === "accent" ? "text-accent" : "text-ink";
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={cx("tnum mt-0.5 font-semibold tracking-tight", size === "lg" ? "text-3xl" : "text-xl", valueTone)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

export function Tabs({ items, current }: { items: { href: string; label: ReactNode; key: string; count?: number }[]; current: string }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-line">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cx("-mb-px border-b-2 px-3 py-2 text-sm", t.key === current ? "border-accent font-medium text-ink" : "border-transparent text-ink-muted hover:text-ink")}
        >
          {t.label}
          {t.count != null && <span className="tnum ml-1.5 text-xs text-ink-faint">{t.count}</span>}
        </Link>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-2xs text-ink-muted">{hint}</span>}
      {error && <span className="mt-1 block text-2xs text-bad">{error}</span>}
    </label>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Horizontal bar for factor breakdowns and funnels. value and max in the same unit. */
export function Bar({ value, max, tone = "accent", className }: { value: number; max: number; tone?: "accent" | "good" | "near" | "bad" | "muted"; className?: string }) {
  const pctW = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const c = { accent: "bg-accent", good: "bg-good", near: "bg-near", bad: "bg-bad", muted: "bg-ink-faint" }[tone];
  return (
    <div className={cx("h-2 w-full overflow-hidden rounded-full bg-sunken", className)}>
      <div className={cx("h-full rounded-full", c)} style={{ width: `${pctW}%` }} />
    </div>
  );
}
