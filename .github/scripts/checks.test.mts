import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const workflow = readFileSync(new URL("../workflows/checks.yml", import.meta.url), "utf8");
const jobs = new Map([...workflow.split("\njobs:\n")[1]!.matchAll(/^  ([a-z][a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1]!, match[2]!]));
const gate = jobs.get("checks")!;
const required = gate.match(/^    needs: \[([^\]]+)\]$/m)![1]!.split(", ");
const command = gate.match(/^        run: (.+)$/m)![1]!;

test("the final gate waits for every selected verification job", () => {
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(new Set(required), new Set([...jobs.keys()].filter((name) => name !== "checks")));
  for (const [name, mode] of [["verify-server", "coverage"], ["verify-server-e2e", "e2e"]]) {
    const job = jobs.get(name!)!;
    assert.match(job, /^    needs: detect-changes$/m);
    assert.match(job, /^    if: \$\{\{ needs.detect-changes.outputs.server == 'true' \}\}$/m);
    assert.ok(job.includes(`run: bash scripts/check.sh --${mode}`));
  }
  assert.match(gate, /JOB_RESULTS: \$\{\{ toJSON\(needs\.\*\.result\) \}\}/);
});

const runGate = (results: Record<string, string>): number | null => {
  const result = spawnSync("bash", ["-c", command], {
    env: { ...process.env, JOB_RESULTS: JSON.stringify(Object.values(results)) },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return result.status;
};

const success = Object.fromEntries(required.map((name) => [name, "success"]));

test("both successful server jobs pass the actual workflow gate", () => {
  assert.equal(runGate(success), 0);
});

for (const name of ["verify-release", "verify-server", "verify-server-e2e"]) {
  for (const result of ["failure", "cancelled"]) {
    test(`${name} ${result} fails the actual workflow gate independently`, () => {
      assert.notEqual(runGate({ ...success, [name]: result }), 0);
    });
  }
}

test("unaffected application jobs may all skip while detection succeeds", () => {
  assert.equal(runGate(Object.fromEntries(required.map((name) => [name, name === "detect-changes" ? "success" : "skipped"]))), 0);
});

test("change detection failure remains visible when application jobs skip", () => {
  assert.notEqual(runGate(Object.fromEntries(required.map((name) => [name, name === "detect-changes" ? "failure" : "skipped"]))), 0);
});

const release = jobs.get("verify-release")!;
const releaseSmoke = release.match(/      - name: Verify the installed release version and help\n        run: \|\n([\s\S]*?)(?=      - |$)/)![1]!
  .split("\n").map((line) => line.replace(/^          /, "")).join("\n");

test("version-only PRs have one isolated release job and normal CLI matrices keep their own gate", () => {
  assert.match(release, /^    needs: detect-changes$/m);
  assert.match(release, /^    if: \$\{\{ needs.detect-changes.outputs.release == 'true' \}\}$/m);
  assert.match(release, /^    runs-on: ubuntu-latest$/m);
  assert.match(release, /^          node-version: 24$/m);
  assert.ok(release.includes("pnpm install --frozen-lockfile --filter @codetreker/daynight"));
  assert.ok(release.includes("run: pnpm build"));
  assert.ok(release.includes('run: node packages/daynight/scripts/publish.ts prepare "$GITHUB_SHA"'));
  assert.ok(release.includes("npm install --prefix .tmp/npm-release/consumer --ignore-scripts"));
  for (const name of ["verify", "verify-runtime", "verify-completion"]) {
    assert.match(jobs.get(name)!, /^    if: \$\{\{ needs.detect-changes.outputs.cli == 'true' \}\}$/m);
  }
});

test("a successful release check passes while ordinary application jobs skip", () => {
  assert.equal(runGate(Object.fromEntries(required.map((name) => [name, ["detect-changes", "verify-release"].includes(name) ? "success" : "skipped"]))), 0);
});

const runReleaseSmoke = (t: TestContext, changedAlias: string, version: string, versionStatus: number, helpStatus: number) => {
  const temporary = fileURLToPath(new URL("../../.tmp/", import.meta.url));
  mkdirSync(temporary, { recursive: true });
  const cwd = mkdtempSync(join(temporary, "release-smoke-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "packages/daynight"), { recursive: true });
  writeFileSync(join(cwd, "packages/daynight/package.json"), JSON.stringify({ version: "1.2.3" }));
  const bin = join(cwd, ".tmp/npm-release/consumer/node_modules/.bin");
  const calls = join(cwd, "calls.jsonl");
  mkdirSync(bin, { recursive: true });
  for (const alias of ["daynight", "dn"]) {
    const altered = alias === changedAlias;
    writeFileSync(join(bin, alias), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(alias)}, process.argv[2]]) + "\\n");
if (process.argv[2] === "--version") {
  console.log(${JSON.stringify(altered ? version : "1.2.3")});
  process.exit(${altered ? versionStatus : 0});
}
if (process.argv[2] === "--help") process.exit(${altered ? helpStatus : 0});
process.exit(1);
`, { mode: 0o755 });
  }
  const result = spawnSync("bash", ["-e", "-c", releaseSmoke], { cwd, encoding: "utf8", timeout: 5_000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return { status: result.status, calls: readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
};

test("the actual release smoke command checks both installed aliases", (t) => {
  const result = runReleaseSmoke(t, "", "1.2.3", 0, 0);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [["daynight", "--version"], ["daynight", "--help"], ["dn", "--version"], ["dn", "--help"]]);
});

for (const alias of ["daynight", "dn"]) {
  test(`${alias} version mismatch fails the actual release smoke command`, (t) => {
    assert.notEqual(runReleaseSmoke(t, alias, "1.2.2", 0, 0).status, 0);
  });
  test(`${alias} version command failure remains visible even with matching output`, (t) => {
    assert.notEqual(runReleaseSmoke(t, alias, "1.2.3", 1, 0).status, 0);
  });
  test(`${alias} help failure fails the actual release smoke command`, (t) => {
    assert.notEqual(runReleaseSmoke(t, alias, "1.2.3", 0, 1).status, 0);
  });
}
