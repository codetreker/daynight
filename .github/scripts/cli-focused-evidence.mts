import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type Obj = Record<string, any>;
const obj = (v: unknown, name: string): Obj => { assert.ok(v && typeof v === "object" && !Array.isArray(v), `Invalid ${name}`); return v as Obj; };
const arr = (v: unknown, name: string): unknown[] => { assert.ok(Array.isArray(v), `Invalid ${name}`); return v; };
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const git = (...args: string[]): string => {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const source = () => ({ sourceRevision: git("rev-parse", "HEAD"), sourceTree: git("rev-parse", "HEAD^{tree}") });
const gitObject = (file: string): string | null => {
  const entry = git("ls-tree", "HEAD", "--", file);
  return entry ? entry.split(/\s+/)[2]! : null;
};
const labels = ["linux-full", "windows-full-1", "windows-full-2", "windows-focused-1", "windows-focused-2", "macos-full", "macos-focused"] as const;
const canonical = (root: unknown, file: unknown, platform: string): string => {
  assert.equal(typeof root, "string"); assert.equal(typeof file, "string");
  const impl = platform === "win32" ? path.win32 : path.posix;
  for (const p of [root as string, file as string]) {
    assert.ok(impl.isAbsolute(p) && !p.includes("\0") && !p.split(platform === "win32" ? /[\\/]/ : /\//).some(x => x === "." || x === ".."), "Invalid absolute path");
  }
  const relative = impl.relative(root as string, file as string);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${impl.sep}`) && !impl.isAbsolute(relative), "Path escapes package root");
  return relative.replaceAll("\\", "/");
};
const add = (set: Set<string>, key: string, label: string) => { assert.ok(!set.has(key), `Duplicate ${label}: ${key}`); set.add(key); };
const same = (a: Set<string>, b: Set<string>, label: string) => assert.deepEqual([...a].sort(), [...b].sort(), label);
const discoverFiles = (discovered: unknown, packageRoot: string, platform: string): Set<string> => {
  assert.ok(platform === "win32" || platform === "darwin" || platform === "linux", "Invalid discovery platform");
  const files = new Set<string>();
  for (const entry of arr(discovered, "discovery")) {
    const spec = obj(entry, "specification");
    assert.ok(spec.projectName === undefined || spec.projectName === "", "Named projects are unsupported");
    add(files, canonical(packageRoot, spec.file, platform), "discovered file");
  }
  assert.ok(files.size, "Empty discovery");
  return files;
};
const focusedFiles = (full: Set<string>, portable: Set<string>): Set<string> => {
  assert.ok(portable.size, "Empty portable manifest");
  for (const file of portable) assert.ok(full.has(file), `Stale portable path: ${file}`);
  const focused = new Set([...full].filter(file => !portable.has(file)));
  assert.ok(focused.size, "Empty focused plan");
  return focused;
};

const guardPaths = ["packages/daynight/src", "packages/daynight/test", "packages/daynight/scripts", "packages/daynight/package.json", "packages/daynight/vitest.config.ts", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "packages/daynight/tsconfig.json", "packages/daynight/tsconfig.build.json", "packages/daynight/vitest.focused-evidence.config.ts", "patches", ".npmrc", ".github/workflows/cli-focused-evidence.yml"];
export function portableFiles(manifest: unknown, blob: (file: string) => string | null): Set<string> {
  const value = obj(manifest, "portable manifest"), guards = obj(value.guards, "classification guards");
  assert.deepEqual(Object.keys(guards).sort(), [...guardPaths].sort(), "Invalid classification guard paths");
  for (const file of guardPaths) {
    assert.ok((file === ".npmrc" && guards[file] === null) || (typeof guards[file] === "string" && /^[a-f0-9]{40}$/.test(guards[file])), `Invalid guard: ${file}`);
    assert.equal(blob(file), guards[file], `Stale classification guard: ${file}`);
  }
  const files = new Set<string>();
  for (const item of arr(value.files, "portable files")) {
    const entry = obj(item, "portable entry");
    assert.ok(typeof entry.path === "string" && /^test\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.test\.[cm]?[jt]sx?$/.test(entry.path) && !entry.path.split("/").some((part: string) => part === "." || part === ".."), "Invalid portable path");
    assert.ok(typeof entry.reason === "string" && entry.reason.trim(), `Missing reason: ${entry.path}`);
    assert.ok(typeof entry.blob === "string" && /^[a-f0-9]{40}$/.test(entry.blob), `Invalid blob: ${entry.path}`);
    add(files, entry.path, "portable file");
    assert.equal(blob(`packages/daynight/${entry.path}`), entry.blob, `Stale portable file: ${entry.path}`);
  }
  assert.ok(files.size, "Empty portable manifest");
  return files;
}

export const preflightFocusedPlan = (manifest: unknown, blob: (file: string) => string | null, discovered: unknown, packageRoot: string, platform: string): { full: Set<string>; focused: Set<string> } => {
  const portable = portableFiles(manifest, blob);
  const full = discoverFiles(discovered, packageRoot, platform);
  return { full, focused: focusedFiles(full, portable) };
};

interface Expected { sourceRevision: string; sourceTree: string; vitestVersion: string; pnpmVersion: string; prHead: string; prRef: string }
interface Evidence { metadata: unknown; discovered: unknown; results: unknown }
interface Run { files: Set<string>; discovery: Set<string>; assertions: Map<string, string[]>; passed: Map<string, Set<string>> }
export function verifyFocusedEvidence(evidence: Record<string, Evidence>, expected: Expected, portable: Set<string>): void {
  assert.ok(/^[a-f0-9]{40}$/.test(expected.prHead) && expected.prRef, "Invalid PR identity");
  assert.ok(/^[a-f0-9]{40}$/.test(expected.sourceRevision) && /^[a-f0-9]{40}$/.test(expected.sourceTree), "Invalid checkout identity");
  assert.equal(expected.pnpmVersion, "11.28.6", "Invalid expected pnpm version");
  assert.ok(portable.size, "Empty portable manifest");
  const runs = new Map<string, Run>();
  let discovery: Set<string> | undefined;
  let nodeVersion: string | undefined;
  const executionOrigins = new Set<string>();
  const comparisonGroups = new Set<string | undefined>();
  for (const label of labels) {
    const e = obj(evidence[label], `evidence ${label}`), m = obj(e.metadata, `metadata ${label}`);
    const platform = label.startsWith("windows") ? "win32" : label.startsWith("macos") ? "darwin" : "linux";
    const arch = platform === "darwin" ? "arm64" : "x64";
    const shard = label.match(/-(1|2)$/)?.[1];
    assert.equal(m.formatVersion, 2); assert.equal(m.label, label); assert.equal(m.platform, platform); assert.equal(m.arch, arch);
    assert.equal(m.shard, shard ? `${shard}/2` : "");
    assert.equal(m.sourceDirty, false, `Dirty source: ${label}`); assert.equal(m.testStepOutcome, "success", `Test step failed: ${label}`);
    const hosted = [m.githubRunId, m.githubRunAttempt, m.githubJob].some(value => value !== undefined);
    if (hosted) {
      assert.ok(typeof m.githubRunId === "string" && /^[1-9][0-9]*$/.test(m.githubRunId), `Invalid GitHub run: ${label}`);
      assert.ok(typeof m.githubRunAttempt === "string" && /^[1-9][0-9]*$/.test(m.githubRunAttempt), `Invalid GitHub attempt: ${label}`);
      assert.ok(typeof m.githubJob === "string" && m.githubJob.length, `Invalid GitHub job: ${label}`);
    }
    executionOrigins.add(hosted ? `github:${m.githubRunId}` : "local");
    assert.equal(executionOrigins.size, 1, "Mixed execution origins or GitHub runs");
    assert.ok(m.comparisonGroup === undefined || typeof m.comparisonGroup === "string" && m.comparisonGroup.length, `Invalid comparison group: ${label}`);
    comparisonGroups.add(m.comparisonGroup);
    assert.equal(comparisonGroups.size, 1, "Mixed comparison groups");
    for (const k of ["sourceRevision", "sourceTree", "vitestVersion", "pnpmVersion", "prHead", "prRef"] as const) assert.equal(m[k], expected[k], `Mismatched ${k}: ${label}`);
    assert.ok(typeof m.nodeVersion === "string" && /^v24\./.test(m.nodeVersion), `Invalid Node version: ${label}`);
    if (nodeVersion) assert.equal(m.nodeVersion, nodeVersion, `Mismatched Node version: ${label}`); else nodeVersion = m.nodeVersion;
    const found = discoverFiles(e.discovered, m.packageRoot, platform);
    focusedFiles(found, portable);
    if (discovery) same(found, discovery, `Discovery differs: ${label}`); else discovery = found;
    const result = obj(e.results, "results");
    assert.equal(result.success, true); assert.equal(result.numFailedTestSuites, 0); assert.equal(result.numFailedTests, 0);
    const files = new Set<string>(), assertions = new Map<string, string[]>(), passed = new Map<string, Set<string>>();
    const counts = { passed: 0, skipped: 0, todo: 0 };
    for (const entry of arr(result.testResults, "test results")) {
      const module = obj(entry, "module"), file = canonical(m.packageRoot, module.name, platform);
      add(files, file, "executed file"); assert.ok(found.has(file), `Undiscovered file: ${file}`);
      assert.equal(module.status, "passed", `Failed module: ${file}`); assert.equal(module.message, "", `Module error: ${file}`);
      const cases: string[] = [], passing = new Set<string>();
      for (const raw of arr(module.assertionResults, "assertions")) {
        const a = obj(raw, "assertion"), state = a.status;
        assert.ok(state === "passed" || state === "skipped" || state === "todo", `Invalid assertion: ${file}`);
        assert.ok(typeof a.title === "string" && a.title.length && Array.isArray(a.ancestorTitles) && a.ancestorTitles.every((title: unknown) => typeof title === "string"), `Missing test identity: ${file}`);
        assert.deepEqual(a.failureMessages, []); counts[state as keyof typeof counts]++;
        const identity = JSON.stringify([a.ancestorTitles, a.title]);
        cases.push(JSON.stringify([identity, state])); if (state === "passed") passing.add(identity);
      }
      assertions.set(file, cases.sort()); passed.set(file, passing);
    }
    assert.ok(files.size, `Empty execution: ${label}`);
    for (const [key, count] of Object.entries({ numTotalTests: counts.passed + counts.skipped + counts.todo, numPassedTests: counts.passed, numPendingTests: counts.skipped, numTodoTests: counts.todo })) assert.equal(result[key], count, `Inconsistent ${key}: ${label}`);
    runs.set(label, { files, discovery: found, assertions, passed });
  }
  const full = discovery!;
  for (const file of portable) {
    assert.ok(full.has(file), `Stale portable path: ${file}`);
    assert.ok(runs.get("linux-full")!.passed.get(file)?.size, `Portable file did not pass on Linux: ${file}`);
  }
  const focused = focusedFiles(full, portable);
  same(runs.get("linux-full")!.files, full, "Linux full execution differs");
  const union = (a: string, b: string): Run => {
    const first = runs.get(a)!, second = runs.get(b)!;
    for (const file of second.files) assert.ok(!first.files.has(file), `Shard overlap: ${file}`);
    return { files: new Set([...first.files, ...second.files]), discovery: first.discovery, assertions: new Map([...first.assertions, ...second.assertions]), passed: new Map([...first.passed, ...second.passed]) };
  };
  const wf = union("windows-full-1", "windows-full-2"), wc = union("windows-focused-1", "windows-focused-2"), mf = runs.get("macos-full")!, mc = runs.get("macos-focused")!;
  same(wf.files, full, "Windows full union differs"); same(wc.files, focused, "Windows focused union differs");
  same(mf.files, full, "macOS full execution differs"); same(mc.files, focused, "macOS focused execution differs");
  for (const [baseline, candidate] of [[wf, wc], [mf, mc]]) for (const file of focused) assert.deepEqual(candidate.assertions.get(file), baseline.assertions.get(file), `Test identities or statuses differ: ${file}`);
  for (const [run, file, name] of [
    [wc, "test/platform/windows-suspended-process.test.ts", JSON.stringify([[], "keeps the native thread suspended until its owner resumes and joins it"])],
    [mc, "test/commands/controller/markdown/local-source-filesystem-darwin.test.ts", JSON.stringify([["local image filesystem records"], "recognizes the actual local Darwin filesystem by name and mount flags"])],
  ] as const) assert.ok(run.passed.get(file)?.has(name), `Native sentinel did not pass: ${file} ${name}`);
}

const runCommand = (): void => {
  const [command, argument, ...extra] = process.argv.slice(2); assert.equal(extra.length, 0);
  if (command === "preflight") {
    assert.ok(argument, "Full discovery file required");
    assert.equal(git("status", "--porcelain"), "", "Preflight checkout must be clean");
    const plan = preflightFocusedPlan(read(".github/scripts/cli-portable-files.json"), gitObject, read(argument), path.resolve("packages/daynight"), process.platform);
    console.log(`Validated focused plan: ${plan.full.size} discovered files, ${plan.focused.size} retained files.`);
    return;
  }
  const prHead = process.env.PR_HEAD_SHA, prRef = process.env.PR_HEAD_REF;
  assert.ok(prHead && prRef, "PR_HEAD_SHA and PR_HEAD_REF are required");
  if (command === "record") {
    assert.ok(labels.includes(argument as typeof labels[number]), "Invalid evidence label");
    const packageRoot = path.resolve("packages/daynight"), require = createRequire(path.join(packageRoot, "package.json"));
    const pnpm = spawnSync(process.platform === "win32" ? "cmd.exe" : "pnpm", process.platform === "win32" ? ["/d", "/s", "/c", "pnpm --version"] : ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (pnpm.error) throw pnpm.error;
    assert.equal(pnpm.status, 0, `pnpm version failed: ${pnpm.stderr}`);
    const metadata = {
      formatVersion: 2, label: argument, ...source(), sourceDirty: git("status", "--porcelain") !== "",
      vitestVersion: require("vitest/package.json").version, pnpmVersion: pnpm.stdout.trim(), nodeVersion: process.version,
      platform: process.platform, arch: process.arch, packageRoot, shard: argument.match(/-(1|2)$/)?.[1] ? `${argument.at(-1)}/2` : "",
      prHead, prRef, testStepOutcome: process.env.CLI_TEST_RESULT, githubRunId: process.env.GITHUB_RUN_ID,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT, githubJob: process.env.GITHUB_JOB, comparisonGroup: process.env.CLI_COMPARISON_GROUP,
    };
    const directory = path.resolve(".tmp/focused-evidence", argument); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  } else if (command === "verify") {
    assert.ok(argument, "Evidence directory required");
    assert.equal(git("status", "--porcelain"), "", "Verifier checkout must be clean");
    const manifest = obj(read("packages/daynight/package.json"), "package manifest");
    const expected = { ...source(), vitestVersion: obj(manifest.devDependencies, "dependencies").vitest, pnpmVersion: "11.28.6", prHead, prRef };
    const portable = portableFiles(read(".github/scripts/cli-portable-files.json"), gitObject);
    const evidence = Object.fromEntries(labels.map(label => [label, Object.fromEntries(["metadata", "discovered", "results"].map(name => [name, read(path.join(argument, label, `${name}.json`))]))])) as Record<string, Evidence>;
    verifyFocusedEvidence(evidence, expected, portable);
    console.log(`Verified ${portable.size} portable files and complete native focused execution against full reports.`);
  } else throw new Error("Use preflight <full-discovery.json>, record <label> or verify <directory>");
};

if (import.meta.main) runCommand();
