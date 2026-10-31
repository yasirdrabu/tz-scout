// The app's screens live in web-ui/. Next serves only the route handlers (/v1, /api, healthz,
// readyz); it still needs a root layout for its own not-found page.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
