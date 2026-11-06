import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type TestContext } from "vitest";
import { validatePairs, type GitHubSource } from "../../../../.github/scripts/image-test-pairs.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const registryPath = ".github/scripts/image-test-pairs.json";
const candidatePath = "packages/daynight/test/ci/reviewed-input.cts";
const reviewedTest = [
  'const assert = require("node:assert/strict");',
  'const { writeFileSync } = require("node:fs");',
  'const { value } = require("../../src/value.cjs");',
  'assert.equal(value, 2);',
  'assert.equal(process.env.GITHUB_TOKEN, undefined);',
  'writeFileSync(".tmp/executed.json", JSON.stringify({ value }));',
  '',
].join("\n");

type Pull = {
  number: number; state: "open" | "closed"; merged: boolean; merge_commit_sha: string | null;
  head: { sha: string; repo: { full_name: string } };
  base: { sha: string; ref: string; repo: { full_name: string } };
  user: { id: number; type: "User" };
};

const fixture = ({ onTestFinished }: TestContext) => {
  mkdirSync(join(repositoryRoot, ".tmp"), { recursive: true });
  const cwd = mkdtempSync(join(repositoryRoot, ".tmp/pair-input-"));
  onTestFinished(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  }).trim();
  const write = (path: string, bytes: string) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), bytes); };
  const commit = (message: string) => { git("add", "--all"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Pair input regression"); git("config", "user.email", "pair-input@example.invalid");
  git("config", "maintenance.auto", "false"); git("config", "core.autocrlf", "false");
  write(".gitignore", ".tmp/\n");
  write(".gitattributes", `${candidatePath} filter=pair-probe\n`);
  write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] }));
  write("packages/daynight/src/value.cjs", "exports.value = 1;\n");
  const base = commit("Record common base");
  git("checkout", "-b", "implementation");
  write("packages/daynight/src/value.cjs", "exports.value = 2;\n");
  const implementation = commit("Change the fixture implementation");
  // The registry is the only non-test path excluded from production identity.
  git("rm", "--cached", registryPath);
  const productionTree = git("write-tree");
  git("reset", "--mixed", implementation);
  git("checkout", "-b", "tests"); write(candidatePath, reviewedTest);
  const tests = commit("Add the independent behavior assertion");
  git("checkout", "main");
  write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [{
    base, implementation: { pr: 11, sha: implementation, reviews: [101] },
    tests: { pr: 12, sha: tests, reviews: [102] }, productionTree, allowPaths: [candidatePath],
  }] }));
  const manifestCommit = commit("Register exact reviewed candidates");
  const repo = { full_name: "fixture/repository" };
  const pull = (number: number, sha: string, baseSha: string, ref: string, author: number): Pull => ({
    number, state: "open", merged: false, merge_commit_sha: null, head: { sha, repo }, base: { sha: baseSha, ref, repo }, user: { id: author, type: "User" },
  });
  const implementationPR = pull(11, implementation, base, "main", 1);
  const testPR = pull(12, tests, implementation, "implementation", 2);
  const review = (id: number, commit_id: string, author: number) => ({
    id, state: "APPROVED", commit_id, user: { id: author, type: "User" }, submitted_at: "2026-01-01T00:00:00Z",
  });
  // Only GitHub metadata is controlled; composition and execution use real Git objects and files.
  const source: GitHubSource = { async get(path) {
    if (path === "/rules/branches/main") return [
      { type: "deletion" }, { type: "non_fast_forward" },
      { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true } },
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "checks" }] } },
    ];
    if (path === "/git/ref/heads/main") return { object: { type: "commit", sha: git("rev-parse", "main") } };
    if (path === "/pulls/11") return structuredClone(implementationPR);
    if (path === "/pulls/12") return structuredClone(testPR);
    if (path === "/pulls/11/reviews?per_page=100&page=1") return [review(101, implementation, 3)];
    if (path === "/pulls/12/reviews?per_page=100&page=1") return [review(102, tests, 4)];
    throw new Error(`Unexpected GitHub fixture read: ${path}`);
  } };
  git("checkout", "--detach", implementation);
  return { cwd, git, write, commit, implementation, tests, manifestCommit, source, implementationPR, testPR };
};

test("the paired checkout executes reviewed assertion bytes without running credential-bearing Git filters", async (context) => {
  const f = fixture(context);
  f.write(".tmp/filter.cjs", 'require("node:fs").writeFileSync(".tmp/filter-ran", process.env.GITHUB_TOKEN || "absent"); process.stdin.pipe(process.stdout);\n');
  f.git("config", "filter.pair-probe.clean", "node .tmp/filter.cjs");
  f.git("config", "filter.pair-probe.smudge", "node .tmp/filter.cjs");
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "fixture-read-token";
  try {
    const result = await validatePairs({ cwd: f.cwd, manifestCommit: f.manifestCommit, event: "pull_request", head: f.implementation,
      pr: 11, repository: "fixture/repository", source: f.source });
    expect(result.mode).toBe("paired-pr");
    expect(result.combinedCommit).toBe(f.git("rev-parse", "HEAD"));
    expect(readFileSync(join(f.cwd, candidatePath))).toEqual(Buffer.from(reviewedTest));
    expect(existsSync(join(f.cwd, ".tmp/filter-ran"))).toBe(false);
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
  }
  execFileSync(process.execPath, [join(f.cwd, candidatePath)], {
    cwd: f.cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, timeout: 10_000, stdio: "pipe",
  });
  expect(JSON.parse(readFileSync(join(f.cwd, ".tmp/executed.json"), "utf8"))).toEqual({ value: 2 });
  expect(readFileSync(join(f.cwd, "packages/daynight/src/value.cjs"), "utf8")).toBe("exports.value = 2;\n");
}, 30_000);

test("a queued I-only push cannot lose its paired tests by borrowing a later T merge", async (context) => {
  const f = fixture(context);
  f.git("checkout", "main"); f.git("merge", "--squash", "implementation");
  const implementationMerge = f.commit("Squash the implementation");
  Object.assign(f.implementationPR, { state: "closed", merged: true, merge_commit_sha: implementationMerge });
  f.write(registryPath, JSON.stringify({ schemaVersion: 1, pairs: [] }));
  const prematureRemoval = f.commit("Prematurely remove the mapping");
  f.write(candidatePath, reviewedTest);
  const testMerge = f.commit("Incorporate tests later");
  Object.assign(f.testPR, { state: "closed", merged: true, merge_commit_sha: testMerge });
  f.git("checkout", "--detach", prematureRemoval);
  await expect(validatePairs({ cwd: f.cwd, event: "push", head: prematureRemoval,
    repository: "fixture/repository", source: f.source })).rejects.toThrow(/Registry cannot remove a pair/);
  expect(f.git("rev-parse", "HEAD")).toBe(prematureRemoval);
  expect(existsSync(join(f.cwd, candidatePath))).toBe(false);
  expect(existsSync(join(f.cwd, ".tmp/image-test-pairs.json"))).toBe(false);
}, 30_000);
