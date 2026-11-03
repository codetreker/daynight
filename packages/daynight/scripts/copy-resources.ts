import { cpSync, statSync } from "node:fs";

const resources = [
  { path: "commands/review/skills/daynight-review", sqlOnly: false },
  { path: "commands/skill/skills/using-daynight", sqlOnly: false },
  { path: "commands/review/sqlite", sqlOnly: true },
  { path: "commands/worker/sqlite", sqlOnly: true },
  { path: "commands/worker/backends/sqlite", sqlOnly: true },
  { path: "commands/controller/sqlite/journal", sqlOnly: true },
  { path: "commands/controller/sqlite/resume-lease", sqlOnly: true },
];

for (const resource of resources) {
  if (!statSync(new URL(`../src/${resource.path}/`, import.meta.url)).isDirectory()) {
    throw new Error(`Resource source is not a directory: ${resource.path}`);
  }
}

for (const resource of resources) {
  cpSync(
    new URL(`../src/${resource.path}/`, import.meta.url),
    new URL(`../dist/${resource.path}`, import.meta.url),
    {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !resource.sqlOnly || statSync(source).isDirectory() || source.toLowerCase().endsWith(".sql"),
    },
  );
}
