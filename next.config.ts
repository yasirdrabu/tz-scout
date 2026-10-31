import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Interim, until the HTTP layer moves to Hono: the web-ui app's hashed files (copied into public/assets
  // by scripts/copy-standalone-assets.mjs) never change under the same name, so they cache for a year.
  async headers() {
    return [{ source: "/assets/:path*", headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }] }];
  },
};

export default nextConfig;
