import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { validatePairs, parseManifest, type GitHubSource } from "./image-test-pairs.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registryPath = ".github/scripts/image-test-pairs.json";
const mainRules = () => [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true } }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "checks" }] } }];
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
  write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] }));
  write("packages/daynight/src/value.ts", "export const value = 1;\n");
  baseSetup?.(write);
  const base = commit();
  git("checkout", "-b", "implementation");
  write("packages/daynight/src/value.ts", "export const value = 2;\n");
  const implementation = commit();
  const productionTreeAt = (revision: string) => {
    mkdirSync(join(cwd, ".tmp"), { recursive: true });
    const env = { ...process.env, GIT_INDEX_FILE: join(cwd, ".tmp/expected-index") };
    const indexGit = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", timeout: 10_000 }).trim();
    indexGit("read-tree", revision); indexGit("update-index", "--force-remove", "--", registryPath);
    const result = indexGit("write-tree"); rmSync(env.GIT_INDEX_FILE, { force: true }); return result;
  };
  const productionTree = productionTreeAt(implementation);
  git("checkout", "-b", "tests");
  if (change) change({ cwd, write, git }); else write(testPath, content);
  const tests = commit();
  const pair = { base, implementation: { pr: 11, sha: implementation, reviews: [101] }, tests: { pr: 12, sha: tests, reviews: [102] }, productionTree, allowPaths: [testPath] };
  const manifest = { schemaVersion: 1, pairs: [pair] };
  let manifestCommit: string;
  const saveManifest = () => {
    git("checkout", "-B", "main", base);
    write(registryPath, JSON.stringify(manifest));
    git("add", "--all"); git("commit", "--allow-empty", "-m", "Record registry fixture");
    manifestCommit = git("rev-parse", "HEAD");
    git("checkout", "--detach", implementation);
    return manifestCommit;
  };
  saveManifest();
  const author = (id: number) => ({ id, login: `user-${id}`, type: "User" });
  const prs: Record<number, any> = {
    11: { number: 11, state: "open", merged: false, merge_commit_sha: null, head: { sha: implementation, repo: { full_name: "owner/repository" } }, base: { ref: "main", sha: base, repo: { full_name: "owner/repository" } }, user: author(1) },
    12: { number: 12, state: "open", merged: false, merge_commit_sha: null, head: { sha: tests, repo: { full_name: "owner/repository" } }, base: { ref: "implementation", sha: implementation, repo: { full_name: "owner/repository" } }, user: author(2) },
  };
  const reviews: Record<number, any[]> = {
    11: [{ id: 101, state: "APPROVED", commit_id: implementation, user: author(3), submitted_at: "2026-01-01T00:00:00Z" }],
    12: [{ id: 102, state: "APPROVED", commit_id: tests, user: author(4), submitted_at: "2026-01-01T00:00:00Z" }],
  };
  let rules: any[] = mainRules();
  const requests: string[] = [];
  const source: GitHubSource = { async get(path) {
    requests.push(path);
    if (path === "/git/ref/heads/main") return { object: { type: "commit", sha: git("rev-parse", "main") } };
    if (path === "/rules/branches/main") return rules;
    const match = /^\/pulls\/(\d+)(\/reviews\?per_page=100&page=1)?$/.exec(path);
    if (match) return structuredClone(match[2] ? reviews[Number(match[1])] : prs[Number(match[1])]);
    throw new Error(`Unexpected API request ${path}`);
  } };
  const run = (options: Record<string, unknown> = {}) => validatePairs({ cwd, manifestCommit: options.event === "push" ? undefined : manifestCommit, event: "pull_request", head: implementation, pr: 11, repository: "owner/repository", source, ...options });
  const markMerged = (id: number, revision: string) => { prs[id].state = "closed"; prs[id].merged = true; prs[id].merge_commit_sha = revision; };
  const ordinaryPR = (head: string, baseSha = base, pr = 13) => { prs[pr] = { ...structuredClone(prs[11]), number: pr, head: { ...prs[11].head, sha: head }, base: { ...prs[11].base, sha: baseSha } }; return pr; };
  return { cwd, git, write, commit, base, implementation, tests, pair, manifest, saveManifest, prs, reviews, requests, source, run, markMerged, ordinaryPR, productionTreeAt, setRules: (next: typeof rules) => { rules = next; } };
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
  f.markMerged(11, main);
  const result = await f.run({ event: "push", head: main, pr: undefined });
  assert.equal(result.combinedTree, f.git("rev-parse", "HEAD^{tree}"));
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content);
});

