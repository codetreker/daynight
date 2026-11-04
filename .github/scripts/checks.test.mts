import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/checks.yml", import.meta.url), "utf8");
const jobs = new Map([...workflow.split("\njobs:\n")[1]!.matchAll(/^  ([a-z][a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1]!, match[2]!]));
const gate = jobs.get("checks")!;
const required = gate.match(/^    needs: \[([^\]]+)\]$/m)![1]!.split(", ");
const command = gate.match(/^        run: (.+)$/m)![1]!;

test("the final gate waits for both parallel server jobs and all other jobs", () => {
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

for (const name of ["verify-server", "verify-server-e2e"]) {
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

const selectedWebStep = gate.match(/      - name: Require selected Web jobs to succeed\n([\s\S]*?)(?=      - )/)![1]!;
const selectedWebCommand = selectedWebStep.match(/        run: \|\n((?:          .+\n)+)/)![1]!
  .split("\n").filter(Boolean).map((line) => line.slice(10)).join("\n");

test("selected Web evidence requires actual quality and shard success before downloads", () => {
  assert.match(selectedWebStep, /^        if: \$\{\{ needs.detect-changes.outputs.web == 'true' \}\}$/m);
  assert.match(selectedWebStep, /WEB_QUALITY_RESULT: \$\{\{ needs.verify-web-quality.result \}\}/);
  assert.match(selectedWebStep, /WEB_SHARD_RESULT: \$\{\{ needs.verify-web.result \}\}/);
  assert.ok(gate.indexOf("Require selected Web jobs to succeed") < gate.indexOf("Download first Web shard summary"));
});

for (const quality of ["success", "skipped", "failure", "cancelled"]) {
  for (const shards of ["success", "skipped", "failure", "cancelled"]) {
    test(`selected Web quality=${quality} shards=${shards} executes the workflow guard`, () => {
      const result = spawnSync("bash", ["-e", "-c", selectedWebCommand], {
        env: { ...process.env, WEB_QUALITY_RESULT: quality, WEB_SHARD_RESULT: shards },
        encoding: "utf8", timeout: 5_000,
      });
      if (result.error) throw result.error;
      assert.equal(result.signal, null);
      assert.equal(result.status === 0, quality === "success" && shards === "success");
    });
  }
}
