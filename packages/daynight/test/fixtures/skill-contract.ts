import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { manualTopicFiles } from "../../src/commands/skill/manual.js";

const requiredSkillResources = ["SKILL.md", ...manualTopicFiles] as const;

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
          if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
          const [targetPath, fragment] = target.split("#");
          const resource = targetPath ? path.resolve(path.dirname(file), targetPath) : file;
          assert.ok(contained(root, resource), `${relative} links outside the installed bundle: ${target}`);
          assert.ok(contained(root, await realpath(resource)), `${relative} resolves outside the installed bundle: ${target}`);
          if (fragment) {
            const linked = await readFile(resource, "utf8");
            const anchors = [...prose(linked).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)]
              .map((heading) => heading[1]!.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-"));
            assert.ok(anchors.includes(decodeURIComponent(fragment)), `${relative} has a missing anchor: ${target}`);
          }
          localReferences.push(target);
        }
      }
      resources.push({ path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), localReferences });
    }
  };
  await visit(root);
  resources.sort((left, right) => left.path.localeCompare(right.path));
  for (const resource of requiredSkillResources) assert.ok(documents.has(resource), `The installed bundle contains ${resource}.`);
  assert.deepEqual(resources.map((resource) => resource.path).sort(), [...requiredSkillResources].sort(), "The bundle contains only the entrypoint and topic references.");
  const entrypoint = documents.get("SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entrypoint!);
  assert.notEqual(frontmatter, null, "The installed skill has YAML frontmatter.");
  const metadata: unknown = parseYaml(frontmatter![1]!);
  assert.ok(typeof metadata === "object" && metadata !== null && !Array.isArray(metadata));
  assert.ok("name" in metadata && metadata.name === "using-daynight");
  assert.ok("description" in metadata && typeof metadata.description === "string" && metadata.description.trim().length > 0);
  return { documents, resources, metadata: { name: metadata.name, description: metadata.description } };
};