test("final integrated main validates its already-present tests without overlay", async (t) => {
  const f = fixture(t);
  f.git("checkout", "main"); f.git("merge", "--no-ff", "tests", "-m", "Integrated test fixture");
  const main = f.git("rev-parse", "HEAD"); f.markMerged(11, f.implementation); f.markMerged(12, main);
  const result = await f.run({ event: "push", head: main, pr: undefined });
  assert.equal(result.combinedTree, f.git("rev-parse", "HEAD^{tree}"));
  assert.equal(result.mode, "ordinary");
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

test("an ordinary fork PR with an empty registry retains its original checkout", async (t) => {
  const f = fixture(t);
  f.manifest.pairs = [];
  f.saveManifest();
  const pr = f.ordinaryPR(f.implementation);
  f.prs[pr].head.repo = { full_name: "contributor/repository" };
  const beforeTree = f.git("rev-parse", "HEAD^{tree}");
  const result = await f.run({ pr });
  assert.equal(result.mode, "ordinary");
  assert.equal(result.pairCount, 0);
  assert.equal(result.changedTestFiles, 0);
  assert.equal(result.combinedCommit, f.implementation);
  assert.equal(result.combinedTree, beforeTree);
  assert.equal(f.git("rev-parse", "HEAD"), f.implementation);
  assert.equal(readFileSync(join(f.cwd, "packages/daynight/src/value.ts"), "utf8"), "export const value = 2;\n");
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

for (const [label, update, pattern] of [
  ["a different target repository", (f: ReturnType<typeof fixture>, pr: number) => { f.prs[pr].base.repo = { full_name: "other/repository" }; }, /target the configured repository/],
  ["a different event HEAD", (f: ReturnType<typeof fixture>, pr: number) => { f.prs[pr].head.sha = f.tests; }, /Event HEAD/],
  ["a different PR number", (f: ReturnType<typeof fixture>, pr: number) => { f.prs[pr].number = pr + 1; }, /pull request state/],
] as const) test(`an ordinary fork PR rejects ${label}`, async (t) => {
  const f = fixture(t);
  f.manifest.pairs = [];
  f.saveManifest();
  const pr = f.ordinaryPR(f.implementation);
  f.prs[pr].head.repo = { full_name: "contributor/repository" };
  update(f, pr);
  await assert.rejects(f.run({ pr }), pattern);
  assert.equal(f.git("rev-parse", "HEAD"), f.implementation);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

for (const [label, update, pattern] of [
  ["remote I HEAD drift", (f: ReturnType<typeof fixture>) => { f.prs[11].head.sha = "a".repeat(40); }, /HEAD/],
  ["remote T HEAD drift", (f: ReturnType<typeof fixture>) => { f.prs[12].head.sha = "a".repeat(40); }, /HEAD/],
  ["dismissed pinned review", (f: ReturnType<typeof fixture>) => { f.reviews[12][0].state = "DISMISSED"; }, /review/i],
  ["wrong review commit", (f: ReturnType<typeof fixture>) => { f.reviews[12][0].commit_id = f.base; }, /review/i],
  ["candidate author's review", (f: ReturnType<typeof fixture>) => { f.reviews[12][0].user = f.prs[11].user; }, /independent/i],
  ["current change request", (f: ReturnType<typeof fixture>) => { f.reviews[12].push({ ...f.reviews[12][0], id: 103, user: { id: 9, login: "reviewer-9", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z" }); }, /review/i],
  ["missing main review protection", (f: ReturnType<typeof fixture>) => { f.setRules(mainRules().filter(rule => rule.type !== "pull_request")); }, /protect/i],
  ["missing ref deletion protection", (f: ReturnType<typeof fixture>) => { f.setRules(mainRules().filter(rule => rule.type !== "deletion")); }, /protect/i],
  ["missing ref force-push protection", (f: ReturnType<typeof fixture>) => { f.setRules(mainRules().filter(rule => rule.type !== "non_fast_forward")); }, /protect/i],
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
  f.git("checkout", "main"); f.git("merge", "--squash", "implementation"); f.git("commit", "-m", "Merged implementation");
  f.markMerged(11, f.git("rev-parse", "HEAD"));
  f.write("packages/daynight/src/other.ts", "export const other = true;\n");
  const main = f.commit();
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

test("an unrelated PR before I incorporation keeps its original checks and source", async (t) => {
  const f = fixture(t); const pr = f.ordinaryPR(f.base); f.git("checkout", "--detach", f.base);
  const result = await f.run({ pr, head: f.base });
  assert.equal(result.mode, "ordinary"); assert.equal(result.combinedCommit, f.base);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("an ordinary fork PR with an unrelated registered pair keeps its original checks", async (t) => {
  const f = fixture(t); const pr = f.ordinaryPR(f.base); f.git("checkout", "--detach", f.base);
  f.prs[pr].head.repo = { full_name: "contributor/repository" };
  const result = await f.run({ pr, head: f.base });
  assert.equal(result.mode, "ordinary"); assert.equal(result.combinedCommit, f.base);
  assert.equal(result.changedTestFiles, 0);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
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
  await assert.rejects(f.run({ manifestCommit: f.tests }), /protected main/);
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

test("main before I incorporation runs ordinary checks without candidate tests", async (t) => {
  const f = fixture(t); f.git("checkout", "main"); const head = f.git("rev-parse", "HEAD");
  const result = await f.run({ event: "push", head, pr: undefined });
  assert.equal(result.mode, "ordinary"); assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("a queued I-main run still overlays T after a later T merge", async (t) => {
  const f = fixture(t); f.git("checkout", "main"); f.git("merge", "--squash", "implementation"); f.git("commit", "-m", "Merged implementation");
  const head = f.git("rev-parse", "HEAD"); f.markMerged(11, head);
  f.git("merge", "--squash", "tests"); f.git("commit", "-m", "Merged tests"); f.markMerged(12, f.git("rev-parse", "HEAD"));
  f.git("checkout", "--detach", head);
  const result = await f.run({ event: "push", head, pr: undefined, manifestCommit: undefined });
  assert.equal(result.mode, "paired-window"); assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content);
});

test("PR event identity cannot substitute a different candidate SHA", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ head: f.tests }), /Event HEAD/);
});

for (const pr of [11, 12]) test(`a fork cannot supply registered candidate PR ${pr}`, async (t) => {
  const f = fixture(t); f.prs[pr].head.repo.full_name = "attacker/repository";
  await assert.rejects(f.run(), /configured repository/);
  assert.equal(f.git("rev-parse", "HEAD"), f.implementation);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
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
  // Keep the cached file stat outside Git's racy-index window without sleeping.
  const cachedAt = new Date(statSync(join(f.cwd, testPath)).mtimeMs + 60_000);
  utimesSync(join(f.cwd, ".git/index"), cachedAt, cachedAt);
  await assert.rejects(f.run({ head: f.tests, pr: 12 }), /clean tracked checkout/);
});

for (const ordinary of [false, true]) test(`rejects cached filtered production bytes before ${ordinary ? "ordinary" : "paired"} validation`, async (t) => {
  const f = fixture(t, undefined, (write) => write(".gitattributes", "*.ts filter=production-transform\n"));
  if (ordinary) { f.manifest.pairs = []; f.saveManifest(); }
  f.git("config", "filter.production-transform.smudge", "sed 's/value = 2/value = 0/'");
  f.git("config", "filter.production-transform.clean", "sed 's/value = 0/value = 2/'");
  const path = join(f.cwd, "packages/daynight/src/value.ts");
  rmSync(path);
  f.git("checkout-index", "--force", "--all");
  assert.equal(readFileSync(path, "utf8"), "export const value = 0;\n");
  assert.equal(f.git("status", "--porcelain"), "");
  const cachedAt = new Date(statSync(path).mtimeMs + 60_000);
  utimesSync(join(f.cwd, ".git/index"), cachedAt, cachedAt);
  await assert.rejects(f.run(), /clean tracked checkout/);
  assert.equal(readFileSync(path, "utf8"), "export const value = 0;\n");
  assert.equal(f.git("rev-parse", "HEAD"), f.implementation);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
  assert.equal(existsSync(join(f.cwd, ".tmp/image-test-pairs.json")), false);
});

test("local composition detaches HEAD without moving the implementation branch", async (t) => {
  const f = fixture(t); f.git("checkout", "implementation");
  const result = await f.run();
  assert.equal(f.git("rev-parse", "implementation"), f.implementation);
  assert.equal(f.git("rev-parse", "HEAD"), result.combinedCommit);
  assert.equal(f.git("branch", "--show-current"), "");
});

test("PR detection resolves its immutable registry pin from main once", async (t) => {
  const f = fixture(t); const expected = f.git("rev-parse", "main");
  const result = await f.run({ manifestCommit: undefined });
  assert.equal(result.manifestCommit, expected);
  assert.equal(f.requests.filter(path => path === "/git/ref/heads/main").length, 1);
});

test("main push pins its event registry even when protected main later advances", async (t) => {
  const f = fixture(t); const eventHead = f.git("rev-parse", "main");
  f.git("checkout", "main"); f.write("README.md", "later unrelated main\n"); f.commit();
  f.git("checkout", "--detach", eventHead);
  const result = await f.run({ manifestCommit: undefined, event: "push", head: eventHead, pr: undefined });
  assert.equal(result.manifestCommit, eventHead); assert.equal(result.mode, "ordinary");
});


test("an unmerged registry candidate is verified but never supplies executable tests", async (t) => {
  const f = fixture(t); f.manifest.pairs = []; const trusted = f.saveManifest();
  f.git("checkout", "-b", "registry-proposal", "main");
  f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [f.pair] })); const head = f.commit();
  const result = await f.run({ pr: f.ordinaryPR(head, trusted), head });
  assert.equal(result.mode, "ordinary"); assert.equal(result.registryChecked, true); assert.equal(result.manifestCommit, trusted);
  assert.equal(result.combinedCommit, head); assert.equal(existsSync(join(f.cwd, testPath)), false);
  assert.equal(readFileSync(join(f.cwd, "packages/daynight/src/value.ts"), "utf8"), "export const value = 1;\n");
});

test("a registry PR cannot remove even a pending I mapping before T has reached main", async (t) => {
  const f = fixture(t); const trusted = f.git("rev-parse", "main");
  f.git("checkout", "-b", "remove-registry", "main"); f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] })); const head = f.commit();
  await assert.rejects(f.run({ pr: f.ordinaryPR(head, trusted), head }), /cannot remove/);
});

const mergeImplementation = (f: ReturnType<typeof fixture>) => {
  f.git("checkout", "main"); f.git("merge", "--squash", "implementation"); f.git("commit", "-m", "Merge implementation fixture");
  const head = f.git("rev-parse", "HEAD"); f.markMerged(11, head); return head;
};

test("a registry deletion cannot bypass the active window on a main push", async (t) => {
  const f = fixture(t); mergeImplementation(f);
  f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] })); const head = f.commit();
  await assert.rejects(f.run({ event: "push", head, pr: undefined }), /cannot remove/);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("a registry PR in the active window cannot erase the pending test input", async (t) => {
  const f = fixture(t); const base = mergeImplementation(f);
  f.git("checkout", "-b", "registry-deletion"); f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] })); const head = f.commit();
  await assert.rejects(f.run({ pr: f.ordinaryPR(head, base), head }), /cannot remove/);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("replacement tests remain untrusted until the registry PR merges into main", async (t) => {
  const f = fixture(t); const base = mergeImplementation(f);
  f.git("checkout", "-b", "replacement-tests", f.tests); f.git("merge", "--no-ff", "main", "-m", "Synchronize registry and merged I");
  const replacementContent = `${content}assert.equal(4 * 4, 16);\n`;
  f.write(testPath, replacementContent); const replacement = f.commit();
  f.prs[14] = { ...structuredClone(f.prs[12]), number: 14, head: { ...f.prs[12].head, sha: replacement }, base: { ...f.prs[12].base, ref: "main", sha: base } };
  f.reviews[14] = [{ ...f.reviews[12][0], id: 104, commit_id: replacement }];
  const proposed = { schemaVersion: 1, pairs: [{ ...f.pair, tests: { pr: 14, sha: replacement, reviews: [104] } }] };
  f.git("checkout", "-b", "replacement-registry", "main"); f.write(registryPath, JSON.stringify(proposed)); const head = f.commit();
  const result = await f.run({ pr: f.ordinaryPR(head, base), head });
  assert.equal(result.mode, "paired-window"); assert.equal(result.registryChecked, true); assert.equal(result.tests, f.tests);
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content, "A registry proposal must still run the old trusted test bytes.");
  assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, registryPath), "utf8")), proposed);
  f.git("checkout", "main"); f.git("merge", "--ff-only", "replacement-registry");
  const accepted = await f.run({ event: "push", head, pr: undefined });
  assert.equal(accepted.manifestCommit, head); assert.equal(accepted.tests, replacement);
  assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), replacementContent);
});

