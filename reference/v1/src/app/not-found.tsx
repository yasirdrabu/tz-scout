import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="text-center">
        <h1 className="text-base font-semibold">Not found</h1>
        <p className="mt-1 text-sm text-ink-muted">That page doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <Link href="/" className="link mt-3 inline-block text-sm">
          Go home
        </Link>
      </div>
    </main>
  );
}
