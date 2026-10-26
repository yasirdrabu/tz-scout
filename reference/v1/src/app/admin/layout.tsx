import Link from "next/link";
import { requireAdminPage } from "./guard";
import { AdminNav } from "./nav";

export const metadata = { title: { default: "Admin", template: "%s · Admin" } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdminPage();
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded bg-accent text-2xs font-bold text-white">AD</div>
              <span className="text-sm font-semibold">Admin</span>
            </div>
            <AdminNav />
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-ink-muted">{user.name}</span>
            <Link href="/" className="link">
              Back to the app
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}
