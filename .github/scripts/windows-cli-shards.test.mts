import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWindowsShards } from "./windows-cli-shards.mts";

const identity = { sourceRevision: "a".repeat(40), sourceTree: "b".repeat(40), vitestVersion: "5.0.5" };
const root = "D:/a/daynight/daynight/packages/daynight";
const file = (name: string, directory = root): string => `${directory}/test/${name}.test.ts`;
const fixture = () => [1, 2].map(index => ({
  metadata: { formatVersion: 1, ...identity, sourceDirty: false, platform: "win32", packageRoot: root, shard: `${index}/2`, testStepOutcome: "success" },
  discovered: ["first", "second", "skipped"].map(name => ({ file: file(name) })),
  results: {
    success: true, numFailedTestSuites: 0, numFailedTests: 0,
    numTotalTests: index === 1 ? 2 : 1, numPassedTests: 1, numPendingTests: index === 1 ? 1 : 0, numTodoTests: 0,
    testResults: (index === 1 ? ["first", "skipped"] : ["second"]).map(name => ({
      name: file(name), status: "passed", message: "",
      assertionResults: [{ status: name === "skipped" ? "skipped" : "passed", failureMessages: [] }],
    })),
  },
}));

test("two real result collections cover the full discovery while retaining intentional skips", () => {
  assert.deepEqual(verifyWindowsShards(fixture(), identity), { files: 3, shards: [2, 1] });
});

test("runner checkout prefixes and native Windows path separators do not change identity", () => {
  const shards = fixture();
  const other = "E:\\work\\checkout\\packages\\daynight";
  shards[1]!.metadata.packageRoot = other;
  for (const entry of shards[1]!.discovered) entry.file = entry.file.replace(root, other).replaceAll("/", "\\");
  for (const entry of shards[1]!.results.testResults) entry.name = entry.name.replace(root, other).replaceAll("/", "\\");
  assert.equal(verifyWindowsShards(shards, identity).files, 3);
});

for (const outcome of ["failure", "cancelled", "skipped", "timed_out", ""]) {
  test(`JSON success cannot replace the actual test step outcome ${JSON.stringify(outcome)}`, () => {
    const shards = fixture(); shards[0]!.metadata.testStepOutcome = outcome;
    assert.throws(() => verifyWindowsShards(shards, identity), /test step did not succeed/);
  });
}

for (const field of ["sourceRevision", "sourceTree", "vitestVersion"] as const) {
  test(`rejects a different ${field} in either runner or the gate checkout`, () => {
    const shards = fixture(); shards[1]!.metadata[field] = "different";
    assert.throws(() => verifyWindowsShards(shards, identity), new RegExp(field));
    assert.throws(() => verifyWindowsShards(fixture(), { ...identity, [field]: "different" }), new RegExp(field));
  });
}

for (const field of ["sourceDirty", "platform", "formatVersion"] as const) {
  test(`rejects invalid ${field}`, () => {
    const shards = fixture(); Object.assign(shards[0]!.metadata, { [field]: field === "sourceDirty" ? true : "invalid" });
    assert.throws(() => verifyWindowsShards(shards, identity), new RegExp(field));
  });
}

test("requires exactly one of each of the two assigned shards", () => {
  assert.throws(() => verifyWindowsShards(fixture().slice(0, 1), identity), /exactly two/);
  const shards = fixture(); shards[1]!.metadata.shard = "1/2";
  assert.throws(() => verifyWindowsShards(shards, identity), /shard identity/);
});

test("detects different full discovery before accepting the union", () => {
  const shards = fixture(); shards[1]!.discovered.pop();
  assert.throws(() => verifyWindowsShards(shards, identity), /discovery differs/);
});

test("rejects duplicate discovered files and case aliases", () => {
  const shards = fixture(); shards[0]!.discovered.push({ file: file("FIRST") });
  assert.throws(() => verifyWindowsShards(shards, identity), /duplicate discovered/);
});

