import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/checks.yml", import.meta.url), "utf8");
const jobs = new Map([...workflow.split("\njobs:\n")[1]!.matchAll(/^  ([a-z][a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1]!, match[2]!]));
const gate = jobs.get("checks")!;
const required = gate.match(/^    needs: \[([^\]]+)\]$/m)![1]!.split(", ");
const command = gate.match(/^        run: (.+)$/m)![1]!;

test("the final gate waits for every independent validation stage", () => {
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(new Set(required), new Set([...jobs.keys()].filter((name) => name !== "checks")));
  for (const [name, mode] of [["verify-server", "coverage"], ["verify-server-e2e", "e2e"]]) {
    const job = jobs.get(name!)!;
    assert.match(job, /^    needs: detect-changes$/m);
    assert.match(job, /^    if: \$\{\{ needs.detect-changes.outputs.server == 'true' \}\}$/m);
    assert.ok(job.includes(`run: bash scripts/check.sh --${mode}`));
    assert.ok(job.includes("DAYNIGHT_TEST_RACE: ${{ github.event_name != 'pull_request' }}"));
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

for (const name of ["verify", "verify-installed", "verify-macos", "verify-server", "verify-server-e2e"]) {
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

const ordinary = jobs.get("verify")!;
const installed = jobs.get("verify-installed")!;
const nativeStages = [ordinary, installed];
const nativePlatforms = ["ubuntu-latest", "windows-latest"];
const macos = jobs.get("verify-macos")!;

test("Ubuntu and Windows retain independent ordinary and installed CLI matrices", () => {
  for (const stage of nativeStages) {
    assert.match(stage, /^    needs: detect-changes$/m);
    assert.match(stage, /^    if: \$\{\{ needs.detect-changes.outputs.cli == 'true' \}\}$/m);
    assert.match(stage, /^      fail-fast: false$/m);
    assert.deepEqual(stage.match(/^        os: \[([^\]]+)\]$/m)![1]!.split(", "), nativePlatforms);
    assert.match(stage, /^    runs-on: \$\{\{ matrix.os \}\}$/m);
    assert.match(stage, /^    timeout-minutes: 10$/m);
    assert.match(stage, /^          node-version: 24$/m);
    assert.match(stage, /^          check-latest: true$/m);
    assert.ok(stage.includes("run: pnpm install --frozen-lockfile --store-dir .tmp/pnpm-store"));
    assert.ok(stage.includes("run: node packages/daynight/scripts/validation-environment.ts"));
    assert.ok(stage.includes("run: pnpm build"));
    assert.doesNotMatch(stage, /VITEST_MAX_WORKERS|--maxWorkers|--no-isolate|continue-on-error/);
  }
});

test("ordinary CLI owns source checks while installed CLI owns the complete installed configuration", () => {
  assert.ok(ordinary.includes("run: pnpm typecheck"));
  assert.ok(ordinary.includes("run: pnpm dev:test"));
  assert.match(ordinary, /^        run: pnpm --filter @codetreker\/daynight exec vitest run$/m);
  assert.ok(!ordinary.includes("vitest.acceptance.config.ts"));
  assert.match(installed, /^        run: pnpm --filter @codetreker\/daynight exec vitest run --config vitest.acceptance.config.ts$/m);
  assert.doesNotMatch(installed, /^        run: pnpm (?:typecheck|dev:test)$/m);
  assert.doesNotMatch(installed, /^        run: pnpm --filter @codetreker\/daynight exec vitest run$/m);
});

const uploadSteps = (stage: string): string[] => [...stage.matchAll(/^      - [\s\S]*?(?=^      - |$(?![\s\S]))/gm)]
  .map((match) => match[0]).filter((step) => /uses: actions\/upload-artifact@/.test(step));
const artifactName = (step: string): string => step.match(/^          name: (.+)$/m)![1]!;
const artifactPaths = (step: string): string[] => {
  const value = step.match(/^          path: (.+)$/m)![1]!;
  return value === "|" ? [...step.matchAll(/^            (.+)$/gm)].map((match) => match[1]!) : [value];
};

test("the ordinary Ubuntu producer alone supplies the runtime matrix package", () => {
  const runtime = jobs.get("verify-runtime")!;
  assert.match(runtime, /^    needs: \[detect-changes, verify\]$/m);
  const producers = [...jobs.entries()].filter(([, stage]) => stage.includes('pack --out "${{ github.workspace }}/.tmp/daynight-runtime.tgz"'));
  assert.deepEqual(producers.map(([name]) => name), ["verify"]);
  const upload = uploadSteps(ordinary).find((step) => artifactName(step) === "daynight-runtime-package")!;
  assert.ok(upload);
  assert.match(upload, /^        if: matrix.os == 'ubuntu-latest'$/m);
  assert.deepEqual(artifactPaths(upload), [".tmp/daynight-runtime.tgz"]);
  assert.ok(runtime.includes("name: daynight-runtime-package"));
  assert.ok(!installed.includes("daynight-runtime-package"));
});

test("native stages retain phase-owned environment, acceptance and failure-probe artifacts without collisions", () => {
  const ordinaryUploads = uploadSteps(ordinary);
  const installedUploads = uploadSteps(installed);
  assert.deepEqual(ordinaryUploads.map(artifactName), ["daynight-runtime-package", "daynight-cli-tests-${{ matrix.os }}", "daynight-cli-tests-probes-${{ matrix.os }}", "daynight-image-test-pairs-verify-${{ matrix.os }}"]);
  assert.deepEqual(installedUploads.map(artifactName), ["daynight-cli-installed-${{ matrix.os }}", "daynight-cli-installed-probes-${{ matrix.os }}", "daynight-image-test-pairs-verify-installed-${{ matrix.os }}"]);
  const names = [...ordinaryUploads, ...installedUploads].map(artifactName);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(artifactPaths(ordinaryUploads[1]!), [".tmp/validation-environment.json"]);
  assert.deepEqual(artifactPaths(installedUploads[0]!), [".tmp/validation-environment.json", ".tmp/e2e-evidence.json", ".tmp/update-evidence.json", ".tmp/project-task-evidence.json", ".tmp/skill-install-evidence.json", ".tmp/installed-cli-preparation.json"]);
  for (const probe of [ordinaryUploads[2]!, installedUploads[1]!]) {
    assert.match(probe, /^        if: \$\{\{ always\(\) && steps.environment.outcome != 'skipped' \}\}$/m);
    assert.deepEqual(artifactPaths(probe), [".tmp/validation-probes.json"]);
    assert.match(probe, /^          if-no-files-found: error$/m);
  }
});

const observedVitest = "node packages/daynight/scripts/observe-native-validation.mjs --output .tmp/native-validation -- pnpm --filter @codetreker/daynight exec vitest run";

test("macOS termination diagnostics belong to ordinary validation and upload after failure", () => {
  assert.match(ordinary, /name: Test the compiled CLI\n        run: pnpm --filter @codetreker\/daynight exec vitest run\n/);
  for (const stage of nativeStages) assert.doesNotMatch(stage, /observe-native-validation|tests-termination|runner.os/);
  assert.equal((workflow.match(/observe-native-validation\.mjs/g) ?? []).length, 1);
  const phase = macosStep("ordinary-validation");
  assert.ok(phase.includes(`          ${observedVitest}\n`));
  assert.equal((phase.match(/exec vitest run/g) ?? []).length, 1);
  assert.ok(!macosStep("installed-validation").includes("observe-native-validation"));
  const upload = macosUploads.find((step) => artifactName(step) === "daynight-cli-tests-termination-macos-15")!;
  assert.match(upload, /^        if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(artifactPaths(upload), [".tmp/native-validation/"]);
  assert.match(upload, /^          include-hidden-files: true$/m);
  assert.match(upload, /^          if-no-files-found: warn$/m);
  assert.match(upload, /^          retention-days: 30$/m);
  assert.equal(permitsMacosStep(upload, { "ordinary-validation": "failure" }, false, false), true);
  assert.ok(macos.indexOf(upload) > macos.indexOf(phase));
  assert.ok(macos.indexOf(upload) < macos.indexOf(macosStep("installed-environment")));
});

test("unselected CLI stages may both skip while other selected modules succeed", () => {
  assert.equal(runGate({ ...success, verify: "skipped", "verify-installed": "skipped", "verify-macos": "skipped", "verify-runtime": "skipped", "verify-completion": "skipped" }), 0);
});

const macosSteps = [...macos.matchAll(/^      - [\s\S]*?(?=^      - |$(?![\s\S]))/gm)].map((match) => match[0]);
const macosStep = (id: string): string => {
  const step = macosSteps.find((block) => block.includes(`        id: ${id}\n`));
  assert.ok(step, `Missing macOS step ${id}`);
  return step;
};
const macosUploads = uploadSteps(macos);
const permitsMacosStep = (step: string, outcomes: Record<string, string>, cancelled: boolean, previousSuccess: boolean): boolean => {
  const condition = step.match(/^        if: \$\{\{ (.+) \}\}$/m)?.[1];
  if (condition === undefined) return previousSuccess && !cancelled;
  if (!/\b(?:always|cancelled)\(\)/.test(condition) && !previousSuccess) return false;
  return condition.split(" && ").every((term) => {
    if (term === "always()") return true;
    if (term === "!cancelled()") return !cancelled;
    const comparison = term.match(/^steps\.([a-z0-9-]+)\.outcome (==|!=) '([a-z]+)'$/);
    assert.ok(comparison, `Unsupported condition term: ${term}`);
    const [, id, operator, expected] = comparison;
    assert.ok(Object.hasOwn(outcomes, id!), `Missing outcome for ${id}`);
    return operator === "==" ? outcomes[id!] === expected : outcomes[id!] !== expected;
  });
};

test("one ARM64 macOS allocation runs both complete bounded validation phases", () => {
  assert.match(macos, /^    needs: detect-changes$/m);
  assert.match(macos, /^    if: \$\{\{ needs.detect-changes.outputs.cli == 'true' \}\}$/m);
  assert.match(macos, /^    runs-on: macos-15$/m);
  assert.match(macos, /^    timeout-minutes: 20$/m);
  assert.match(macos, /^          node-version: 24$/m);
  assert.match(macos, /^          check-latest: true$/m);
  assert.equal((macos.match(/run: pnpm install --frozen-lockfile/g) ?? []).length, 1);
  assert.ok(macosStep("architecture").includes("assert.equal(process.platform, 'darwin')"));
  assert.ok(macosStep("architecture").includes("assert.equal(process.arch, 'arm64', 'macOS validation requires ARM64')"));
  const ordinaryPhase = macosStep("ordinary-validation");
  const installedPhase = macosStep("installed-validation");
  assert.equal(macosSteps.filter((step) => step.includes("        id: ordinary-validation\n")).length, 1);
  assert.equal(macosSteps.filter((step) => step.includes("        id: installed-validation\n")).length, 1);
  assert.equal(ordinaryPhase.split("\n").filter((line) => line === `          ${observedVitest}`).length, 1);
  assert.equal((installedPhase.match(/^          pnpm --filter @codetreker\/daynight exec vitest run --config vitest.acceptance.config.ts$/gm) ?? []).length, 1);
  assert.match(ordinaryPhase, /^        timeout-minutes: 10$/m);
  assert.match(installedPhase, /^        timeout-minutes: 10$/m);
  assert.ok(ordinaryPhase.includes(`          pnpm typecheck\n          pnpm build\n          pnpm dev:test\n          ${observedVitest}\n`));
  assert.ok(installedPhase.includes("          pnpm build\n          pnpm --filter @codetreker/daynight exec vitest run --config vitest.acceptance.config.ts\n"));
  assert.doesNotMatch(macos, /strategy:|matrix\.|VITEST_MAX_WORKERS|--maxWorkers|--no-isolate|continue-on-error|--grep|--shard/);
});

test("the six logical native OS phases execute exactly once through one macOS allocation", () => {
  const phases = nativeStages.flatMap((stage, index) => stage.match(/^        os: \[([^\]]+)\]$/m)![1]!.split(", ").map((os) => `${os}:${index === 0 ? "ordinary" : "installed"}`));
  assert.ok(macosStep("ordinary-validation")); assert.ok(macosStep("installed-validation"));
  phases.push("macos-15:ordinary", "macos-15:installed");
  assert.deepEqual(phases.sort(), ["ubuntu-latest:ordinary", "ubuntu-latest:installed", "windows-latest:ordinary", "windows-latest:installed", "macos-15:ordinary", "macos-15:installed"].sort());
  assert.equal(new Set(phases).size, 6);
  const allocations = [...jobs.values()].reduce((count, stage) => count
    + (/^    runs-on: macos-/m.test(stage) ? 1 : 0)
    + (stage.match(/^        os: \[([^\]]+)\]$/m)?.[1]!.split(", ").filter((os) => os.startsWith("macos-")).length ?? 0), 0);
  assert.equal(allocations, 1);
  assert.match(jobs.get("verify-runtime")!, /^    needs: \[detect-changes, verify\]$/m);
  assert.ok(!macos.includes("daynight-runtime-package"));
});

test("macOS artifacts retain exclusive phase names and ordinary upload precedes installed recording", () => {
  assert.deepEqual(macosUploads.map(artifactName), ["daynight-cli-tests-macos-15", "daynight-cli-tests-probes-macos-15", "daynight-cli-tests-termination-macos-15", "daynight-cli-installed-macos-15", "daynight-cli-installed-probes-macos-15", "daynight-image-test-pairs-verify-macos"]);
  const names = [ordinary, installed, macos].flatMap((stage) => uploadSteps(stage).map(artifactName));
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(artifactPaths(macosUploads[0]!), [".tmp/validation-environment.json"]);
  assert.deepEqual(artifactPaths(macosUploads[1]!), [".tmp/validation-probes.json"]);
  assert.deepEqual(artifactPaths(macosUploads[3]!), artifactPaths(uploadSteps(installed)[0]!));
  assert.deepEqual(artifactPaths(macosUploads[4]!), [".tmp/validation-probes.json"]);
  const clear = macosStep("installed-evidence"); const recorder = macosStep("installed-environment");
  for (const upload of macosUploads.slice(0, 3)) {
    assert.ok(macos.indexOf(upload) < macos.indexOf(clear));
    assert.ok(macos.indexOf(upload) < macos.indexOf(recorder));
  }
  assert.ok(macos.indexOf(clear) < macos.indexOf(recorder));
  assert.ok(macos.indexOf(recorder) < macos.indexOf(macosStep("installed-validation")));
  for (const upload of macosUploads.filter((step) => artifactName(step) !== "daynight-cli-tests-termination-macos-15")) assert.match(upload, /^          if-no-files-found: error$/m);
});

test("installed macOS validation survives ordinary failures but requires shared preparation and ARM64", () => {
  const outcomes = { preparation: "success", architecture: "success", "installed-evidence": "success", "installed-environment": "success" };
  for (const step of [macosStep("installed-evidence"), macosStep("installed-environment"), macosStep("installed-validation")]) {
    assert.equal(permitsMacosStep(step, outcomes, false, false), true);
    assert.equal(permitsMacosStep(step, outcomes, true, true), false);
  }
  for (const name of ["preparation", "architecture"]) {
    for (const result of ["failure", "skipped", "cancelled"]) {
      const failed = { ...outcomes, [name]: result };
      assert.equal(permitsMacosStep(macosStep("installed-evidence"), failed, false, false), false);
      assert.equal(permitsMacosStep(macosStep("installed-environment"), failed, false, false), false);
    }
  }
  assert.equal(permitsMacosStep(macosStep("installed-environment"), { ...outcomes, "installed-evidence": "failure" }, false, false), false);
});

test("installed macOS artifacts use their own recorder outcome and cleared paths", () => {
  const outcomes = { "installed-evidence": "success", "installed-environment": "success", "ordinary-environment": "success" };
  assert.equal(permitsMacosStep(macosUploads[0]!, outcomes, false, false), true);
  assert.equal(permitsMacosStep(macosUploads[1]!, outcomes, false, false), true);
  for (const result of ["failure", "skipped", "cancelled"]) {
    const failed = { ...outcomes, "installed-environment": result };
    assert.equal(permitsMacosStep(macosStep("installed-validation"), failed, false, false), false);
    assert.equal(permitsMacosStep(macosUploads[3]!, failed, false, false), false);
    assert.equal(permitsMacosStep(macosUploads[4]!, failed, false, false), result !== "skipped");
  }
  assert.equal(permitsMacosStep(macosUploads[4]!, { ...outcomes, "installed-evidence": "failure" }, false, false), false);
});

test("the macOS evidence handoff removes only the two recorder paths", () => {
  const temporary = fileURLToPath(new URL("../../.tmp/workflow-checks/", import.meta.url));
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(`${temporary}evidence-`);
  try {
    mkdirSync(`${directory}/.tmp`);
    for (const name of ["validation-environment.json", "validation-probes.json", "keep-evidence.json"]) writeFileSync(`${directory}/.tmp/${name}`, "ordinary evidence");
    const command = macosStep("installed-evidence").match(/^        run: \|\n((?:          .+\n)+)/m)![1]!
      .split("\n").filter(Boolean).map((line) => line.slice(10)).join("\n");
    const run = () => spawnSync("bash", ["-e", "-c", command], { cwd: directory, encoding: "utf8", timeout: 5_000 });
    const result = run();
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(`${directory}/.tmp/validation-environment.json`), false);
    assert.equal(existsSync(`${directory}/.tmp/validation-probes.json`), false);
    assert.equal(readFileSync(`${directory}/.tmp/keep-evidence.json`, "utf8"), "ordinary evidence");
    assert.equal(run().status, 0, "Already-absent recorder files are normal.");
    mkdirSync(`${directory}/.tmp/validation-environment.json`);
    assert.notEqual(run().status, 0, "Real evidence deletion failures must remain visible.");
  } finally { rmSync(directory, { recursive: true, force: true }); }
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

const workflowSteps = (stage: string): string[] => [...stage.matchAll(/^      - [\s\S]*?(?=^      - |$(?![\s\S]))/gm)].map((match) => match[0]);
const pairStep = (stage: string): string | undefined => workflowSteps(stage).find((step) => step.includes("        id: image-pairs\n"));

test("one protected manifest pin supplies every application job before candidate execution", () => {
  assert.equal((workflow.match(/vars\.DAYNIGHT_IMAGE_TEST_PAIRS_COMMIT/g) ?? []).length, 1);
  const detect = jobs.get("detect-changes")!;
  assert.ok(detect.includes("image_pair_manifest_commit: ${{ steps.image-pairs.outputs.manifest_commit }}"));
  assert.ok(detect.includes("image_pair_combined_tree: ${{ steps.image-pairs.outputs.combined_tree }}"));
  assert.ok(pairStep(detect));
  assert.ok(detect.indexOf("id: image-pairs") < detect.indexOf("Test module selection"));
  assert.ok(detect.includes(".github/scripts/image-test-pairs.test.mts"));
  for (const [name, stage] of jobs) {
    if (name === "detect-changes") continue;
    const step = pairStep(stage);
    assert.ok(step, `${name} must validate its own checkout`);
    assert.ok(step.includes("IMAGE_PAIR_MANIFEST_COMMIT: ${{ needs.detect-changes.outputs.image_pair_manifest_commit }}"));
    assert.ok(step.includes("IMAGE_PAIR_EXPECTED_COMBINED_TREE: ${{ needs.detect-changes.outputs.image_pair_combined_tree }}"));
    assert.ok(step.includes("IMAGE_PAIR_HEAD: ${{ github.event.pull_request.head.sha || github.sha }}"));
    assert.ok(step.includes("IMAGE_PAIR_PR: ${{ github.event.pull_request.number }}"));
    assert.ok(step.includes("IMAGE_PAIR_EVENT: ${{ github.event_name }}"));
    assert.ok(step.includes("working-directory: ${{ github.workspace }}"));
    assert.ok(!step.includes("if:"), `${name} cannot skip input validation`);
    const install = workflowSteps(stage).find((entry) => /(?:pnpm[^\n]*\binstall\b|npm install)/.test(entry));
    if (install !== undefined) assert.ok(stage.indexOf(step) < stage.indexOf(install), `${name} installs only after validation`);
    if (name !== "checks") {
      const upload = uploadSteps(stage).find((entry) => artifactName(entry).startsWith("daynight-image-test-pairs-"));
      assert.ok(upload, `${name} must retain its actual pairing evidence`);
      assert.deepEqual(artifactPaths(upload), [".tmp/image-test-pairs.json"]);
    }
  }
});

test("pair validation has read-only step-scoped credentials without checkout persistence", () => {
  assert.match(workflow, /^permissions:\n  contents: read\n  pull-requests: read\n/m);
  assert.doesNotMatch(workflow, /^\s+[a-z-]+: write$/m);
  for (const stage of jobs.values()) {
    for (const step of workflowSteps(stage)) {
      if (step.includes("uses: actions/checkout@")) assert.ok(step.includes("persist-credentials: false"));
      if (step.includes("GITHUB_TOKEN:")) assert.ok(step.includes("id: image-pairs"));
    }
    assert.doesNotMatch(stage.split("    steps:\n")[0]!, /GITHUB_TOKEN|GH_TOKEN/);
  }
});

test("runtime validation binds the downloaded package to its producer's pairing evidence", () => {
  const runtime = jobs.get("verify-runtime")!;
  const step = pairStep(runtime)!;
  assert.ok(step);
  const runtimeVersion = runtime.indexOf("node-version: ${{ matrix.node }}");
  assert.ok(runtime.indexOf(step) < runtimeVersion, "The validator runs on Node 24 before the compatibility version.");
  assert.ok(runtime.includes("name: daynight-image-test-pairs-verify-ubuntu-latest"));
  assert.ok(runtime.includes("name: Verify runtime package input identity"));
  assert.ok(runtime.indexOf("Verify runtime package input identity") < runtime.indexOf("Strictly install the packed CLI"));
});

test("the final gate checks complete pairing evidence independently of Web selection", () => {
  const step = workflowSteps(gate).find((entry) => entry.includes("name: Verify pairing evidence from every selected job"));
  assert.ok(step);
  assert.ok(!step.includes("if:"));
  assert.ok(!gate.includes("pattern:"));
  const downloads = workflowSteps(gate).filter((entry) => entry.includes("uses: actions/download-artifact@") && entry.includes("name: daynight-image-test-pairs-"));
  assert.equal(downloads.length, 16);
  assert.equal(new Set(downloads.map(artifactName)).size, 16);
  assert.ok(step.includes("IMAGE_PAIR_MANIFEST_COMMIT: ${{ needs.detect-changes.outputs.image_pair_manifest_commit }}"));
  assert.ok(step.includes("IMAGE_PAIR_EXPECTED_COMBINED_TREE: ${{ needs.detect-changes.outputs.image_pair_combined_tree }}"));
});

const shellStep = (stage: string, name: string): string => {
  const step = workflowSteps(stage).find((entry) => entry.includes(`name: ${name}\n`));
  assert.ok(step);
  return step.match(/^        run: \|\n((?:          .*\n)+)/m)![1]!
    .split("\n").filter(Boolean).map((line) => line.slice(10)).join("\n");
};
const pairingIdentity = { schemaVersion: 1, manifestCommit: "1".repeat(40), combinedTree: "2".repeat(40), combinedCommit: "5".repeat(40), productionTree: "3".repeat(40), head: "4".repeat(40) };
const pairingEnvironment = {
  IMAGE_PAIR_MANIFEST_COMMIT: pairingIdentity.manifestCommit,
  IMAGE_PAIR_EXPECTED_COMBINED_TREE: pairingIdentity.combinedTree,
  IMAGE_PAIR_COMBINED_COMMIT: pairingIdentity.combinedCommit,
  IMAGE_PAIR_PRODUCTION_TREE: pairingIdentity.productionTree,
  IMAGE_PAIR_HEAD: pairingIdentity.head,
  IMAGE_PAIR_CLI: "false", IMAGE_PAIR_SERVER: "false", IMAGE_PAIR_WEB: "false",
};
const withPairingEvidence = (body: (directory: string) => void): void => {
  const temporary = fileURLToPath(new URL("../../.tmp/workflow-checks/", import.meta.url));
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(`${temporary}pairing-`);
  try { body(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};
const writePairingReceipt = (directory: string, name: string, evidence: unknown = pairingIdentity): void => {
  const root = `${directory}/.tmp/image-pair-jobs/daynight-image-test-pairs-${name}`;
  mkdirSync(root, { recursive: true });
  writeFileSync(`${root}/image-test-pairs.json`, JSON.stringify(evidence));
};
const executePairingGate = (directory: string, environment: Record<string, string> = {}): number | null => {
  const result = spawnSync("bash", ["-e", "-c", shellStep(gate, "Verify pairing evidence from every selected job")], {
    cwd: directory, env: { ...process.env, ...pairingEnvironment, ...environment }, encoding: "utf8", timeout: 5_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return result.status;
};

test("the actual pairing gate accepts documentation-only and all-module evidence sets", () => withPairingEvidence((directory) => {
  writePairingReceipt(directory, "detect-changes");
  assert.equal(executePairingGate(directory), 0);
  const names = ["verify-ubuntu-latest", "verify-windows-latest", "verify-installed-ubuntu-latest", "verify-installed-windows-latest", "verify-macos", "verify-runtime-22.14.0", "verify-runtime-22", "verify-runtime-24", "verify-runtime-node", "verify-completion", "verify-server", "verify-server-e2e", "verify-web-quality", "verify-web-1", "verify-web-2"];
  for (const name of names) writePairingReceipt(directory, name);
  assert.equal(executePairingGate(directory, { IMAGE_PAIR_CLI: "true", IMAGE_PAIR_SERVER: "true", IMAGE_PAIR_WEB: "true" }), 0);
  assert.notEqual(executePairingGate(directory), 0, "Unselected or stale receipts must not be accepted.");
}));

for (const field of ["manifestCommit", "combinedTree", "combinedCommit", "productionTree", "head"]) {
  test(`the actual pairing gate rejects ${field} drift`, () => withPairingEvidence((directory) => {
    writePairingReceipt(directory, "detect-changes", { ...pairingIdentity, [field]: "f".repeat(40) });
    assert.notEqual(executePairingGate(directory), 0);
  }));
}

test("the actual pairing gate rejects missing selected jobs and incomplete identities", () => withPairingEvidence((directory) => {
  writePairingReceipt(directory, "detect-changes");
  assert.notEqual(executePairingGate(directory, { IMAGE_PAIR_SERVER: "true" }), 0);
  assert.notEqual(executePairingGate(directory, { IMAGE_PAIR_CLI: "" }), 0);
  writePairingReceipt(directory, "detect-changes", { ...pairingIdentity, combinedTree: "" });
  assert.notEqual(executePairingGate(directory, { IMAGE_PAIR_EXPECTED_COMBINED_TREE: "" }), 0);
}));

test("the actual runtime guard rejects differing or absent input identity before installation", () => withPairingEvidence((directory) => {
  mkdirSync(`${directory}/.tmp/runtime-pair`, { recursive: true });
  const own = `${directory}/.tmp/image-test-pairs.json`;
  const producer = `${directory}/.tmp/runtime-pair/image-test-pairs.json`;
  const run = () => spawnSync("bash", ["-e", "-c", shellStep(jobs.get("verify-runtime")!, "Verify runtime package input identity")], { cwd: directory, encoding: "utf8", timeout: 5_000 });
  writeFileSync(own, JSON.stringify(pairingIdentity)); writeFileSync(producer, JSON.stringify(pairingIdentity));
  assert.equal(run().status, 0);
  writeFileSync(producer, JSON.stringify({ ...pairingIdentity, combinedTree: "f".repeat(40) }));
  assert.notEqual(run().status, 0);
  writeFileSync(own, JSON.stringify({ schemaVersion: 1 })); writeFileSync(producer, JSON.stringify({ schemaVersion: 1 }));
  assert.notEqual(run().status, 0);
}));
