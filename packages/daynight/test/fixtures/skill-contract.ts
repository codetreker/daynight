import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const requiredSkillResources = [
  "SKILL.md", "references/handbook.md", "references/create-task.md", "references/handoff.md",
  "references/run-task.md", "references/autopilot-managed-task.md", "references/task-execution.md",
  "references/goal.md", "references/task-content.md",
  "references/authorization.md", "references/setup.md", "references/project-management.md",
  "references/task-management.md", "references/write-safety.md", "references/final-acceptance.md",
] as const;

type Resource = { readonly path: string; readonly sha256: string; readonly localReferences: readonly string[] };
export type InstalledSkillContract = {
  readonly documents: ReadonlyMap<string, string>;
  readonly resources: readonly Resource[];
  readonly metadata: { readonly name: string; readonly description: string };
};

const prose = (content: string): string => {
  let fence: { marker: string; length: number } | undefined;
  return content.split(/\r?\n/).filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return false;
    }
    return fence === undefined;
  }).join("\n");
};
const contained = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const inspectInstalledSkill = async (directory: string): Promise<InstalledSkillContract> => {
  const root = await realpath(directory);
  const documents = new Map<string, string>();
  const resources: Resource[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      const relative = path.relative(root, file).replaceAll("\\", "/");
      const bytes = await readFile(file);
      const localReferences: string[] = [];
      if (entry.name.endsWith(".md")) {
        const content = bytes.toString("utf8");
        documents.set(relative, content);
        for (const match of prose(content).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          const target = match[1]!;
          if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
          const resource = path.resolve(path.dirname(file), target.split("#")[0]!);
          assert.ok(contained(root, resource), `${relative} links outside the installed bundle: ${target}`);
          assert.ok(contained(root, await realpath(resource)), `${relative} resolves outside the installed bundle: ${target}`);
          localReferences.push(target);
        }
      }
      resources.push({ path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), localReferences });
    }
  };
  await visit(root);
  resources.sort((left, right) => left.path.localeCompare(right.path));
  for (const resource of requiredSkillResources) assert.ok(documents.has(resource), `The installed bundle contains ${resource}.`);
  assert.equal(documents.has("references/autopilot.md"), false, "The removed automatic execution mode is not packaged.");
  assert.equal(documents.has("references/execute-task-in-managed.md"), false, "The renamed managed entrypoint is not packaged under its old name.");
  const entrypoint = documents.get("SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entrypoint!);
  assert.notEqual(frontmatter, null, "The installed skill has YAML frontmatter.");
  const metadata: unknown = parseYaml(frontmatter![1]!);
  assert.ok(typeof metadata === "object" && metadata !== null && !Array.isArray(metadata));
  assert.ok("name" in metadata && metadata.name === "using-daynight");
  assert.ok("description" in metadata && typeof metadata.description === "string" && metadata.description.trim().length > 0);
  return { documents, resources, metadata: { name: metadata.name, description: metadata.description } };
};
