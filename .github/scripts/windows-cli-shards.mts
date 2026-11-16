import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

/** Failed rerun evidence remains retained; artifact IDs do not encode upload order. */
export const selectWindowsShardArtifacts = async (readPage: (page: number) => Promise<unknown>): Promise<number[]> => {
  const artifacts: RecordValue[] = [], ids = new Set<number>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const response = object(await readPage(page), "artifact page");
    assert.ok(Number.isSafeInteger(response.total_count) && (response.total_count as number) >= 0, "Invalid artifact count.");
    if (total === undefined) total = response.total_count as number;
    else assert.equal(response.total_count, total, "Artifact inventory changed during pagination.");
    const entries = array(response.artifacts, "artifacts");
    assert.ok(entries.length > 0 || artifacts.length === total, "Artifact pagination is incomplete.");
    for (const entry of entries) {
      const artifact = object(entry, "artifact");
      assert.ok(Number.isSafeInteger(artifact.id) && (artifact.id as number) > 0, "Invalid artifact ID.");
      assert.ok(!ids.has(artifact.id as number), "Duplicate artifact ID during pagination.");
      ids.add(artifact.id as number); artifacts.push(artifact);
    }
    assert.ok(artifacts.length <= total, "Artifact inventory exceeded its declared count.");
    if (artifacts.length === total) break;
  }
  return [1, 2].map(shard => {
    const name = `daynight-cli-tests-results-windows-latest-shard-${shard}`;
    const matches = artifacts.filter(artifact => artifact.name === name).map(artifact => {
      const created = artifact.created_at;
      assert.ok(typeof created === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(created) && Number.isFinite(Date.parse(created)), "Invalid artifact creation time.");
      assert.equal(new Date(created).toISOString(), created.includes(".") ? created : created.replace("Z", ".000Z"), "Invalid artifact creation time.");
      return { artifact, timestamp: Date.parse(created) };
    }).sort((a, b) => b.timestamp - a.timestamp);
    assert.ok(matches.length > 0, `Missing artifact ${name}.`);
    assert.ok(matches.length === 1 || matches[0]!.timestamp !== matches[1]!.timestamp, `Latest artifact ${name} is ambiguous.`);
    assert.equal(matches[0]!.artifact.expired, false, `Latest artifact ${name} is expired or has invalid expiry evidence.`);
    return matches[0]!.artifact.id as number;
  });
};

export const downloadWindowsShardArtifact = async (value: unknown, repository: string, run: string, token: string,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<Uint8Array> => {
  const selected = object(value, "selected artifact");
  assert.ok(Number.isSafeInteger(selected.id) && (selected.id as number) > 0, "Invalid selected artifact ID.");
  assert.ok(typeof selected.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(selected.digest), "Missing artifact ZIP digest.");
  assert.equal(String(object(selected.workflow_run, "artifact workflow run").id), run, "Artifact belongs to a different run.");
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const url = `https://api.github.com/repos/${repository}/actions/artifacts/${selected.id}`;
  const metadata = await request(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  assert.equal(metadata.status, 200, "Selected artifact metadata could not be read.");
  const current = object(await metadata.json(), "current artifact");
  for (const key of ["id", "name", "created_at", "digest"] as const) assert.equal(current[key], selected[key], `Selected artifact ${key} changed.`);
  assert.equal(current.expired, false, "Selected artifact expired.");
  assert.equal(String(object(current.workflow_run, "current artifact workflow run").id), run, "Artifact belongs to a different run.");
  const redirect = await request(`${url}/zip`, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  assert.equal(redirect.status, 302, "Explicit artifact download did not return its archive redirect.");
  const location = new URL(redirect.headers.get("location") ?? "");
  assert.ok(location.protocol === "https:" && !location.username && !location.password, "Invalid artifact archive location.");
  // The signed storage URL authenticates itself; never forward the GitHub token.
  const archive = await request(location.href, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  assert.equal(archive.status, 200, "Artifact archive download failed.");
  const bytes = new Uint8Array(await archive.arrayBuffer());
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, selected.digest, "Artifact ZIP digest mismatch.");
  return bytes;
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
  } else if (command === "download") {
    assert.ok(argument, "Expected the Windows shard download directory.");
    const repository = process.env.GITHUB_REPOSITORY, run = process.env.GITHUB_RUN_ID;
    const token = process.env.GH_TOKEN;
    assert.ok(repository && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository), "Missing repository identity.");
    assert.ok(run && /^[1-9][0-9]*$/.test(run), "Missing workflow run identity.");
    assert.ok(token, "Missing artifact read token.");
    const inventory = new Map<number, unknown>();
    const selected = await selectWindowsShardArtifacts(async page => {
      const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${run}/artifacts?per_page=100&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      assert.ok(response.ok, `Artifact listing failed with HTTP ${response.status}.`);
      const pageValue = object(await response.json(), "artifact page");
      for (const entry of array(pageValue.artifacts, "artifacts")) { const artifact = object(entry, "artifact"); inventory.set(artifact.id as number, artifact); }
      return pageValue;
    });
    mkdirSync(argument, { recursive: true });
    for (const [index, id] of selected.entries()) {
      const bytes = await downloadWindowsShardArtifact(inventory.get(id), repository, run, token);
      writeFileSync(path.join(argument, `${index + 1}.zip`), bytes, { flag: "wx" });
    }
    console.log(`Downloaded and verified latest Windows CLI artifacts for run ${run}: ${selected.join(", ")}.`);
  } else if (command === "verify") {
    assert.ok(argument, "Expected the downloaded Windows shard directory.");
    const manifest = object(readJSON("packages/daynight/package.json"), "CLI package manifest");
    const vitestVersion = object(manifest.devDependencies, "CLI development dependencies").vitest;
    assert.equal(typeof vitestVersion, "string", "Missing pinned Vitest version.");
    const shards = [1, 2].map(index => Object.fromEntries(["metadata", "discovered", "results"].map(name => [name, readJSON(path.join(argument, String(index), `${name}.json`))])));
    const result = verifyWindowsShards(shards, { ...source(), vitestVersion: vitestVersion as string });
    console.log(`Verified complete Windows CLI execution: ${result.files} files across shards ${result.shards.join(" + ")}.`);
  } else throw new Error("Use windows-cli-shards.mts record <1/2|2/2>, download <directory>, or verify <directory>.");
}
