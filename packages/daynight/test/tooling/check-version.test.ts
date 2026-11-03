import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkVersion } from "../../scripts/check-version.js";
import { writeGitSnapshot } from "../helpers/git-objects.js";

const fixtures = path.resolve(import.meta.dirname, "../../../../.tmp/version-tests");
const script = path.resolve(import.meta.dirname, "../../scripts/check-version.ts");
const directories: string[] = [];
let seedDirectory: string | undefined;
let seed: { directory: string; base: string } | undefined;
const manifest = "packages/daynight/package.json";
const source = "packages/daynight/src/中文 file.ts";
const zeroSha = "0".repeat(40);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
type Files = Record<string, string>;
const files = (version: unknown = "1.0.0"): Files => ({ [manifest]: JSON.stringify({ name: "@codetreker/daynight", version }), [source]: "export const value = 1;\n" });
const repository = (directory: string) => {
  const git = (args: string[], input?: string): string => execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", env: environment, timeout: 20_000, ...(input === undefined ? {} : { input }), stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  const commit = (contents: Files, ...parents: string[]): string => writeGitSnapshot(git,
    Object.entries(contents).map(([filename, contentsValue]) => ({ path: filename, mode: "100644", contents: contentsValue })), "Version fixture\n", parents);
  return { directory, commit, git, check: (event: string, base: string, head: string) => checkVersion(event, base, head, directory) };
};

beforeAll(() => {
  mkdirSync(fixtures, { recursive: true });
  const directory = mkdtempSync(path.join(fixtures, "source-template "));
  seedDirectory = directory;
  const sourceRepository = repository(directory);
  sourceRepository.git(["init", "--bare", "--initial-branch=main"]);
  seed = { directory, base: sourceRepository.commit(files()) };
});
const fixture = () => {
  if (seed === undefined) throw new Error("Version fixtures must be initialized before use.");
  const directory = mkdtempSync(path.join(fixtures, "Version 中文 "));
  directories.push(directory);
  const upstream = path.join(directory, "source.git");
  cpSync(seed.directory, upstream, { recursive: true, force: false, errorOnExist: true });
  return { ...repository(upstream), base: seed.base };
};

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
afterAll(() => { if (seedDirectory !== undefined) rmSync(seedDirectory, { recursive: true, force: true }); seedDirectory = undefined; seed = undefined; });

