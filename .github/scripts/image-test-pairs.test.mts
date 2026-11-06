import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { validatePairs, parseManifest, type GitHubSource } from "./image-test-pairs.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const testPath = "packages/daynight/test/session/images.test.ts";
const content = 'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\n';

const fixture = (t: TestContext, change?: (repo: { cwd: string; write: (path: string, bytes: string) => void; git: (...args: string[]) => string }) => void, baseSetup?: (write: (path: string, bytes: string) => void) => void) => {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const cwd = mkdtempSync(join(root, ".tmp/image-pairs-test-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  const write = (path: string, bytes: string) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), bytes); };
  const commit = () => { git("add", "--all"); git("commit", "-m", "Fixture revision"); return git("rev-parse", "HEAD"); };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Image pair fixture");
  git("config", "user.email", "pair@example.invalid");
  git("config", "maintenance.auto", "false");
  write(".gitignore", ".tmp/\n");
  write("packages/daynight/src/value.ts", "export const value = 1;\n");
  baseSetup?.(write);
  const base = commit();
  git("checkout", "-b", "implementation");
  write("packages/daynight/src/value.ts", "export const value = 2;\n");
  const implementation = commit();
  const productionTree = git("rev-parse", `${implementation}^{tree}`);
  git("checkout", "-b", "tests");
  if (change) change({ cwd, write, git }); else write(testPath, content);
  const tests = commit();
  const pair = { base, implementation: { pr: 11, sha: implementation, reviews: [101] }, tests: { pr: 12, sha: tests, reviews: [102] }, productionTree, allowPaths: [testPath] };
  const manifest = { schemaVersion: 1, pairs: [pair] };
  let manifestCommit: string;
  const saveManifest = () => {
    git("checkout", "-B", "ci/image-test-pairs", base);
    write("image-test-pairs.json", JSON.stringify(manifest));
    manifestCommit = commit();
    git("checkout", "--detach", implementation);
    return manifestCommit;
  };
  saveManifest();
  const author = (id: number) => ({ id, login: `user-${id}`, type: "User" });
  const prs: Record<number, any> = {
    11: { number: 11, state: "open", merged: false, head: { sha: implementation, repo: { full_name: "owner/repository" } }, base: { ref: "main", sha: base, repo: { full_name: "owner/repository" } }, user: author(1) },
    12: { number: 12, state: "open", merged: false, head: { sha: tests, repo: { full_name: "owner/repository" } }, base: { ref: "implementation", sha: implementation, repo: { full_name: "owner/repository" } }, user: author(2) },
  };
  const reviews: Record<number, any[]> = {
    11: [{ id: 101, state: "APPROVED", commit_id: implementation, user: author(3), submitted_at: "2026-01-01T00:00:00Z" }],
    12: [{ id: 102, state: "APPROVED", commit_id: tests, user: author(4), submitted_at: "2026-01-01T00:00:00Z" }],
  };
  let rules = [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }];
  const requests: string[] = [];
  const source: GitHubSource = { async get(path) {
    requests.push(path);
    if (path === "/git/ref/heads/ci/image-test-pairs") return { object: { type: "commit", sha: manifestCommit } };
    if (path === "/rules/branches/ci%2Fimage-test-pairs") return rules;
    const match = /^\/pulls\/(\d+)(\/reviews\?per_page=100&page=1)?$/.exec(path);
    if (match) return structuredClone(match[2] ? reviews[Number(match[1])] : prs[Number(match[1])]);
    throw new Error(`Unexpected API request ${path}`);
  } };
  const run = (options: Record<string, unknown> = {}) => validatePairs({ cwd, manifestCommit, event: "pull_request", head: implementation, pr: 11, repository: "owner/repository", source, ...options });
  return { cwd, git, write, commit, base, implementation, tests, pair, manifest, saveManifest, prs, reviews, requests, source, run, setRules: (next: typeof rules) => { rules = next; } };
};

test("composes reviewed tests onto I in a clean checkout while preserving production files", async (t) => {
  const f = fixture(t);
  const before = f.git("rev-parse", "HEAD");
  const result = await f.run();
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content);
  assert.equal(readFileSync(join(f.cwd, "packages/daynight/src/value.ts"), "utf8"), "export const value = 2;\n");
  assert.notEqual(f.git("rev-parse", "HEAD"), before);
  assert.equal(result.checkoutCommit, before);
  assert.equal(result.combinedCommit, f.git("rev-parse", "HEAD"));
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(result.productionTree, f.pair.productionTree);
  assert.equal(result.combinedTree, f.git("rev-parse", `${f.tests}^{tree}`));
  assert.equal(result.changedTestFiles, 1);
  assert.equal(f.requests.filter((path) => path.includes("/git/ref/")).length, 1);
  assert.equal(JSON.parse(readFileSync(join(f.cwd, ".tmp/image-test-pairs.json"), "utf8")).implementation, f.implementation);
});

