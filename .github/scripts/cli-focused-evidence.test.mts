import assert from "node:assert/strict";
import { test } from "node:test";
import { portableFiles, verifyFocusedEvidence } from "./cli-focused-evidence.mts";

const identity = { sourceRevision: "a".repeat(40), sourceTree: "b".repeat(40), vitestVersion: "5.0.5", prHead: "a".repeat(40), prRef: "feature" };
const paths = ["test/portable.test.ts", "test/platform/windows-suspended-process.test.ts", "test/commands/controller/markdown/local-source-filesystem.test.ts"];
const nativeNames = ["portable", "keeps the native thread suspended until its owner resumes and joins it", "local image filesystem records recognizes the actual local Darwin filesystem by name and mount flags"];
const portable = new Set([paths[0]!]);
function fixture(): Record<string, any> {
  const labels = ["linux-full", "windows-full-1", "windows-full-2", "windows-focused-1", "windows-focused-2", "macos-full", "macos-focused"];
  return Object.fromEntries(labels.map(label => {
    const windows = label.startsWith("windows"), mac = label.startsWith("macos"), platform = windows ? "win32" : mac ? "darwin" : "linux";
    const root = windows ? "C:\\work\\packages\\daynight" : "/work/packages/daynight";
    const absolute = (p: string) => windows ? `${root}\\${p.replaceAll("/", "\\")}` : `${root}/${p}`;
    const focused = label.includes("focused"), shard = /-([12])$/.exec(label)?.[1];
    const selected = paths.filter((p, index) => (!focused || index !== 0) && (!shard || (focused ? index % 2 === Number(shard) % 2 : index % 2 === Number(shard) - 1)));
    const testResults = selected.map(p => {
      const index = paths.indexOf(p), status = index === 1 && !windows || index === 2 && !mac ? "skipped" : "passed";
      return { name: absolute(p), status: "passed", message: "", assertionResults: [{ ancestorTitles: index === 2 ? ["local image filesystem records"] : [], title: index === 2 ? "recognizes the actual local Darwin filesystem by name and mount flags" : nativeNames[index], status, failureMessages: [] }] };
    });
    const passed = testResults.filter(x => x.assertionResults[0]!.status === "passed").length;
    return [label, { metadata: { ...identity, formatVersion: 1, label, platform, arch: mac ? "arm64" : "x64", nodeVersion: "v24.19.0", shard: shard ? `${shard}/2` : "", packageRoot: root, sourceDirty: false, testStepOutcome: "success" }, discovered: paths.map(file => ({ file: absolute(file) })), results: { success: true, numFailedTestSuites: 0, numFailedTests: 0, numTotalTests: selected.length, numPassedTests: passed, numPendingTests: selected.length - passed, numTodoTests: 0, testResults } }];
  }));
}
const verify = (e: Record<string, any>) => verifyFocusedEvidence(e, identity, portable);
test("verifies executed sets, native sentinels and matching retained case states", () => verify(fixture()));
test("rejects stale, duplicate, malformed and empty portable classifications", () => {
  const blob = "1".repeat(40), good = { path: paths[0], blob, reason: "DTO" };
  const guards = Object.fromEntries(["packages/daynight/src", "packages/daynight/test", "packages/daynight/scripts", "packages/daynight/package.json", "packages/daynight/vitest.config.ts", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "packages/daynight/tsconfig.json", "packages/daynight/tsconfig.build.json", "packages/daynight/vitest.focused-evidence.config.ts", "patches", ".github/workflows/cli-focused-evidence.yml"].map(path => [path, blob]));
  guards[".npmrc"] = null as any;
  const get = (path: string) => path === ".npmrc" ? null : blob;
  assert.deepEqual(portableFiles({ files: [good], guards }, get), portable);
  assert.throws(() => portableFiles({ files: [good], guards: { ...guards, "packages/daynight/src": "2".repeat(40) } }, get), /Stale classification guard/);
  assert.throws(() => portableFiles({ files: [good], guards: {} }, get), /guard paths/);
  assert.throws(() => portableFiles({ files: [good], guards }, path => path === ".github/workflows/cli-focused-evidence.yml" ? "2".repeat(40) : get(path)), /Stale classification guard/);
  for (const files of [[], [good, good], [{ ...good, path: "test/../outside.test.ts" }], [{ ...good, blob: "2".repeat(40) }], [{ ...good, reason: "" }]]) assert.throws(() => portableFiles({ files, guards }, get));
});
test("rejects identity mismatch, dirty sources, unsuccessful step and wrong architecture", () => {
  for (const [field, value] of Object.entries({ sourceRevision: "c".repeat(40), sourceTree: "c".repeat(40), vitestVersion: "other", prHead: "c".repeat(40), prRef: "other", sourceDirty: true, testStepOutcome: "failure", arch: "x64", nodeVersion: "v22.0.0" })) {
    const e = fixture(); e["macos-full"].metadata[field] = value; assert.throws(() => verify(e), field);
  }
});
test("rejects missing or duplicate discovery, escaping paths and a stale manifest", () => {
  for (const change of [
    (e: any) => e["linux-full"].discovered.pop(),
    (e: any) => e["linux-full"].discovered.push(e["linux-full"].discovered[0]),
    (e: any) => e["linux-full"].discovered[0].file = "/outside/test.test.ts",
    (e: any) => e["linux-full"].discovered = [],
  ]) { const e = fixture(); change(e); assert.throws(() => verify(e)); }
  assert.throws(() => verifyFocusedEvidence(fixture(), identity, new Set(["test/absent.test.ts"])), /Stale portable/);
});
test("rejects missing, duplicate or overlapping execution and wrong counts", () => {
  for (const change of [
    (e: any) => e["windows-focused-1"].results.testResults = [],
    (e: any) => e["macos-full"].results.testResults.push(e["macos-full"].results.testResults[0]),
    (e: any) => e["windows-focused-1"].results.testResults[0].name = e["windows-focused-2"].results.testResults[0].name,
    (e: any) => e["macos-full"].results.numPassedTests++,
    (e: any) => e["linux-full"].results.success = false,
  ]) { const e = fixture(); change(e); assert.throws(() => verify(e)); }
});
test("rejects changed skip semantics and a skipped native sentinel", () => {
  const e = fixture(); e["macos-focused"].results.testResults[0].assertionResults[0].status = "passed";
  e["macos-focused"].results.numPassedTests++; e["macos-focused"].results.numPendingTests--;
  assert.throws(() => verify(e), /identities or statuses/);
  const s = fixture(); for (const label of ["macos-full", "macos-focused"]) {
    const report = s[label].results, a = report.testResults.find((x: any) => x.name.endsWith("local-source-filesystem.test.ts")).assertionResults[0];
    a.status = "skipped"; report.numPassedTests--; report.numPendingTests++;
  }
  assert.throws(() => verify(s), /sentinel/);
});

test("distinguishes suite and case names that produce the same fullName", () => {
  const e = fixture();
  const a = e["macos-focused"].results.testResults[0].assertionResults[0];
  a.ancestorTitles = ["portable"]; a.title = "";
  assert.throws(() => verify(e), /identity/);
  a.ancestorTitles = ["keeps"]; a.title = "the native thread suspended until its owner resumes and joins it";
  assert.throws(() => verify(e), /identities or statuses/);
});
