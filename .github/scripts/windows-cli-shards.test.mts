import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadWindowsShardArtifact, selectWindowsShardArtifacts, verifyWindowsShards } from "./windows-cli-shards.mts";

test("explicit artifact download binds metadata and ZIP digest without forwarding authorization", async () => {
  const zip = new TextEncoder().encode("controlled ZIP bytes");
  const selected = { id: 3, name: "daynight-cli-tests-results-windows-latest-shard-1", created_at: "2026-11-16T13:22:00Z", expired: false,
    digest: `sha256:${createHash("sha256").update(zip).digest("hex")}`, workflow_run: { id: 42 } };
  const calls: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal(init?.redirect, "manual");
    if (url === "https://storage.example/archive.zip") {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return new Response(zip);
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-token");
    if (url.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: "https://storage.example/archive.zip" } });
    return Response.json(selected);
  };
  assert.deepEqual(await downloadWindowsShardArtifact(selected, "owner/repo", "42", "private-token", request), zip);
  assert.deepEqual(calls, ["https://api.github.com/repos/owner/repo/actions/artifacts/3", "https://api.github.com/repos/owner/repo/actions/artifacts/3/zip", "https://storage.example/archive.zip"]);
  for (const changed of [{ ...selected, id: 4 }, { ...selected, name: "other" }, { ...selected, workflow_run: { id: 41 } }, { ...selected, expired: true }, { ...selected, digest: `sha256:${"0".repeat(64)}` }, { ...selected, created_at: "2026-11-16T13:09:00Z" }]) {
    await assert.rejects(downloadWindowsShardArtifact(selected, "owner/repo", "42", "private-token", async () => Response.json(changed)), /changed|run|expired/);
  }
  await assert.rejects(downloadWindowsShardArtifact(selected, "owner/repo", "42", "private-token", async (url, init) => url.startsWith("https://storage.") ? new Response("wrong bytes") : request(url, init)), /digest/);
});

const artifact = (id: number, shard: number, created_at: string) => ({ id, name: `daynight-cli-tests-results-windows-latest-shard-${shard}`, created_at, expired: false });
test("rerun selection reads every page and uses creation time, not artifact ID or API order", async () => {
  const old = artifact(14229340225, 1, "2026-11-16T13:09:00Z");
  const latest = artifact(14228644433, 1, "2026-11-16T13:22:00Z");
  const second = artifact(7, 2, "2026-11-16T13:10:00Z");
  const pages = [[old, second], [latest]], calls: number[] = [];
  assert.deepEqual(await selectWindowsShardArtifacts(async page => {
    calls.push(page); return { total_count: 3, artifacts: pages[page - 1] };
  }), [latest.id, second.id]);
  assert.deepEqual(calls, [1, 2]);
});

test("artifact selection rejects equal newest timestamps, expired newest evidence and incomplete pagination", async () => {
  const first = artifact(1, 1, "2026-11-16T13:22:00Z"), second = artifact(2, 2, "2026-11-16T13:22:00Z");
  for (const extra of [{ ...first, id: 3 }, { ...first, id: 3, expired: true, created_at: "2026-11-16T13:23:00Z" }]) {
    await assert.rejects(selectWindowsShardArtifacts(async () => ({ total_count: 3, artifacts: [first, second, extra] })), /ambiguous|expired/);
  }
  await assert.rejects(selectWindowsShardArtifacts(async page => ({ total_count: 3, artifacts: page === 1 ? [first, second] : [] })), /incomplete/);
  await assert.rejects(selectWindowsShardArtifacts(async () => ({ total_count: 2, artifacts: [first, { ...second, name: `${second.name}-old` }] })), /Missing/);
});

test("artifact pagination rejects changed counts, duplicate identities and invalid creation times", async () => {
  const first = artifact(1, 1, "2026-11-16T13:22:00Z");
  await assert.rejects(selectWindowsShardArtifacts(async page => ({ total_count: page === 1 ? 2 : 3, artifacts: [first] })), /changed/);
  await assert.rejects(selectWindowsShardArtifacts(async () => ({ total_count: 2, artifacts: [first] })), /Duplicate/);
  await assert.rejects(selectWindowsShardArtifacts(async () => ({ total_count: 1, artifacts: [{ ...first, created_at: "invalid" }] })), /creation time/);
});

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
