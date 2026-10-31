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
      { type: "lib", pattern: "src/lib/**", mode: "file" },
      { type: "app", pattern: ["src/app/**", "src/entry/**"], mode: "file" },
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
          { from: "app", allow: ["app", "lib", "platform", "module-public"] },
          { from: "lib", allow: ["lib"] },
        ],
      },
    ],
  },
};

// Provider SDKs may be imported only by live adapters (INT-E5-S2-AC1).
export const SDK_PACKAGES = ["@anthropic-ai/sdk", "@hubspot/api-client"];

// adminDb bypasses row level security. Only these files may import it; everything else goes
// through withTenant. Tests (outside src/) may use it freely.
export const ADMIN_DB_ALLOWED = [
  "src/platform/**",
  "src/modules/tenancy/services/**",
  "src/modules/tenancy/auth.ts",
  "src/modules/integrations/jobs.ts",
  // An unauthenticated webhook has no tenant until its connection is found (connectionTenant).
  "src/modules/integrations/services/inbound.ts",
  // adminRoute: platform-admin requests have no tenant and run on adminDb, after the admin check.
  "src/app/v1/_lib/v1-route.ts",
  "src/entry/**",
];
const LIVE_ADAPTERS = ["src/modules/*/adapters/*/live*", "src/modules/*/adapters/*/live*/**"];

const sdkRestriction = {
  paths: SDK_PACKAGES.map((name) => ({
    name,
    message: "Provider SDKs may only be imported from src/modules/*/adapters/*/live*. Call providers through gateway.call.",
  })),
  patterns: SDK_PACKAGES.map((name) => ({
    group: [name + "/*"],
    message: "Provider SDKs may only be imported from src/modules/*/adapters/*/live*.",
  })),
};
const ADMIN_DB_MESSAGE =
  "adminDb bypasses row level security. Use withTenant, or add this file to ADMIN_DB_ALLOWED in eslint.config.mjs with a reason.";
const adminDbRestriction = {
  paths: [{ name: "@/platform/db/client", importNames: ["adminDb"], message: ADMIN_DB_MESSAGE }],
  patterns: [{ group: ["**/platform/db/client", "!@/platform/db/client"], importNames: ["adminDb"], message: ADMIN_DB_MESSAGE }],
};
const restrict = (...parts) => [
  "error",
  { paths: parts.flatMap((r) => r.paths), patterns: parts.flatMap((r) => r.patterns) },
];

// One no-restricted-imports rule per file set: in flat config a later setting replaces an earlier one.
export const restrictedImportConfigs = [
  { files: ["src/**/*.{ts,tsx}"], rules: { "no-restricted-imports": restrict(sdkRestriction, adminDbRestriction) } },
  { files: ADMIN_DB_ALLOWED, rules: { "no-restricted-imports": restrict(sdkRestriction) } },
  { files: LIVE_ADAPTERS, rules: { "no-restricted-imports": restrict(adminDbRestriction) } },
];
/** Kept for the boundaries test. */
export const sdkImportConfigs = restrictedImportConfigs;

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
      "web-ui/**",
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
  ...restrictedImportConfigs,
];

export default config;
