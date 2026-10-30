import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { detectModules, pullRequestPaths, selectModules, type ModuleSelection } from "./ci-modules.mts";

const none = { cli: false, server: false, web: false };
const all = { cli: true, server: true, web: true };
const root = fileURLToPath(new URL("../../", import.meta.url));

for (const [path, expected] of [
  ["packages/daynight/src/main.ts", { ...none, cli: true }],
  ["packages/daynight/src/.gitignore", { ...none, cli: true }],
  ["packages/daynight/src/commands/review/skills/daynight-review/SKILL.md", { ...none, cli: true }],
  ["packages/daynight/src/commands/review/skills/daynight-review/README.md", { ...none, cli: true }],
  ["packages/daynight/src/commands/review/skills/daynight-review/AGENTS.md", { ...none, cli: true }],
  ["packages/daynight/src/README.md", { ...none, cli: true }],
  ["packages/daynight/test/tooling/check-version.test.ts", { ...none, cli: true }],
  ["packages/daynight/test/fixtures/installed-cli.ts", all],
  ["packages/daynight-server/internal/server/tasks.go", { ...none, server: true }],
  ["packages/daynight-server/.gitignore", { ...none, server: true }],
  ["packages/daynight-web/src/App.vue", { ...none, web: true }],
  ["packages/daynight-web/.gitignore", { ...none, web: true }],
  ["deployment/localhost/Dockerfile", { ...none, web: true }],
  ["deployment/dev-ci/tests/run.sh", { ...none, web: true }],
  ["patches/@dagrejs__dagre@3.1.1.patch", { ...none, web: true }],
  ["patches/@xyflow__system@0.0.83.patch", { ...none, web: true }],
  ["README.md", none],
  [".gitignore", none],
  ["packages/daynight/README.md", none],
  ["packages/daynight-web/README.md", none],
  ["packages/daynight-server/internal/AGENTS.md", none],
  ["CLAUDE.md", none],
  ["deployment/dev-ci/README.md", none],
  ["docs/research/evidence/daynight-web-lifecycle.json", none],
  [".agents/skills/beads/agents/openai.yaml", none],
  [".claude/settings.json", none],
  [".github/workflows/publish.yml", none],
  ["package.json", all],
  ["pnpm-lock.yaml", all],
  ["pnpm-workspace.yaml", all],
  [".npmrc", all],
  ["patches/future-cli-dependency.patch", all],
  ["packages/future-module/src/main.ts", all],
  [".github/workflows/checks.yml", all],
  [".github/workflows/future.yml", all],
  [".github/scripts/ci-modules.mts", all],
  [".github/scripts/ci-modules.test.mts", all],
  ["unknown-runtime.md", all],
  ["unknown/.gitignore", all],
] satisfies Array<[string, ModuleSelection]>) {
  test(`routes ${path}`, () => assert.deepEqual(selectModules([path]), expected));
}

test("combines module ownership without making documentation select a module", () => {
  assert.deepEqual(selectModules(["docs/spec/daynight-web.md", "packages/daynight/src/main.ts", "packages/daynight-web/package.json"]), { ...all, server: false });
  assert.deepEqual(selectModules([]), none);
});

test("the shared installed CLI fixture validates all of its consumers", () => {
  for (const paths of [
    ["packages/daynight/test/fixtures/installed-cli.ts"],
    ["docs/spec/daynight-task-attachments.md", "packages/daynight/test/fixtures/installed-cli.ts"],
    ["packages/daynight-web/tests/e2e/attachments.spec.ts", "packages/daynight/test/fixtures/installed-cli.ts"],
  ]) assert.deepEqual(selectModules(paths), all);
});

test("root ignore rules do not change other paths' module selection", () => {
  for (const path of ["docs/spec/daynight-web.md", "packages/daynight/src/main.ts", "packages/daynight-server/main.go", "packages/daynight-web/src/App.tsx", "pnpm-lock.yaml", "unknown-runtime.md"]) {
    const expected = selectModules([path]);
    assert.deepEqual(selectModules([".gitignore", path]), expected);
    assert.deepEqual(selectModules([path, ".gitignore"]), expected);
  }
});