test("T PR consumes the same reviewed combination", async (t) => {
  const f = fixture(t);
  f.git("checkout", "--detach", f.tests);
  const result = await f.run({ head: f.tests, pr: 12 });
  assert.equal(result.combinedTree, f.git("rev-parse", `${f.tests}^{tree}`));
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content);
});

test("squash-merged I main window receives the original approved T bytes", async (t) => {
  const f = fixture(t);
  f.git("checkout", "main");
  f.git("merge", "--squash", "implementation");
  f.git("commit", "-m", "Squashed implementation");
  const main = f.git("rev-parse", "HEAD");
  assert.notEqual(main, f.implementation);
  f.prs[11].state = "closed";
  f.prs[11].merged = true;
  const result = await f.run({ event: "push", head: main, pr: undefined });
  assert.equal(result.combinedTree, f.git("rev-parse", `${f.tests}^{tree}`));
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content);
});

test("final integrated main validates its already-present tests without overlay", async (t) => {
  const f = fixture(t);
  f.git("checkout", "--detach", f.tests);
  for (const pr of Object.values(f.prs)) { pr.state = "closed"; pr.merged = true; }
  const result = await f.run({ event: "push", head: f.tests, pr: undefined });
  assert.equal(result.combinedTree, f.git("rev-parse", `${f.tests}^{tree}`));
  assert.equal(f.git("status", "--porcelain"), "");
});

