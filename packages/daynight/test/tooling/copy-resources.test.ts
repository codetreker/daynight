import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { inspectInstalledSkill } from "../fixtures/skill-contract.js";
import { loadSqliteSequence } from "../../src/platform/sqlite-sql.js";
import { assembleManual } from "../../src/commands/skill/manual-assembly.js";
import { manualTopicFiles } from "../../src/commands/skill/manual.js";

const root = path.resolve(import.meta.dirname, "../../../../.tmp/copy-resource-tests");
const packageDirectory = path.resolve(import.meta.dirname, "../..");
const bundles = ["commands/review/skills/daynight-review", "commands/skill/skills/using-daynight"] as const;
const sqlDirectories = [
  "commands/review/sqlite",
  "commands/worker/sqlite",
  "commands/worker/backends/sqlite",
  "commands/worker/herdr/sqlite",
  "commands/worker/herdr/input-sqlite",
  "commands/controller/sqlite/journal",
  "commands/controller/sqlite/resume-lease",
] as const;
const resources = [...bundles, ...sqlDirectories];
const standaloneManual = "commands/skill/usage.md" as const;
const stagedTimelineSql = "commands/controller/content/timeline-schema.sql" as const;
const firstTopic = `commands/skill/skills/using-daynight/${manualTopicFiles[0]}`;
const allResources = [...resources, stagedTimelineSql, standaloneManual];
type Resource = typeof allResources[number];
const directories: string[] = [];

const files = (directory: string, prefix = ""): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  }).sort();

