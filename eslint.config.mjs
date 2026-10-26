import { FlatCompat } from "@eslint/eslintrc";
import boundaries from "eslint-plugin-boundaries";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const sameModule = { moduleName: "${from.moduleName}" };

// Exported so the boundaries unit test can lint in-memory files with the same rules.
export const boundariesConfig = {
  files: ["src/**/*.{ts,tsx}"],
  plugins: { boundaries },
  settings: {
    "import/resolver": { typescript: { project: "./tsconfig.json" } },
    "boundaries/elements": [
      { type: "module-public", pattern: ["src/modules/*/index.ts", "src/modules/*/contracts/**"], mode: "file", capture: ["moduleName"] },
      { type: "module", pattern: "src/modules/*/**", mode: "file", capture: ["moduleName"] },
      { type: "platform", pattern: "src/platform/**", mode: "file" },
      { type: "app", pattern: ["src/app/**", "src/entry/**", "src/components/**"], mode: "file" },
    ],
  },
  rules: {
    "boundaries/element-types": [
      "error",
      {
        default: "disallow",
        message: "${file.type} may not import ${dependency.type} here (modules talk through index.ts or contracts)",
        rules: [
          {
            from: ["module", "module-public"],
            allow: [["module", sameModule], ["module-public", sameModule], "platform", "module-public"],
          },
          { from: "platform", allow: ["platform"] },
          { from: "app", allow: ["app", "platform", "module-public"] },
        ],
      },
    ],
  },
};

const config = [
  {
    ignores: [
      "reference/**",
      ".next/**",
      "dist/**",
      "node_modules/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
  boundariesConfig,
];

export default config;