test("registry removal becomes ordinary only after both actual merge commits reach main", async (t) => {
  const f = fixture(t); mergeImplementation(f);
  f.git("merge", "--squash", "tests"); f.git("commit", "-m", "Merge tests fixture"); const mergedTests = f.git("rev-parse", "HEAD"); f.markMerged(12, mergedTests);
  f.git("checkout", "-b", "completed-registry-cleanup"); f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] })); const head = f.commit();
  const result = await f.run({ pr: f.ordinaryPR(head, mergedTests), head });
  assert.equal(result.mode, "ordinary"); assert.equal(result.registryChecked, true); assert.equal(result.pairCount, 0);
  f.git("checkout", "main"); f.git("merge", "--ff-only", "completed-registry-cleanup");
  const accepted = await f.run({ event: "push", head, pr: undefined });
  assert.equal(accepted.mode, "ordinary"); assert.equal(accepted.combinedCommit, head);
});

test("a merge receipt outside main cannot authorize registry removal", async (t) => {
  const f = fixture(t); const base = mergeImplementation(f); f.markMerged(12, f.tests);
  f.git("checkout", "-b", "premature-registry-cleanup"); f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] })); const head = f.commit();
  await assert.rejects(f.run({ pr: f.ordinaryPR(head, base), head }), /cannot remove/);
});