describe("release version gate", () => {
  it("requires a code change to increase the version read from Git, independently of checkout files", () => {
    const f = fixture();
    const base = f.base;
    const unchanged = f.commit({ ...files(), [source]: "export const value = 2;\n" }, base);
    expect(() => f.check("pull_request", base, unchanged)).toThrow(`${manifest} version above 1.0.0; HEAD version is 1.0.0`);
    const increased = f.commit({ ...files("1.0.1"), [source]: "export const value = 2;\n" }, base);
    expect(f.check("pull_request", base, increased)).toContain("1.0.0 -> 1.0.1");
  });

  it("exempts documents, tests, workflows, and validation scripts", () => {
    const f = fixture();
    const base = f.base;
    const head = f.commit({ ...files(), "README.md": "docs", "packages/daynight/test/example.test.ts": "test", ".github/workflows/checks.yml": "workflow", "packages/daynight/scripts/check-version.ts": "script" }, base);
    expect(f.check("pull_request", base, head)).toContain("No release inputs changed");
  });

  it.each(["delete", "move outside source"])("detects a source %s with rename detection disabled", (action) => {
    const f = fixture();
    const initial = files();
    const base = f.base;
    const changed = Object.fromEntries(Object.entries(initial).filter(([name]) => name !== source));
    if (action === "move outside source") changed["docs/moved.ts"] = initial[source]!;
    const head = f.commit(changed, base);
    expect(() => f.check("push", base, head)).toThrow("Release inputs changed");
  });

  it.each(["packages/daynight/tsconfig.json", "packages/daynight/tsconfig.build.json", "packages/daynight/scripts/clean-dist.ts", "packages/daynight/scripts/copy-skills.ts", "packages/daynight/scripts/copy-resources.ts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"])("requires an increase for build or dependency input %s", (filename) => {
    const f = fixture();
    const base = f.base;
    const head = f.commit({ ...files(), [filename]: "changed" }, base);
    expect(() => f.check("push", base, head)).toThrow("Release inputs changed");
  });

  it.each(["1.0.0", "0.9.9", "1.0.0+build.2"])("rejects non-increasing version %s", (version) => {
    const f = fixture();
    const base = f.base;
    const head = f.commit({ ...files(version), [source]: "changed" }, base);
    expect(() => f.check("push", base, head)).toThrow(`HEAD version is ${version}`);
  });

  it("checks manifest-only changes and semantic prerelease precedence", () => {
    const f = fixture();
    const base = f.commit(files("1.1.0-beta.2"));
    const older = f.commit(files("1.1.0-beta.1"), base);
    const newer = f.commit(files("1.1.0-beta.10"), base);
    const stable = f.commit(files("1.1.0"), base);
    expect(() => f.check("push", base, older)).toThrow("Release inputs changed");
    expect(f.check("push", base, newer)).toContain("1.1.0-beta.2 -> 1.1.0-beta.10");
    expect(f.check("push", base, stable)).toContain("1.1.0-beta.2 -> 1.1.0");
    const metadata = f.commit({ ...files("1.1.0-beta.2"), [manifest]: JSON.stringify({ name: "renamed", version: "1.1.0-beta.2" }) }, base);
    expect(() => f.check("push", base, metadata)).toThrow("Release inputs changed");
  });

  it("ignores base-only code/version changes when a PR changes only documents", () => {
    const f = fixture();
    const common = f.base;
    const base = f.commit({ ...files("1.0.1"), [source]: "base-only source" }, common);
    const head = f.commit({ ...files(), "README.md": "PR documentation" }, common);
    expect(f.check("pull_request", base, head)).toContain("No release inputs changed");
  });

  it("rejects a PR version increase already consumed by the current target branch", () => {
    const f = fixture();
    const common = f.base;
    const base = f.commit(files("1.0.1"), common);
    const head = f.commit({ ...files("1.0.1"), [source]: "PR code" }, common);
    expect(() => f.check("pull_request", base, head)).toThrow("version above 1.0.1");
    expect(f.check("pull_request", base, f.commit({ ...files("1.0.2"), [source]: "PR code" }, head))).toContain("1.0.1 -> 1.0.2");
  });

  it("checks the complete multi-commit push rather than only the final commit", () => {
    const f = fixture();
    const base = f.base;
    const intermediate = f.commit({ ...files(), [source]: "changed in first pushed commit" }, base);
    const head = f.commit({ ...files(), [source]: "changed in first pushed commit", "README.md": "last pushed commit" }, intermediate);
    expect(() => f.check("push", base, head)).toThrow("Release inputs changed");
  });

  it("initializes only a push with an all-zero base and a valid head manifest", () => {
    const f = fixture();
    const head = f.base;
    expect(f.check("push", zeroSha, head)).toContain("Initialized");
    expect(() => f.check("pull_request", zeroSha, head)).toThrow("existing commits");
    expect(() => f.check("push", head, zeroSha)).toThrow("existing commits");
    expect(() => f.check("push", zeroSha, f.commit(files("invalid")))).toThrow("valid semantic version");
  });

  it("exposes missing objects, missing manifests, invalid versions, and unrelated histories", () => {
    const f = fixture();
    const base = f.base;
    expect(() => f.check("push", base, "f".repeat(40))).toThrow();
    expect(() => f.check("push", base, f.commit({ [source]: "missing manifest" }, base))).toThrow();
    expect(() => f.check("push", base, f.commit(files(42), base))).toThrow("valid semantic version");
    expect(() => f.check("push", f.commit(files("invalid")), base)).toThrow("valid semantic version");
    expect(() => f.check("pull_request", base, f.commit({ ...files(), "README.md": "unrelated root" }))).toThrow();
    expect(() => f.check("push", base, f.git(["hash-object", "-w", "--stdin"], "blob"))).toThrow("Expected a Git commit");
  });

  it("validates CLI arguments and reports successful or failed checks to callers", () => {
    const f = fixture();
    const base = f.base;
    const head = f.commit({ ...files(), [source]: "changed" }, base);
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: f.directory, env: environment, encoding: "utf8", timeout: 20_000 });
    const success = run("push", zeroSha, base);
    expect(success.status).toBe(0);
    expect(success.stdout).toContain("Initialized");
    const failure = run("push", base, head);
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain(`${manifest} version above 1.0.0`);
    for (const args of [[], ["push", base, head, "extra"]]) {
      const result = run(...args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Usage:");
    }
    expect(() => f.check("schedule", base, head)).toThrow("Unsupported version-check event");
    expect(() => f.check("push", "main", head)).toThrow("full 40-character Git");
  });
});
