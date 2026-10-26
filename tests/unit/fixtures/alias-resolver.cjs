/* eslint-disable @typescript-eslint/no-require-imports */
// Test-only import resolver: maps "@/x" to "<cwd>/src/x" without checking the file exists,
// so the boundaries test can lint in-memory files that import modules not on disk.
const path = require("node:path");

exports.interfaceVersion = 2;
exports.resolve = (source) => {
  if (!source.startsWith("@/")) return { found: false };
  return { found: true, path: path.resolve(process.cwd(), "src", source.slice(2)) + ".ts" };
};