for (const [label, alter] of [
  ["independent approval", (rules: any[]) => { rules[2].parameters.required_approving_review_count = 0; }],
  ["stale review dismissal", (rules: any[]) => { rules[2].parameters.dismiss_stale_reviews_on_push = false; }],
  ["thread resolution", (rules: any[]) => { rules[2].parameters.required_review_thread_resolution = false; }],
  ["required checks", (rules: any[]) => { rules[3].parameters.required_status_checks = [{ context: "other" }]; }],
] as const) test(`rejects main without ${label}`, async (t) => {
  const f = fixture(t); const rules = mainRules(); alter(rules); f.setRules(rules);
  await assert.rejects(f.run(), /protection/);
});

test("push consumers cannot replace the event registry with another main ancestor", async (t) => {
  const f = fixture(t); const manifestCommit = f.git("rev-parse", "main"); const head = mergeImplementation(f);
  await assert.rejects(f.run({ event: "push", head, pr: undefined, manifestCommit }), /must match its event HEAD/);
});

test("a delayed push cannot borrow a later T merge to validate its earlier registry deletion", async (t) => {
  const f = fixture(t); mergeImplementation(f);
  f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] })); const head = f.commit();
  f.git("merge", "--squash", "tests"); f.git("commit", "-m", "Later merged tests"); f.markMerged(12, f.git("rev-parse", "HEAD"));
  f.git("checkout", "--detach", head);
  await assert.rejects(f.run({ event: "push", head, pr: undefined }), /cannot remove/);
  assert.equal(existsSync(join(f.cwd, testPath)), false);
});

