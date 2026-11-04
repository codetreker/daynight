import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { inspectInstalledSkill } from "../fixtures/skill-contract.js";
import { loadSqliteSequence } from "../../src/platform/sqlite-sql.js";

const root = path.resolve(import.meta.dirname, "../../../../.tmp/copy-resource-tests");
const packageDirectory = path.resolve(import.meta.dirname, "../..");
const bundles = ["commands/review/skills/daynight-review", "commands/skill/skills/using-daynight"] as const;
const sqlDirectories = [
  "commands/review/sqlite",
  "commands/worker/sqlite",
  "commands/worker/backends/sqlite",
  "commands/controller/sqlite/journal",
  "commands/controller/sqlite/resume-lease",
] as const;
const resources = [...bundles, ...sqlDirectories];
const standaloneManual = "commands/skill/usage.md" as const;
const allResources = [...resources, standaloneManual];
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
  cpSync(path.join(packageDirectory, "scripts/copy-resources.ts"), path.join(scripts, "copy-resources.ts"));
  const source = (resource: Resource) => path.join(directory, "src", resource);
  const destination = (resource: Resource) => path.join(directory, "dist", resource);
  for (const bundle of bundles) {
    if (bundle === missing) continue;
    mkdirSync(path.dirname(source(bundle)), { recursive: true });
    cpSync(path.join(packageDirectory, "src", bundle), source(bundle), { recursive: true });
  }
  if (missing !== standaloneManual) {
    mkdirSync(path.dirname(source(standaloneManual)), { recursive: true });
    cpSync(path.join(packageDirectory, "src", standaloneManual), source(standaloneManual));
  }
  for (const resource of sqlDirectories) {
    if (resource === missing) continue;
    mkdirSync(source(resource), { recursive: true });
    writeFileSync(path.join(source(resource), "001-baseline.sql"), "CREATE TABLE baseline (value TEXT NOT NULL);\n");
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
  });

  it("rejects a directory at the standalone manual path before copying resources", () => {
    const f = fixture(standaloneManual);
    mkdirSync(f.source(standaloneManual), { recursive: true });
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Resource source is not a file: commands/skill/usage.md");
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
    writeFileSync(f.source(standaloneManual), readFileSync(f.source(standaloneManual), "utf8").replaceAll("\r\n", "\n").replaceAll("\n", lineEnding));
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    expect(readFileSync(f.destination(standaloneManual))).toEqual(readFileSync(f.source(standaloneManual)));
    for (const resource of resources) {
      const sourceFiles = files(f.source(resource));
      expect(files(f.destination(resource))).toEqual(sourceFiles);
      for (const relative of sourceFiles) {
        expect(readFileSync(path.join(f.destination(resource), relative))).toEqual(readFileSync(path.join(f.source(resource), relative)));
      }
    }
    await inspectInstalledSkill(f.destination(bundles[1]));
  });

  it("rejects packaging the renamed managed reference under its old name", async () => {
    const f = fixture();
    const source = f.source(bundles[1]);
    writeFileSync(path.join(source, "references/execute-task-in-managed.md"), "Obsolete managed entrypoint.\n");
    const copied = f.run();
    expect(copied.status, copied.stderr).toBe(0);
    await expect(inspectInstalledSkill(f.destination(bundles[1]))).rejects.toThrow("The renamed managed entrypoint is not packaged under its old name");
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
        expect(readFileSync(path.join(f.destination(bundle), relative))).toEqual(readFileSync(path.join(f.source(bundle), relative)));
      }
    }
    for (const resource of sqlDirectories) {
      const sourceFiles = files(f.source(resource)).filter((name) => name.endsWith(".sql"));
      expect(files(f.destination(resource))).toEqual(sourceFiles);
      for (const relative of sourceFiles) {
        expect(readFileSync(path.join(f.destination(resource), relative))).toEqual(readFileSync(path.join(f.source(resource), relative)));
      }
    }
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
    const compiled = path.join(f.directory, "dist/commands/skill/command.js");
    writeFileSync(compiled, "installed compiled module\n");
    for (const resource of resources) {
      for (const relative of files(f.source(resource))) writeFileSync(path.join(f.source(resource), relative), "replacement resource\n");
    }

    const repeated = f.run();
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toContain("ERR_FS_CP_EEXIST");
    for (const { resource, files: originalFiles } of original) {
      for (const { relative, content } of originalFiles) {
        expect(readFileSync(path.join(f.destination(resource), relative))).toEqual(content);
      }
    }
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
