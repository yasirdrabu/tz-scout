import { ESLint } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { expect, test } from "vitest";
import { boundariesConfig, sdkImportConfigs } from "../../eslint.config.mjs";

const aliasResolver = path.resolve(__dirname, "fixtures/alias-resolver.cjs");

async function boundaryErrors(filePath: string, code: string) {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
    overrideConfig: [
      { languageOptions: { parser: tsParser as never } },
      boundariesConfig,
      { settings: { "import/resolver": { [aliasResolver]: {} } } },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === "boundaries/element-types");
}

test("a module may not import another module's internals", async () => {
  const errors = await boundaryErrors(
    "src/modules/a/services/x.ts",
    'import { t } from "@/modules/b/db/schema";\nexport const x = t;\n',
  );
  expect(errors).toHaveLength(1);
});

test("a module may import another module's public interface", async () => {
  const errors = await boundaryErrors(
    "src/modules/a/services/x.ts",
    'import { t } from "@/modules/b/index";\nexport const x = t;\n',
  );
  expect(errors).toHaveLength(0);
});

test("platform may not import modules", async () => {
  const errors = await boundaryErrors(
    "src/platform/x.ts",
    'import { t } from "@/modules/b/index";\nexport const x = t;\n',
  );
  expect(errors).toHaveLength(1);
});

async function sdkErrors(filePath: string, code: string) {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
    overrideConfig: [{ languageOptions: { parser: tsParser as never } }, ...sdkImportConfigs],
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports");
}

test("provider SDKs may not be imported outside live adapters", async () => {
  const code = 'import Anthropic from "@anthropic-ai/sdk";\nexport const a = Anthropic;\n';
  expect(await sdkErrors("src/modules/ai-tasks/runner.ts", code)).toHaveLength(1);
  expect(await sdkErrors("src/modules/ai-tasks/adapters/anthropic/mock.ts", code)).toHaveLength(1);
  expect(
    await sdkErrors("src/modules/crm/services/x.ts", 'import { Client } from "@hubspot/api-client";\nexport const c = Client;\n'),
  ).toHaveLength(1);
});

test("live adapters may import provider SDKs", async () => {
  const code = 'import Anthropic from "@anthropic-ai/sdk";\nexport const a = Anthropic;\n';
  expect(await sdkErrors("src/modules/ai-tasks/adapters/anthropic/live.ts", code)).toHaveLength(0);
  expect(await sdkErrors("src/modules/ai-tasks/adapters/anthropic/live/client.ts", code)).toHaveLength(0);
});
