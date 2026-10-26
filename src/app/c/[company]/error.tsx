"use client";

export default function CompanyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-lg rounded-lg border border-bad-line bg-surface p-5">
      <h1 className="text-sm font-semibold text-bad">This page hit a problem</h1>
      <p className="mt-1 text-sm text-ink-soft">{error.message || "Something went wrong loading this page."}</p>
      {error.digest && <p className="mt-1 text-2xs text-ink-faint">Reference {error.digest}</p>}
      <button className="mt-3 rounded border border-line-strong px-3 py-1 text-sm hover:bg-sunken" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
