"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { cx } from "@/components/ui";

export function NavLink({ href, children, badge, notUnder = [] }: { href: string; children: React.ReactNode; badge?: number; notUnder?: string[] }) {
  const path = usePathname();
  const active = (path === href || path.startsWith(href + "/")) && !notUnder.some((p) => path === p || path.startsWith(p + "/"));
  return (
    <Link href={href} className={cx("flex items-center justify-between rounded px-2.5 py-1.5 text-sm", active ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-soft hover:bg-sunken hover:text-ink")}>
      <span>{children}</span>
      {badge != null && <span className="tnum rounded-full bg-near-soft px-1.5 text-2xs font-medium text-near">{badge}</span>}
    </Link>
  );
}

export function CompanySwitcher({ current, companies }: { current: string; companies: { slug: string; name: string }[] }) {
  const router = useRouter();
  const path = usePathname();
  const name = companies.find((c) => c.slug === current)?.name ?? current;
  if (companies.length <= 1) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-accent text-2xs font-bold text-white">{name.slice(0, 2).toUpperCase()}</div>
        <div className="truncate text-sm font-semibold">{name}</div>
      </div>
    );
  }
  return (
    <label className="block">
      <span className="sr-only">Company</span>
      <select
        aria-label="Company"
        className="input font-semibold"
        value={current}
        onChange={(e) => {
          const rest = path.split("/").slice(3, 4).join("/") || "buyers";
          router.push(`/c/${e.target.value}/${rest}`);
        }}
      >
        {companies.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SignOutButton() {
  return (
    <button className="text-2xs text-ink-muted hover:text-ink" onClick={() => signOut({ callbackUrl: "/signin" })}>
      Sign out
    </button>
  );
}