test("the real CLI accepts an empty initial PR pin but never falls back for a consumer", async (t) => {
  const f = fixture(t); const snapshot: Record<string, unknown> = {};
  for (const path of ["/rules/branches/main", "/git/ref/heads/main", "/pulls/11", "/pulls/12", "/pulls/11/reviews?per_page=100&page=1", "/pulls/12/reviews?per_page=100&page=1"]) snapshot[path] = await f.source.get(path);
  const preloader = join(f.cwd, ".tmp/cli-transport.mjs");
  const requests = join(f.cwd, ".tmp/cli-requests.jsonl");
  f.write(".tmp/cli-transport.mjs", `import { appendFileSync } from 'node:fs';\nconst responses = ${JSON.stringify(snapshot)};\nglobalThis.fetch = async (url) => {\n  const path = String(url).replace('https://api.github.com/repos/owner/repository', '');\n  if (!(path in responses)) throw new Error('Unexpected API request: ' + path);\n  appendFileSync(${JSON.stringify(requests)}, JSON.stringify(path) + '\\n');\n  return new Response(JSON.stringify(responses[path]), {status: 200});\n};\n`);
  const output = join(f.cwd, ".tmp/cli-output");
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: "owner/repository", GITHUB_TOKEN: "test-only-read-token", GITHUB_OUTPUT: output,
    IMAGE_PAIR_EVENT: "pull_request", IMAGE_PAIR_HEAD: f.implementation, IMAGE_PAIR_PR: "11", IMAGE_PAIR_MANIFEST_COMMIT: "" };
  delete env.IMAGE_PAIR_EXPECTED_COMBINED_TREE;
  const run = () => spawnSync(process.execPath, ["--import", preloader, join(root, ".github/scripts/image-test-pairs.mts")], { cwd: f.cwd, env, encoding: "utf8", timeout: 30_000 });
  const detection = run(); assert.equal(detection.status, 0, detection.stderr);
  assert.match(readFileSync(output, "utf8"), new RegExp(`manifest_commit=${f.git("rev-parse", "main")}`));
  assert.equal(readFileSync(requests, "utf8").trim().split("\n").filter(line => JSON.parse(line) === "/git/ref/heads/main").length, 1);
  rmSync(requests); env.IMAGE_PAIR_EXPECTED_COMBINED_TREE = "a".repeat(40);
  const consumer = run(); assert.notEqual(consumer.status, 0); assert.match(consumer.stderr, /Manifest commit/);
  assert.equal(existsSync(requests), false, "A consumer with a missing pin must not reread main as a replacement.");
});

