import type { Config } from "tailwindcss";

// Warm neutrals, white cards, one accent (plum). Status colours are reserved for meaning:
// good = on target, near = within 15%, bad = off target.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#F6F5F2",
        surface: "#FFFFFF",
        sunken: "#F1EFEB",
        line: { DEFAULT: "#E6E3DD", strong: "#D6D2CA" },
        ink: { DEFAULT: "#1F1C19", soft: "#45403A", muted: "#7A736B", faint: "#A39C93" },
        accent: { DEFAULT: "#7B2D6B", hover: "#66235A", soft: "#F5ECF3", line: "#E6CFE0", ink: "#5C1F50" },
        good: { DEFAULT: "#18794E", soft: "#EAF6EF", line: "#BFE3CE" },
        near: { DEFAULT: "#A15C07", soft: "#FDF4E3", line: "#F1D9A8" },
        bad: { DEFAULT: "#B42318", soft: "#FDEEEC", line: "#F4C7C1" },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", "16px"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(31,28,25,0.04), 0 1px 1px rgba(31,28,25,0.03)",
        pop: "0 8px 24px rgba(31,28,25,0.10), 0 2px 6px rgba(31,28,25,0.06)",
      },
      borderRadius: { DEFAULT: "6px", lg: "10px" },
    },
  },
  plugins: [],
} satisfies Config;