const repository = (t: TestContext) => {
  const temporary = join(root, ".tmp");
  mkdirSync(temporary, { recursive: true });
  const cwd = mkdtempSync(join(temporary, "ci-routing-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "maintenance.auto", "false");
  git("config", "user.name", "CI routing tests");
  git("config", "user.email", "ci-routing@example.invalid");
  const write = (path: string, content = path): void => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const commit = () => {
    git("add", "--all");
    git("commit", "-m", "Record fixture state");
    return git("rev-parse", "HEAD");
  };
  write("README.md", "fixture\n");
  const base = commit();
  return { cwd, git, write, commit, base };
};

test("a PR changing only root ignore rules selects no application jobs", async (t) => {
  const repo = repository(t);
  repo.write(".gitignore", ".tmp/\n");
  const base = repo.commit();
  repo.write(".gitignore", ".tmp/\n/.daynight/\n");
  const head = repo.commit();
  assert.deepEqual(await pullRequestPaths(repo.cwd, base, head), [".gitignore"]);
  assert.deepEqual(await detectModules({ event: "pull_request", cwd: repo.cwd, base, head }), none);
});

test("uses the explicit PR head and merge base when the target branch advances", async (t) => {
  const repo = repository(t);
  repo.git("checkout", "-b", "feature");
  repo.write("packages/daynight/src/main.ts");
  const head = repo.commit();
  repo.git("checkout", "main");
  repo.write("packages/daynight-web/src/App.vue");
  const base = repo.commit();
  repo.git("merge", "--no-ff", "feature", "-m", "Merge fixture feature");
  assert.notEqual(repo.git("rev-parse", "HEAD"), head);
  assert.deepEqual(await pullRequestPaths(repo.cwd, base, head), ["packages/daynight/src/main.ts"]);
  assert.deepEqual(await detectModules({ event: "pull_request", cwd: repo.cwd, base, head }), { ...none, cli: true });
});

test("counts both sides of cross-module renames and source moves into documentation", async (t) => {
  const repo = repository(t);
  repo.write("packages/daynight/src/moved.ts", "same content\n");
  repo.write("packages/daynight-server/deleted.go", "package fixture\n");
  const base = repo.commit();
  mkdirSync(join(repo.cwd, "packages/daynight-web/src"), { recursive: true });
  renameSync(join(repo.cwd, "packages/daynight/src/moved.ts"), join(repo.cwd, "packages/daynight-web/src/moved.ts"));
  mkdirSync(join(repo.cwd, "docs"), { recursive: true });
  renameSync(join(repo.cwd, "packages/daynight-server/deleted.go"), join(repo.cwd, "docs/moved.md"));
  const head = repo.commit();
  const paths = await pullRequestPaths(repo.cwd, base, head);
  assert.deepEqual(new Set(paths), new Set(["packages/daynight/src/moved.ts", "packages/daynight-web/src/moved.ts", "packages/daynight-server/deleted.go", "docs/moved.md"]));
  assert.deepEqual(selectModules(paths), all);
});

test("retains deleted module paths", async (t) => {
  const repo = repository(t);
  repo.write("packages/daynight-server/deleted.go");
  const base = repo.commit();
  rmSync(join(repo.cwd, "packages/daynight-server/deleted.go"));
  const head = repo.commit();
  assert.deepEqual(await detectModules({ event: "pull_request", cwd: repo.cwd, base, head }), { ...none, server: true });
});

test("retains whitespace, newlines, unicode, and leading dashes in Git paths", async (t) => {
  const repo = repository(t);
  const paths = ["packages/daynight-web/src/a b.ts", "packages/daynight-web/src/tab\tfile.ts", "packages/daynight-web/src/line\nbreak.ts", "packages/daynight-web/src/中文.ts", "packages/daynight-web/src/-flag.ts"];
  for (const path of paths) repo.write(path);
  const head = repo.commit();
  assert.deepEqual(new Set(await pullRequestPaths(repo.cwd, repo.base, head)), new Set(paths));
  assert.deepEqual(await detectModules({ event: "pull_request", cwd: repo.cwd, base: repo.base, head }), { ...none, web: true });
});

test("reads the complete change list beyond API file limits", async (t) => {
  const repo = repository(t);
  for (let i = 0; i < 3_100; i++) repo.write(`docs/generated/${i}.md`);
  repo.write("packages/daynight-server/last.go");
  const head = repo.commit();
  const paths = await pullRequestPaths(repo.cwd, repo.base, head);
  assert.equal(paths.length, 3_101);
  assert.deepEqual(selectModules(paths), { ...none, server: true });
});

test("pushes always run the complete workload", async () => {
  assert.deepEqual(await detectModules({ event: "push" }), all);
});

test("an unchanged PR selects no application workload", async (t) => {
  const repo = repository(t);
  assert.deepEqual(await pullRequestPaths(repo.cwd, repo.base, repo.base), []);
  assert.deepEqual(await detectModules({ event: "pull_request", cwd: repo.cwd, base: repo.base, head: repo.base }), none);
});

test("rejects unknown events, malformed SHAs, and unavailable commits", async (t) => {
  const repo = repository(t);
  await assert.rejects(detectModules({ event: "workflow_dispatch" }), /Unsupported CI event/);
  for (const base of [undefined, "main", "0".repeat(40), "-".repeat(40)]) {
    await assert.rejects(pullRequestPaths(repo.cwd, base, repo.base), /full 40-character/);
  }
  await assert.rejects(pullRequestPaths(repo.cwd, repo.base, "f".repeat(40)), /git cat-file failed/);
});

test("command entry point writes module selections to GitHub outputs", async (t) => {
  const repo = repository(t);
  repo.write("packages/daynight-server/server.go");
  const head = repo.commit();
  const script = join(root, ".github/scripts/ci-modules.mts");
  const output = join(repo.cwd, "github-output");
  execFileSync(process.execPath, [script], {
    cwd: repo.cwd,
    env: { ...process.env, MODULE_EVENT: "pull_request", MODULE_BASE: repo.base, MODULE_HEAD: head, GITHUB_OUTPUT: output },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(readFileSync(output, "utf8"), "cli=false\nserver=true\nweb=false\n");
});