test("an explicitly protected empty manifest leaves ordinary CI unchanged", async (t) => {
  const f = fixture(t);
  f.manifest.pairs = [];
  f.saveManifest();
  const result = await f.run();
  assert.equal(result.pairCount, 0);
  assert.equal(result.combinedTree, f.git("rev-parse", "HEAD^{tree}"));
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

for (const [label, update, pattern] of [
  ["remote I HEAD drift", (f: ReturnType<typeof fixture>) => { f.prs[11].head.sha = "a".repeat(40); }, /HEAD/],
  ["remote T HEAD drift", (f: ReturnType<typeof fixture>) => { f.prs[12].head.sha = "a".repeat(40); }, /HEAD/],
  ["dismissed pinned review", (f: ReturnType<typeof fixture>) => { f.reviews[12][0].state = "DISMISSED"; }, /review/i],
  ["wrong review commit", (f: ReturnType<typeof fixture>) => { f.reviews[12][0].commit_id = f.base; }, /review/i],
  ["candidate author's review", (f: ReturnType<typeof fixture>) => { f.reviews[12][0].user = f.prs[11].user; }, /independent/i],
  ["current change request", (f: ReturnType<typeof fixture>) => { f.reviews[12].push({ ...f.reviews[12][0], id: 103, user: { id: 9, login: "reviewer-9", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z" }); }, /review/i],
  ["missing ref update protection", (f: ReturnType<typeof fixture>) => { f.setRules([{ type: "deletion" }, { type: "non_fast_forward" }]); }, /protect/i],
  ["missing ref deletion protection", (f: ReturnType<typeof fixture>) => { f.setRules([{ type: "update" }, { type: "non_fast_forward" }]); }, /protect/i],
  ["missing ref force-push protection", (f: ReturnType<typeof fixture>) => { f.setRules([{ type: "update" }, { type: "deletion" }]); }, /protect/i],
] as const) test(`refuses ${label} before materializing candidate bytes`, async (t) => {
  const f = fixture(t); update(f);
  await assert.rejects(f.run(), pattern);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("fails closed when the protected source cannot be read", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ source: { get: async () => { throw new Error("permission denied"); } } }), /permission denied/);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("rejects production drift during the I-to-T main window", async (t) => {
  const f = fixture(t);
  f.write("packages/daynight/src/other.ts", "export const other = true;\n");
  const main = f.commit();
  f.prs[11].state = "closed"; f.prs[11].merged = true;
  await assert.rejects(f.run({ event: "push", head: main, pr: undefined }), /production|matching/i);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

for (const path of ["packages/daynight/src/evil.test.ts", "package.json", ".github/workflows/checks.yml", "packages/daynight/vitest.config.ts", "packages/daynight/test/package.json", "packages/daynight-web/src/evil.ts", "packages/daynight-server/internal/evil.go"]) {
  test(`refuses an allowlist claiming forbidden path ${path}`, async (t) => {
    const f = fixture(t, ({ write }) => write(path, "forbidden\n"));
    f.pair.allowPaths = [path]; f.saveManifest();
    await assert.rejects(f.run(), /path|test|forbidden/i);
  });
}

test("rejects a symlink masquerading as an allowed test", async (t) => {
  const f = fixture(t, ({ cwd }) => { mkdirSync(dirname(join(cwd, testPath)), { recursive: true }); symlinkSync("../../src/value.ts", join(cwd, testPath)); });
  await assert.rejects(f.run(), /regular|mode|symlink/i);
});

test("rejects a production edit hidden beside an allowed new test", async (t) => {
  const f = fixture(t, ({ write }) => { write(testPath, content); write("packages/daynight/src/value.ts", "export const value = 99;\n"); });
  await assert.rejects(f.run(), /path|production/i);
});

test("rejects a false production tree even when candidate bytes are otherwise valid", async (t) => {
  const f = fixture(t); f.pair.productionTree = f.git("rev-parse", `${f.base}^{tree}`); f.saveManifest();
  await assert.rejects(f.run(), /production/i);
});

test("rejects missing pins, unknown fields and duplicate pair identities", () => {
  assert.throws(() => parseManifest({ schemaVersion: 1, pairs: [], command: "echo unsafe" }), /field|key/i);
  assert.throws(() => parseManifest({ schemaVersion: 2, pairs: [] }), /version/i);
});

test("refuses an unrelated PR while a required pair is registered", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ pr: 13 }), /matching|registered/i);
});

test("does not overwrite untracked local test files", async (t) => {
  const f = fixture(t); f.write(testPath, "local work\n");
  await assert.rejects(f.run(), /clean|untracked|overwrite/i);
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), "local work\n");
});

test("missing manifest pin fails before any network request", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ manifestCommit: "" }), /SHA|commit/i);
  assert.equal(f.requests.length, 0);
});


test("combination commits have deterministic identities across independent jobs", async (t) => {
  const f = fixture(t);
  const first = await f.run();
  f.git("checkout", "--detach", f.implementation);
  const second = await f.run({ expectedCombinedTree: first.combinedTree });
  assert.equal(first.combinedCommit, second.combinedCommit);
  assert.equal(first.combinedTree, second.combinedTree);
});

test("rejects a changed detection-job combination before materializing tests", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ expectedCombinedTree: f.pair.productionTree }), /detection job/);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
  assert.equal(f.git("rev-parse", "HEAD"), f.implementation);
});


