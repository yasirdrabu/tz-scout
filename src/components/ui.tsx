// Shared UI primitives. Server-safe (no hooks). Interactive pieces live in ./client.tsx.

import clsx from 'clsx';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

export const cx = clsx;

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
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

export function Card({ className, children, ...rest }: ComponentProps<'div'>) {
  return (
    <div className={cx('rounded-lg border border-line bg-surface shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'accent' | 'good' | 'near' | 'bad' | 'muted';

const TONES: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-soft border-line',
  accent: 'bg-accent-soft text-accent-ink border-accent-line',
  good: 'bg-good-soft text-good border-good-line',
  near: 'bg-near-soft text-near border-near-line',
  bad: 'bg-bad-soft text-bad border-bad-line',
  muted: 'bg-surface text-ink-faint border-line',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-2xs font-medium', TONES[tone])}
    >
      {children}
    </span>
  );
}

const BTN = {
  primary: 'bg-accent text-white hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-sunken',
  ghost: 'bg-transparent text-ink-soft border-transparent hover:bg-sunken',
  danger: 'bg-surface text-bad border-bad-line hover:bg-bad-soft',
} as const;
export type ButtonVariant = keyof typeof BTN;

export function buttonClass(variant: ButtonVariant = 'secondary', size: 'sm' | 'md' = 'md') {
  return cx(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
    BTN[variant],
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return <button className={cx(buttonClass(variant, size), className)} {...rest} />;
}

export function LinkButton({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return <Link className={cx(buttonClass(variant, size), className)} {...rest} />;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, numeric, className, ...rest }: ComponentProps<'th'> & { numeric?: boolean }) {
  return (
    <th
      className={cx(
        'whitespace-nowrap border-b border-line bg-sunken/60 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted',
        numeric && 'text-right',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, numeric, className, ...rest }: ComponentProps<'td'> & { numeric?: boolean }) {
  return (
    <td
      className={cx('border-b border-line px-3 py-2 align-top text-ink', numeric && 'tnum whitespace-nowrap text-right', className)}
      {...rest}
    >
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

export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'near' | 'bad' | 'good' | 'accent';
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cx('rounded border px-3 py-2 text-sm', TONES[tone])}>
      {title && <div className="font-medium">{title}</div>}
      {children && <div className={cx(title && 'mt-0.5', 'text-ink-soft')}>{children}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-ink-muted">{hint}</span>}
    </label>
  );
}