test("preserves checkout newline normalization while excluding validation credentials", async (t) => {
  const f = fixture(t); const previousHome = process.env.HOME;
  f.write(".tmp/git-home/.gitconfig", "[core]\n\tautocrlf = true\n");
  process.env.HOME = join(f.cwd, ".tmp/git-home");
  try {
    f.git("checkout", "--force", "--detach", f.base); f.git("checkout", "--force", "--detach", f.implementation);
    assert.match(readFileSync(join(f.cwd, "packages/daynight/src/value.ts"), "utf8"), /\r\n/);
    const result = await f.run();
    assert.equal(result.mode, "paired-pr");
    assert.equal(readFileSync(join(f.cwd, testPath), "utf8"), content);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});

test("an already-checked-out T retains its identity after raw test bytes replace CRLF checkout bytes", async (t) => {
  const f = fixture(t);
  f.git("config", "core.autocrlf", "true");
  f.git("checkout", "--force", "--detach", f.base);
  f.git("checkout", "--force", "--detach", f.tests);
  assert.match(readFileSync(join(f.cwd, testPath), "utf8"), /\r\n/);
  assert.equal(f.git("status", "--porcelain"), "");
  const originalTree = f.git("rev-parse", "HEAD^{tree}");

  const result = await f.run({ head: f.tests, pr: 12 });

  assert.equal(result.mode, "paired-pr");
  assert.equal(result.checkoutCommit, f.tests);
  assert.equal(result.combinedCommit, f.tests);
  assert.equal(result.combinedTree, originalTree);
  assert.equal(result.productionTree, f.pair.productionTree);
  assert.equal(f.git("rev-parse", "HEAD"), f.tests);
  assert.deepEqual(readFileSync(join(f.cwd, testPath)), Buffer.from(content));
  assert.equal(f.git("status", "--porcelain"), "");
});

test("an unchanged cancelled I record does not block registration of a new valid pair", async (t) => {
  const f = fixture(t); f.prs[11].state = "closed"; f.prs[12].state = "closed";
  const trusted = f.git("rev-parse", "main");
  f.git("checkout", "-b", "next-implementation", f.base); f.write("packages/daynight/src/value.ts", "export const value = 3;\n"); const implementation = f.commit();
  const productionTree = f.productionTreeAt(implementation);
  f.git("checkout", "-b", "next-tests"); f.write(testPath, content); const tests = f.commit();
  f.prs[21] = { ...structuredClone(f.prs[11]), number: 21, state: "open", head: { ...f.prs[11].head, sha: implementation } };
  f.prs[22] = { ...structuredClone(f.prs[12]), number: 22, state: "open", head: { ...f.prs[12].head, sha: tests }, base: { ...f.prs[12].base, sha: implementation } };
  f.reviews[21] = [{ ...f.reviews[11][0], id: 201, commit_id: implementation }]; f.reviews[22] = [{ ...f.reviews[12][0], id: 202, commit_id: tests }];
  const next = { base: f.base, implementation: { pr: 21, sha: implementation, reviews: [201] }, tests: { pr: 22, sha: tests, reviews: [202] }, productionTree, allowPaths: [testPath] };
  f.git("checkout", "-b", "add-next-pair", "main"); f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [f.pair, next] })); const head = f.commit();
  const result = await f.run({ pr: f.ordinaryPR(head, trusted), head });
  assert.equal(result.mode, "ordinary"); assert.equal(result.registryChecked, true);
  f.git("checkout", "main"); f.git("merge", "--ff-only", "add-next-pair");
  const accepted = await f.run({ event: "push", head, pr: undefined }); assert.equal(accepted.mode, "ordinary");
});

test("an unchanged closed T still fails while its implementation is in the active window", async (t) => {
  const f = fixture(t); const base = mergeImplementation(f); f.prs[12].state = "closed";
  f.git("checkout", "-b", "format-active-registry"); f.write(registryPath, JSON.stringify(f.manifest, null, 2)); const head = f.commit();
  await assert.rejects(f.run({ pr: f.ordinaryPR(head, base), head }), /closed without merging/);
});

test("a cancelled unmerged I record cannot be deleted from the registry", async (t) => {
  const f = fixture(t); f.prs[11].state = "closed"; const base = f.git("rev-parse", "main");
  f.git("checkout", "-b", "delete-cancelled-pair", "main"); f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] })); const head = f.commit();
  await assert.rejects(f.run({ pr: f.ordinaryPR(head, base), head }), /cannot remove/);
});