test("a comment cannot clear a nonpinned reviewer's change request", async (t) => {
  const f = fixture(t);
  const reviewer = { id: 9, login: "reviewer-9", type: "User" };
  f.reviews[12].push({ ...f.reviews[12][0], id: 103, user: reviewer, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z" });
  f.reviews[12].push({ ...f.reviews[12][0], id: 104, user: reviewer, state: "COMMENTED", submitted_at: "2026-01-03T00:00:00Z" });
  await assert.rejects(f.run(), /change-request review/);
});

test("an ordinary comment preserves a pinned approval decision", async (t) => {
  const f = fixture(t);
  f.reviews[12].push({ ...f.reviews[12][0], id: 103, state: "COMMENTED", submitted_at: "2026-01-02T00:00:00Z" });
  const result = await f.run();
  assert.equal(result.tests, f.tests);
});

const existingTestPair = (f: ReturnType<typeof fixture>, before: string, after: string | null) => {
  f.git("checkout", "--detach", f.implementation);
  f.write(testPath, before);
  const implementation = f.commit();
  if (after === null) rmSync(join(f.cwd, testPath)); else f.write(testPath, after);
  const tests = f.commit();
  f.pair.implementation.sha = implementation; f.pair.tests.sha = tests;
  f.prs[11].head.sha = implementation; f.prs[12].head.sha = tests; f.prs[12].base.sha = implementation;
  f.reviews[11][0].commit_id = implementation; f.reviews[12][0].commit_id = tests;
  f.saveManifest(); f.git("checkout", "--detach", implementation);
  return implementation;
};

test("preserves existing assertions while adding independently reviewed tests", async (t) => {
  const f = fixture(t);
  const head = existingTestPair(f, content, `${content}assert.equal(3 * 3, 9);\n`);
  const result = await f.run({ head });
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), `${content}assert.equal(3 * 3, 9);\n`);
  assert.equal(result.productionTree, f.pair.productionTree);
  assert.equal(f.git("status", "--porcelain"), "");
});

for (const [label, before, after] of [
  ["deleted test", content, null],
  ["weakened assertion", content, content.replace("assert.equal(2 + 2, 4);", "assert.ok(true);")],
  ["removed decrement statement resembling a diff header", "-- value;\nassert.equal(value, 1);\n", "assert.equal(value, 1);\n"],
  ["changed binary fixture", "\0old", "\0new"],
] as const) test(`rejects ${label}`, async (t) => {
  const f = fixture(t);
  const head = existingTestPair(f, before, after);
  await assert.rejects(f.run({ head }), /regular|deleted|weakened/);
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), before);
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("rejects a commit pin outside the protected ref history", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ manifestCommit: f.tests }), /protected ref/);
});

test("rejects a tree object supplied as the manifest commit", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ manifestCommit: f.pair.productionTree }), /wrong object type/);
});

test("rejects duplicate PR identity and production-tree manifest records", async (t) => {
  const f = fixture(t);
  f.manifest.pairs.push(structuredClone(f.pair));
  f.saveManifest();
  await assert.rejects(f.run(), /Duplicate/);
});

test("rejects unsafe relative paths and unrecognized manifest fields", async (t) => {
  const f = fixture(t);
  for (const path of ["../escape.test.ts", "packages/daynight/test/../../src/evil.ts", "packages/daynight/test/a\\b.test.ts", "packages/daynight/test/a\n.test.ts", "packages/daynight/test/.hidden.test.ts"]) {
    const manifest = structuredClone(f.manifest); manifest.pairs[0]!.allowPaths = [path];
    assert.throws(() => parseManifest(manifest), /path/);
  }
  const manifest: any = structuredClone(f.manifest); manifest.pairs[0].implementation.command = "unsafe";
  assert.throws(() => parseManifest(manifest), /fields/);
});

test("rejects unavailable I and broken base ancestry before composition", async (t) => {
  const f = fixture(t);
  f.pair.base = f.tests; f.saveManifest();
  await assert.rejects(f.run(), /ancestor/);
});

test("main cannot adopt an unmerged implementation's tests", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ event: "push", head: f.implementation, pr: undefined }), /has not merged/);
});

test("merged T cannot be overlaid onto a main tree missing its tests", async (t) => {
  const f = fixture(t);
  for (const pr of Object.values(f.prs)) { pr.state = "closed"; pr.merged = true; }
  await assert.rejects(f.run({ event: "push", head: f.implementation, pr: undefined }), /already be present/);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("PR event identity cannot substitute a different candidate SHA", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ head: f.tests }), /Event HEAD/);
});

