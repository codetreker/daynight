import { cpSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const resources = [
  { path: "commands/review/skills/daynight-review", kind: "directory", sqlOnly: false },
  { path: "commands/skill/skills/using-daynight", kind: "directory", sqlOnly: false },
  { path: "commands/skill/usage.md", kind: "file", sqlOnly: false },
  { path: "commands/review/sqlite", kind: "directory", sqlOnly: true },
  { path: "commands/worker/sqlite", kind: "directory", sqlOnly: true },
  { path: "commands/worker/backends/sqlite", kind: "directory", sqlOnly: true },
  { path: "commands/worker/herdr/sqlite", kind: "directory", sqlOnly: true },
  { path: "commands/worker/herdr/input-sqlite", kind: "directory", sqlOnly: true },
  { path: "commands/controller/sqlite/journal", kind: "directory", sqlOnly: true },
  { path: "commands/controller/sqlite/resume-lease", kind: "directory", sqlOnly: true },
];

for (const resource of resources) {
  const source = statSync(new URL(`../src/${resource.path}`, import.meta.url));
  if (resource.kind === "directory" ? !source.isDirectory() : !source.isFile()) {
    throw new Error(`Resource source is not a ${resource.kind}: ${resource.path}`);
  }
}

for (const resource of resources) {
  cpSync(
    new URL(`../src/${resource.path}`, import.meta.url),
    new URL(`../dist/${resource.path}`, import.meta.url),
    {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !resource.sqlOnly || statSync(source).isDirectory() || source.toLowerCase().endsWith(".sql"),
    },
  );
}

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