test("rejects duplicate files within one executed shard", () => {
  const shards = fixture(); shards[0]!.results.testResults.push(shards[0]!.results.testResults[0]!);
  assert.throws(() => verifyWindowsShards(shards, identity), /duplicate executed/);
});

test("rejects a file executed by both shards even when counts look complete", () => {
  const shards = fixture(); shards[1]!.results.testResults[0]!.name = file("first");
  assert.throws(() => verifyWindowsShards(shards, identity), /overlap/);
});

test("rejects missing and additional executed files", () => {
  const missing = fixture(); missing[0]!.results.testResults.pop();
  missing[0]!.results.numTotalTests--; missing[0]!.results.numPendingTests--;
  assert.throws(() => verifyWindowsShards(missing, identity), /do not cover/);
  const extra = fixture(); extra[1]!.results.testResults[0]!.name = file("extra");
  assert.throws(() => verifyWindowsShards(extra, identity), /not discovered/);
});

for (const path of ["../escape.test.ts", `${root}/../escape.test.ts`, "C:/outside/test.test.ts", `${root}-sibling/test.test.ts`, root, "D:relative.test.ts", `${root}/test/../first.test.ts`, `${root}/test/null\0.test.ts`]) {
  test(`rejects an invalid or escaping file path ${JSON.stringify(path)}`, () => {
    const shards = fixture(); shards[0]!.discovered[0]!.file = path;
    assert.throws(() => verifyWindowsShards(shards, identity), /path/);
  });
}

for (const change of [
  (s: ReturnType<typeof fixture>) => { s[0]!.results.success = false; },
  (s: ReturnType<typeof fixture>) => { s[0]!.results.numFailedTests = 1; },
  (s: ReturnType<typeof fixture>) => { s[0]!.results.testResults[0]!.status = "failed"; },
  (s: ReturnType<typeof fixture>) => { s[0]!.results.testResults[0]!.assertionResults[0]!.status = "pending"; },
  (s: ReturnType<typeof fixture>) => { s[0]!.results.numTotalTests++; },
]) {
  test("rejects failed, incomplete or inconsistent execution reports", () => {
    const shards = fixture(); change(shards);
    assert.throws(() => verifyWindowsShards(shards, identity), /result|test count|assertion/);
  });
}

for (const malformed of [null, {}, { metadata: null }, { ...fixture()[0], discovered: {} }, { ...fixture()[0], results: [] }]) {
  test("rejects malformed or absent evidence", () => {
    assert.throws(() => verifyWindowsShards([malformed, fixture()[1]], identity));
  });
}


test("the final-gate command reads both files and binds their source to its own checkout", t => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = path.join(repository, ".tmp");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "windows-shard-gate-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (argument: string): string => {
    const result = spawnSync("git", ["rev-parse", argument], { cwd: repository, encoding: "utf8", timeout: 5_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const shards = fixture();
  for (const [index, shard] of shards.entries()) {
    Object.assign(shard.metadata, { sourceRevision: git("HEAD"), sourceTree: git("HEAD^{tree}") });
    const root = path.join(directory, String(index + 1));
    mkdirSync(root);
    for (const [name, value] of Object.entries(shard)) writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value));
  }
  const execute = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./windows-cli-shards.mts", import.meta.url)), "verify", directory], {
      cwd: repository, encoding: "utf8", timeout: 10_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.signal, null);
    return result;
  };
  const success = execute();
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /3 files across shards 2 \+ 1/);
  shards[1]!.metadata.sourceTree = "c".repeat(40);
  writeFileSync(path.join(directory, "2/metadata.json"), JSON.stringify(shards[1]!.metadata));
  const wrongTree = execute();
  assert.notEqual(wrongTree.status, 0);
  assert.match(wrongTree.stderr, /Mismatched sourceTree/);
  rmSync(path.join(directory, "2/results.json"));
  const missing = execute();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT/);
  writeFileSync(path.join(directory, "2/results.json"), "{");
  const truncated = execute();
  assert.notEqual(truncated.status, 0);
  assert.match(truncated.stderr, /SyntaxError/);
});