test("a different repository cannot supply a candidate", async (t) => {
  const f = fixture(t); f.prs[12].head.repo.full_name = "attacker/repository";
  await assert.rejects(f.run(), /configured repository/);
});

test("a closed unmerged candidate is revoked", async (t) => {
  const f = fixture(t); f.prs[12].state = "closed";
  await assert.rejects(f.run(), /closed without merging/);
});

test("preserves untracked work and rejects a tracked dirty checkout", async (t) => {
  const f = fixture(t); f.write("packages/daynight/src/value.ts", "local changes\n");
  await assert.rejects(f.run(), /clean tracked checkout/);
  assert.equal(readFileSync(join(f.cwd, "packages/daynight/src/value.ts"), "utf8"), "local changes\n");
});

test("rejects symlink ancestors created outside Git", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, ".tmp/outside"), { recursive: true });
  mkdirSync(join(f.cwd, "packages/daynight/test"), { recursive: true });
  symlinkSync(join(f.cwd, ".tmp/outside"), join(f.cwd, "packages/daynight/test/session"));
  await assert.rejects(f.run(), /Unsafe test parent/);
  assert.equal(existsSync(join(f.cwd, ".tmp/outside/images.test.ts")), false);
});


test("rejects T retargeting that exposes implementation files in the actual PR diff", async (t) => {
  const f = fixture(t);
  f.git("checkout", "main");
  f.git("merge", "--squash", "implementation");
  f.git("commit", "-m", "Squashed implementation");
  f.prs[12].base = { ...f.prs[12].base, ref: "main", sha: f.git("rev-parse", "HEAD") };
  f.git("checkout", "--detach", f.implementation);
  await assert.rejects(f.run(), /actual test PR diff/);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});


test("Git filters cannot receive validation credentials or transform candidate test bytes", async (t) => {
  const f = fixture(t, undefined, (write) => write(".gitattributes", "*.ts filter=credential-probe\n"));
  const filter = `node -e "require('node:fs').writeFileSync('.tmp/filter-token-probe',process.env.GITHUB_TOKEN||'absent');process.stdin.pipe(process.stdout)"`;
  f.git("config", "filter.credential-probe.smudge", filter);
  f.git("config", "filter.credential-probe.clean", filter);
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "pair-validation-sentinel";
  try {
    await f.run();
    assert.equal(existsSync(join(f.cwd, ".tmp/filter-token-probe")), false, "Neither clean nor smudge commands may run.");
    assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous;
  }
});

test("a dangling untracked test symlink is preserved without writing its target", async (t) => {
  const f = fixture(t);
  mkdirSync(dirname(join(f.cwd, testPath)), { recursive: true });
  const target = join(f.cwd, ".tmp/escaped-test.ts");
  symlinkSync(target, join(f.cwd, testPath));
  await assert.rejects(f.run(), /untracked|Unsafe test/);
  assert.equal(existsSync(target), false);
});

test("an already-checked-out T cannot hide transformed assertions behind Git filters", async (t) => {
  const f = fixture(t, undefined, (write) => write(".gitattributes", "*.ts filter=assertion-transform\n"));
  f.git("config", "filter.assertion-transform.smudge", "sed 's|^assert.equal|//assert.equal|'");
  f.git("config", "filter.assertion-transform.clean", "sed 's|^//assert.equal|assert.equal|'");
  f.git("checkout", "--detach", f.tests);
  assert.match(readFileSync(join(f.cwd, testPath), "utf8"), /\/\/assert.equal/);
  assert.equal(f.git("status", "--porcelain"), "", "The configured clean filter hides the changed raw assertion bytes.");
  await assert.rejects(f.run({ head: f.tests, pr: 12 }), /clean tracked checkout/);
});

test("local composition detaches HEAD without moving the implementation branch", async (t) => {
  const f = fixture(t); f.git("checkout", "implementation");
  const result = await f.run();
  assert.equal(f.git("rev-parse", "implementation"), f.implementation);
  assert.equal(f.git("rev-parse", "HEAD"), result.combinedCommit);
  assert.equal(f.git("branch", "--show-current"), "");
});
