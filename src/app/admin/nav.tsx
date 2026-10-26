"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

const ITEMS = [
  { href: "/admin", label: "Companies" },
  { href: "/admin/users", label: "People" },
  { href: "/admin/ai", label: "Claude" },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1">
      {ITEMS.map((i) => {
        const active = i.href === "/admin" ? path === "/admin" : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} className={cx("rounded px-2.5 py-1 text-sm", active ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-soft hover:bg-sunken hover:text-ink")}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
