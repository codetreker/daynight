import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

interface SourceIdentity { sourceRevision: string; sourceTree: string; vitestVersion: string }
type RecordValue = Record<string, unknown>;
const object = (value: unknown, label: string): RecordValue => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `Invalid ${label}.`);
  return value as RecordValue;
};
const array = (value: unknown, label: string): unknown[] => {
  assert.ok(Array.isArray(value), `Invalid ${label}.`);
  return value;
};
const canonicalPath = (root: unknown, value: unknown): string => {
  for (const candidate of [root, value]) {
    assert.ok(typeof candidate === "string" && /^[a-z]:[\\/]/i.test(candidate) && !candidate.includes("\0"), "Invalid absolute Windows path.");
    assert.ok(!candidate.split(/[\\/]/).some(part => part === "." || part === ".."), "Noncanonical Windows path.");
  }
  const relative = path.win32.relative(root as string, value as string);
  assert.ok(relative !== "" && !path.win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"), "File path escapes the package root.");
  return relative.replaceAll("\\", "/").toLowerCase();
};
const addFile = (files: Set<string>, file: string, label: string): void => {
  assert.ok(!files.has(file), `Found duplicate ${label} file: ${file}`);
  files.add(file);
};

export const verifyWindowsShards = (shards: unknown[], expected: SourceIdentity): { files: number; shards: number[] } => {
  assert.equal(shards.length, 2, "Expected exactly two Windows shards.");
  const identities = new Set<string>();
  const executions: Set<string>[] = [];
  let fullDiscovery: Set<string> | undefined;
  for (const value of shards) {
    const shard = object(value, "shard evidence");
    const metadata = object(shard.metadata, "shard metadata");
    assert.equal(metadata.formatVersion, 1, "Invalid formatVersion.");
    assert.equal(metadata.platform, "win32", "Invalid platform: native Windows execution is required.");
    assert.equal(metadata.sourceDirty, false, "Invalid sourceDirty: the checkout must be clean.");
    assert.equal(metadata.testStepOutcome, "success", "The real Windows test step did not succeed.");
    for (const key of ["sourceRevision", "sourceTree", "vitestVersion"] as const) {
      assert.equal(metadata[key], expected[key], `Mismatched ${key}.`);
    }
    assert.ok(metadata.shard === "1/2" || metadata.shard === "2/2", "Invalid shard identity.");
    assert.ok(!identities.has(metadata.shard), "Duplicate shard identity.");
    identities.add(metadata.shard);
    const discovery = new Set<string>();
    for (const entry of array(shard.discovered, "full discovery")) {
      const spec = object(entry, "discovered specification");
      assert.ok(spec.projectName === undefined || spec.projectName === "", "Named test projects require project-aware execution evidence.");
      addFile(discovery, canonicalPath(metadata.packageRoot, spec.file), "discovered");
    }
    assert.ok(discovery.size > 0, "The full discovery is empty.");
    if (fullDiscovery) assert.deepEqual(discovery, fullDiscovery, "The full discovery differs between Windows runners.");
    else fullDiscovery = discovery;

    const results = object(shard.results, "execution results");
    assert.equal(results.success, true, "The execution results did not succeed.");
    assert.equal(results.numFailedTestSuites, 0, "The execution results contain failed suites.");
    assert.equal(results.numFailedTests, 0, "The execution results contain failed tests.");
    const executed = new Set<string>();
    const counts = { passed: 0, skipped: 0, todo: 0 };
    for (const entry of array(results.testResults, "executed test results")) {
      const module = object(entry, "executed module result");
      const file = canonicalPath(metadata.packageRoot, module.name);
      addFile(executed, file, "executed");
      assert.ok(discovery.has(file), `Executed file was not discovered: ${file}`);
      assert.equal(module.status, "passed", `Incomplete or failed module result: ${file}`);
      assert.equal(module.message, "", `Module result contains an error: ${file}`);
      for (const entry of array(module.assertionResults, "assertion results")) {
        const assertion = object(entry, "assertion result");
        const state = assertion.status;
        assert.ok(state === "passed" || state === "skipped" || state === "todo", `Incomplete or failed assertion result: ${file}`);
        assert.deepEqual(assertion.failureMessages, [], `Assertion result contains failures: ${file}`);
        counts[state]++;
      }
    }
    assert.ok(executed.size > 0, "The executed shard result is empty.");
    for (const [field, count] of Object.entries({ numTotalTests: counts.passed + counts.skipped + counts.todo, numPassedTests: counts.passed, numPendingTests: counts.skipped, numTodoTests: counts.todo })) {
      assert.equal(results[field], count, `Inconsistent result test count: ${field}`);
    }
    executions[metadata.shard === "1/2" ? 0 : 1] = executed;
  }
  const union = new Set<string>();
  for (const executed of executions) {
    for (const file of executed) {
      assert.ok(!union.has(file), `Windows shards overlap: ${file}`);
      union.add(file);
    }
  }
  assert.deepEqual(union, fullDiscovery, "Executed Windows shards do not cover the full discovery.");
  return { files: union.size, shards: executions.map(files => files.size) };
};

const readJSON = (filename: string): unknown => JSON.parse(readFileSync(filename, "utf8"));
const git = (args: string[]): string => {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const source = (): Omit<SourceIdentity, "vitestVersion"> => ({ sourceRevision: git(["rev-parse", "HEAD"]), sourceTree: git(["rev-parse", "HEAD^{tree}"]) });

if (import.meta.main) {
  const [command, argument, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, "Unexpected Windows shard arguments.");
  if (command === "record") {
    assert.ok(argument === "1/2" || argument === "2/2", "Expected shard 1/2 or 2/2.");
    const packageRoot = path.resolve("packages/daynight");
    const require = createRequire(path.join(packageRoot, "package.json"));
    const version = object(require("vitest/package.json"), "installed Vitest package").version;
    assert.equal(typeof version, "string", "Missing installed Vitest version.");
    const metadata = {
      formatVersion: 1, ...source(), sourceDirty: git(["status", "--porcelain"]) !== "", vitestVersion: version,
      platform: process.platform, packageRoot, shard: argument, testStepOutcome: process.env.CLI_TEST_RESULT,
    };
    const directory = path.resolve(".tmp/windows-cli-shard");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  } else if (command === "verify") {
    assert.ok(argument, "Expected the downloaded Windows shard directory.");
    const manifest = object(readJSON("packages/daynight/package.json"), "CLI package manifest");
    const vitestVersion = object(manifest.devDependencies, "CLI development dependencies").vitest;
    assert.equal(typeof vitestVersion, "string", "Missing pinned Vitest version.");
    const shards = [1, 2].map(index => Object.fromEntries(["metadata", "discovered", "results"].map(name => [name, readJSON(path.join(argument, String(index), `${name}.json`))])));
    const result = verifyWindowsShards(shards, { ...source(), vitestVersion: vitestVersion as string });
    console.log(`Verified complete Windows CLI execution: ${result.files} files across shards ${result.shards.join(" + ")}.`);
  } else throw new Error("Use windows-cli-shards.mts record <1/2|2/2> or verify <directory>.");
}
