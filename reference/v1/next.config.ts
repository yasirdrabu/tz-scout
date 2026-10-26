import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A separate output folder lets a production build run beside the dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["pg-boss", "pg", "@prisma/client", "unpdf", "jszip"],
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
};

export default nextConfig;
