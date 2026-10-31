// The app's screens live in web-ui/. Next serves the route handlers (/v1, /api, healthz, readyz) and,
// until the Hono move, the built app through the catch-all [[...app]] route. It still needs a root layout
// for its own not-found page.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
