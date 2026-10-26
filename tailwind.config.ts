import type { Config } from "tailwindcss";

// Design tokens arrive with the UI task (see docs/spec/architecture/design-and-copy.md).
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
