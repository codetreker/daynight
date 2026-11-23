import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import ordinary from "./vitest.config.js";

const label = process.env.CLI_EVIDENCE_LABEL;
if (!label || !/^(linux-full|windows-(full|focused)-[12]|macos-(full|focused))$/.test(label)) {
  throw new Error("A valid CLI_EVIDENCE_LABEL is required.");
}
const focused = process.env.CLI_FOCUSED;
if (focused !== "true" && focused !== "false") throw new Error("CLI_FOCUSED must be true or false.");
const reporters = ordinary.test?.reporters;
if (!Array.isArray(reporters)) throw new Error("Ordinary CLI reporters must be an array.");

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../.github/scripts/cli-portable-files.json", import.meta.url)), "utf8"));
if (!Array.isArray(manifest.files)) throw new Error("Invalid portable file manifest.");
const portable = manifest.files.map((entry: unknown) => {
  if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string" ||
      !/^test\/[a-zA-Z0-9_./-]+\.test\.[cm]?[jt]sx?$/.test(entry.path) || entry.path.split("/").includes("..")) {
    throw new Error("Invalid portable test path.");
  }
  return entry.path;
});

export default defineConfig({
  ...ordinary,
  test: {
    ...ordinary.test,
    exclude: [...(ordinary.test?.exclude ?? configDefaults.exclude), ...(focused === "true" ? portable : [])],
    reporters: [...reporters, ["json", { outputFile: fileURLToPath(new URL(`../../.tmp/focused-evidence/${label}/results.json`, import.meta.url)) }]],
  },
});
