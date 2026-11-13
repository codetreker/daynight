import { cpSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type * as ManualAssembly from "../src/commands/skill/manual-assembly.js";
import type * as Manual from "../src/commands/skill/manual.js";

const { assembleManual } = await import(new URL("../dist/commands/skill/manual-assembly.js", import.meta.url).href) as typeof ManualAssembly;
const { manualTopicFiles } = await import(new URL("../dist/commands/skill/manual.js", import.meta.url).href) as typeof Manual;

const resources = [
  { source: "commands/review/skills/daynight-review", destination: "commands/review/skills/daynight-review", sqlOnly: false },
  { source: "commands/skill/skills/using-daynight", destination: "commands/skill/skills/using-daynight", sqlOnly: false },
  { source: "commands/review/sqlite", destination: "commands/review/sqlite", sqlOnly: true },
  { source: "commands/worker/sqlite", destination: "commands/worker/sqlite", sqlOnly: true },
  { source: "commands/worker/backends/sqlite", destination: "commands/worker/backends/sqlite", sqlOnly: true },
  { source: "commands/worker/herdr/sqlite", destination: "commands/worker/herdr/sqlite", sqlOnly: true },
  { source: "commands/worker/herdr/input-sqlite", destination: "commands/worker/herdr/input-sqlite", sqlOnly: true },
  { source: "commands/controller/sqlite/journal", destination: "commands/controller/sqlite/journal", sqlOnly: true },
  { source: "commands/controller/sqlite/resume-lease", destination: "commands/controller/sqlite/resume-lease", sqlOnly: true },
];

for (const resource of resources) {
  const source = statSync(new URL(`../src/${resource.source}`, import.meta.url));
  if (!source.isDirectory()) {
    throw new Error(`Resource source is not a directory: ${resource.source}`);
  }
}

const topics = new Map(manualTopicFiles.map((filename) => {
  const source = new URL(`../src/commands/skill/skills/using-daynight/${filename}`, import.meta.url);
  if (!statSync(source).isFile()) throw new Error(`Manual topic source is not a file: ${filename}`);
  return [filename, readFileSync(source)] as const;
}));
const manual = assembleManual(topics);

for (const resource of resources) {
  cpSync(
    new URL(`../src/${resource.source}`, import.meta.url),
    new URL(`../dist/${resource.destination}`, import.meta.url),
    {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !resource.sqlOnly || statSync(source).isDirectory() || source.toLowerCase().endsWith(".sql"),
    },
  );
}

writeFileSync(new URL("../dist/commands/skill/usage.md", import.meta.url), manual, { flag: "wx" });

// Both service and Controller execute this immutable decoder build. The manifest
// identifies the helper and engine together; it does not attest native vision.
const media = new URL("../dist/commands/controller/media/", import.meta.url);
const digest = (file: string): string => createHash("sha256").update(readFileSync(new URL(file, media))).digest("hex");
writeFileSync(new URL("image-validation-manifest.json", media), JSON.stringify({
  version: 1,
  buildId: "daynight-image-validation-v1-sharp-0.35.5",
  helperSha256: digest("image-validation-helper.js"),
  engineSha256: digest("image-validation.js"),
}) + "\n");