const fixture = (missing?: Resource) => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "package, 中文 "));
  directories.push(directory);
  const scripts = path.join(directory, "scripts");
  const caller = path.join(directory, "unrelated caller");
  mkdirSync(scripts);
  mkdirSync(caller);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  const media = path.join(directory, "dist/commands/controller/media");
  mkdirSync(media, { recursive: true });
  for (const file of ["image-validation-helper.js", "image-validation.js"]) writeFileSync(path.join(media, file), `// Compiled ${file}\n`);
  cpSync(path.join(packageDirectory, "scripts/copy-resources.ts"), path.join(scripts, "copy-resources.ts"));
  const compiledSkill = path.join(directory, "dist/commands/skill");
  mkdirSync(compiledSkill, { recursive: true });
  for (const filename of ["manual.js", "manual-assembly.js"]) cpSync(path.join(packageDirectory, "dist/commands/skill", filename), path.join(compiledSkill, filename));
  const source = (resource: Resource) => path.join(directory, "src", resource === standaloneManual ? firstTopic : resource);
  const destination = (resource: Resource) => path.join(directory, "dist", resource);
  for (const bundle of bundles) {
    if (bundle === missing) continue;
    mkdirSync(path.dirname(source(bundle)), { recursive: true });
    cpSync(path.join(packageDirectory, "src", bundle), source(bundle), { recursive: true });
  }
  if (missing === standaloneManual) rmSync(source(standaloneManual));
  for (const resource of sqlDirectories) {
    if (resource === missing) continue;
    mkdirSync(source(resource), { recursive: true });
    writeFileSync(path.join(source(resource), "001-baseline.sql"), "CREATE TABLE baseline (value TEXT NOT NULL);\n");
  }
  if (missing !== stagedTimelineSql) {
    mkdirSync(path.dirname(source(stagedTimelineSql)), { recursive: true });
    cpSync(path.join(packageDirectory, "src", stagedTimelineSql), source(stagedTimelineSql));
  }
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(scripts, "copy-resources.ts")], {
      cwd: caller, encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    if (result.error !== undefined) throw result.error;
    return result;
  };
  return { directory, source, destination, run };
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("packaged resource copy", () => {
  it("binds the validation manifest to the exact compiled helper and engine bytes", () => {
    const f = fixture();
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    const media = path.join(f.directory, "dist/commands/controller/media");
    const hash = (file: string) => createHash("sha256").update(readFileSync(path.join(media, file))).digest("hex");
    expect(JSON.parse(readFileSync(path.join(media, "image-validation-manifest.json"), "utf8"))).toEqual({
      version: 1, buildId: "daynight-image-validation-v1-sharp-0.35.5",
      helperSha256: hash("image-validation-helper.js"), engineSha256: hash("image-validation.js"),
    });
  });
  it("ships the standalone CLI usage manual with valid metadata and no local document dependencies", () => {
    const f = fixture();
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    const manual = readFileSync(f.destination(standaloneManual), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(manual);
    expect(frontmatter).not.toBeNull();
    const metadata = parseYaml(frontmatter![1]!) as Record<string, unknown>;
    expect(metadata.name).toBe("daynight");
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).trim()).not.toBe("");
    expect(manual).toContain("daynight task thread read");
    expect(manual).toContain("daynight task thread post");
    const localLinks = [...manual.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1]!)
      .filter((target) => !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/iu.test(target));
    expect(localLinks).toEqual([]);
    const anchors = new Set([...manual.matchAll(/<a id="([^"]+)"><\/a>/gu)].map((match) => match[1]!));
    for (const match of manual.matchAll(/\[[^\]]*\]\(#([^)]+)\)/gu)) expect(anchors.has(match[1]!), `Missing aggregate anchor ${match[1]}`).toBe(true);
  });

  it("rejects a directory at a required topic path before copying resources", () => {
    const f = fixture(standaloneManual);
    mkdirSync(f.source(standaloneManual), { recursive: true });
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Manual topic source is not a file: references/setup-and-projects.md");
    for (const resource of allResources) expect(existsSync(f.destination(resource))).toBe(false);
  });

  it.each(manualTopicFiles)("rejects missing topic %s before copying resources", (filename) => {
    const f = fixture();
    rmSync(path.join(f.source(bundles[1]), filename));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    for (const resource of allResources) expect(existsSync(f.destination(resource))).toBe(false);
  });

  it.each([
    { name: "invalid UTF-8", content: Buffer.from([0xff]) },
    { name: "blank", content: Buffer.from(" \n\t") },
    { name: "unresolved heading", content: Buffer.from("# Setup\n\n[Missing](tasks.md#absent)\n") },
  ])("rejects $name topic before copying resources", ({ content }) => {
    const f = fixture();
    writeFileSync(f.source(standaloneManual), content);
    const result = f.run();
    expect(result.status).not.toBe(0);
    for (const resource of allResources) expect(existsSync(f.destination(resource))).toBe(false);
  });

  it("preserves invalid SQL candidates so installed discovery rejects them before database access", () => {
    const f = fixture();
    const resource = sqlDirectories[0];
    const filename = "002-upgrade.SQL";
    const sql = "ALTER TABLE baseline ADD COLUMN upgraded INTEGER;\n";
    writeFileSync(path.join(f.source(resource), filename), sql);
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    expect(readFileSync(path.join(f.destination(resource), filename), "utf8")).toBe(sql);
    expect(() => loadSqliteSequence(pathToFileURL(f.destination(resource)))).toThrow("Invalid SQLite SQL filename");
  });

  it.each([{ name: "LF", lineEnding: "\n" }, { name: "CRLF", lineEnding: "\r\n" }])("copies bundled skills and SQL byte-for-byte with $name line endings", async ({ lineEnding }) => {
    const f = fixture();
    for (const resource of resources) {
      const source = f.source(resource);
      for (const name of files(source).filter((name) => name.endsWith(".md") || name.endsWith(".sql"))) {
        const file = path.join(source, name);
        writeFileSync(file, readFileSync(file, "utf8").replaceAll("\r\n", "\n").replaceAll("\n", lineEnding));
      }
    }
    writeFileSync(f.source(stagedTimelineSql), readFileSync(f.source(stagedTimelineSql), "utf8").replaceAll("\r\n", "\n").replaceAll("\n", lineEnding));
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    const topics = new Map(manualTopicFiles.map((filename) => [filename, readFileSync(path.join(f.source(bundles[1]), filename))] as const));
    expect(readFileSync(f.destination(standaloneManual))).toEqual(Buffer.from(assembleManual(topics)));
    for (const resource of resources) {
      const sourceFiles = files(f.source(resource));
      expect(files(f.destination(resource))).toEqual(sourceFiles);
      for (const relative of sourceFiles) {
        expect(readFileSync(path.join(f.destination(resource), relative)).equals(readFileSync(path.join(f.source(resource), relative))), path.join(resource, relative)).toBe(true);
      }
    }
    expect(readFileSync(f.destination(stagedTimelineSql))).toEqual(readFileSync(f.source(stagedTimelineSql)));
    await inspectInstalledSkill(f.destination(bundles[1]));
  });

  it("rejects packaging the renamed managed reference under its old name", async () => {
    const f = fixture();
    const source = f.source(bundles[1]);
    writeFileSync(path.join(source, "references/execute-task-in-managed.md"), "Obsolete managed entrypoint.\n");
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    await expect(inspectInstalledSkill(f.destination(bundles[1]))).rejects.toThrow("The bundle contains only the entrypoint and topic references");
  });

  it("copies allowlisted resources from an unrelated cwd and excludes non-SQL source files", () => {
    const f = fixture();
    const publicBundle = bundles[1];
    const nestedResource = path.join(f.source(publicBundle), "references/nested/data.bin");
    mkdirSync(path.dirname(nestedResource), { recursive: true });
    writeFileSync(nestedResource, Buffer.from([0, 1, 127, 255]));
    for (const resource of sqlDirectories) {
      const nestedSql = path.join(f.source(resource), "nested/upgrade-2.sql");
      mkdirSync(path.dirname(nestedSql), { recursive: true });
      writeFileSync(nestedSql, "ALTER TABLE baseline ADD COLUMN upgraded INTEGER;\n");
      for (const relative of ["format.ts", "format.js", "README.md", "nested/private.json"]) {
        writeFileSync(path.join(f.source(resource), relative), "Unpublished source.\n");
      }
    }
    const privateBundle = path.join(f.directory, "src/commands/skill/skills/private-development");
    const repositoryBundle = path.join(f.directory, ".agents/skills/development");
    for (const unlisted of [privateBundle, repositoryBundle]) {
      mkdirSync(unlisted, { recursive: true });
      writeFileSync(path.join(unlisted, "SKILL.md"), "Unpublished repository instructions.\n");
    }
    const compiled = path.join(f.directory, "dist/commands/skill/command.js");
    mkdirSync(path.dirname(compiled), { recursive: true });
    writeFileSync(compiled, "compiled module\n");

    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    for (const bundle of bundles) {
      const sourceFiles = files(f.source(bundle));
      expect(files(f.destination(bundle))).toEqual(sourceFiles);
      for (const relative of sourceFiles) {
        expect(readFileSync(path.join(f.destination(bundle), relative)).equals(readFileSync(path.join(f.source(bundle), relative))), path.join(bundle, relative)).toBe(true);
      }
    }
    for (const resource of sqlDirectories) {
      const sourceFiles = files(f.source(resource)).filter((name) => name.endsWith(".sql"));
      expect(files(f.destination(resource))).toEqual(sourceFiles);
      for (const relative of sourceFiles) {
        expect(readFileSync(path.join(f.destination(resource), relative)).equals(readFileSync(path.join(f.source(resource), relative))), path.join(resource, relative)).toBe(true);
      }
    }
    expect(readFileSync(f.destination(stagedTimelineSql))).toEqual(readFileSync(f.source(stagedTimelineSql)));
    expect(readFileSync(compiled, "utf8")).toBe("compiled module\n");
    expect(existsSync(path.join(f.directory, "dist/commands/skill/skills/private-development"))).toBe(false);
    expect(existsSync(path.join(f.directory, "dist/.agents"))).toBe(false);
  });

  it("preserves installed dist resources and compiled modules when a repeated copy fails", () => {
    const f = fixture();
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    const original = resources.map((resource) => ({
      resource,
      files: files(f.destination(resource)).map((relative) => ({ relative, content: readFileSync(path.join(f.destination(resource), relative)) })),
    }));
    const originalTimelineSql = readFileSync(f.destination(stagedTimelineSql));
    const compiled = path.join(f.directory, "dist/commands/skill/command.js");
    writeFileSync(compiled, "installed compiled module\n");
    for (const resource of resources) {
      for (const relative of files(f.source(resource))) {
        const source = path.join(f.source(resource), relative);
        writeFileSync(source, `${readFileSync(source, "utf8")}\nReplacement resource.\n`);
      }
    }
    writeFileSync(f.source(stagedTimelineSql), `${readFileSync(f.source(stagedTimelineSql), "utf8")}\nReplacement resource.\n`);

    const repeated = f.run();
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toContain("ERR_FS_CP_EEXIST");
    for (const { resource, files: originalFiles } of original) {
      for (const { relative, content } of originalFiles) {
        expect(readFileSync(path.join(f.destination(resource), relative)).equals(content), path.join(resource, relative)).toBe(true);
      }
    }
    expect(readFileSync(f.destination(stagedTimelineSql))).toEqual(originalTimelineSql);
    expect(readFileSync(compiled, "utf8")).toBe("installed compiled module\n");
  });

  it.each(allResources)("rejects a missing %s source before copying any resource", (missing) => {
    const f = fixture(missing);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    for (const resource of allResources) expect(existsSync(f.destination(resource))).toBe(false);
  });

  it("ships valid skill metadata and resolves every local resource link inside each copied bundle", () => {
    const f = fixture();
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    for (const bundle of bundles) {
      const destination = f.destination(bundle);
      const entrypoint = readFileSync(path.join(destination, "SKILL.md"), "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entrypoint);
      expect(frontmatter).not.toBeNull();
      const metadata = parseYaml(frontmatter![1]!) as Record<string, unknown>;
      expect(metadata.name).toBe(path.basename(bundle));
      expect(typeof metadata.description).toBe("string");
      expect((metadata.description as string).trim().length).toBeGreaterThan(0);
      for (const relative of files(destination).filter((name) => name.endsWith(".md"))) {
        const document = path.join(destination, relative);
        const content = readFileSync(document, "utf8");
        let fence: { marker: string; length: number } | undefined;
        const prose = content.split(/\r?\n/).filter((line) => {
          const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
          if (marker !== undefined) {
            if (fence === undefined) fence = { marker: marker[0]!, length: marker.length };
            else if (marker[0] === fence.marker && marker.length >= fence.length && line.trim() === marker) fence = undefined;
            return false;
          }
          return fence === undefined;
        }).join("\n");
        for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
          const target = match[1]!;
          if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
          const resource = path.resolve(path.dirname(document), target.split("#")[0]!);
          const resourceRelative = path.relative(destination, resource);
          expect(resourceRelative === ".." || resourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resourceRelative)).toBe(false);
          expect(existsSync(resource), `${relative} links to missing ${target}`).toBe(true);
        }
      }
    }
  });
});
