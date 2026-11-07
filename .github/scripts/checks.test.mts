import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/checks.yml", import.meta.url), "utf8");
const jobs = new Map([...workflow.split("\njobs:\n")[1]!.matchAll(/^  ([a-z][a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1]!, match[2]!]));
const gate = jobs.get("checks")!;
const required = gate.match(/^    needs: \[([^\]]+)\]$/m)![1]!.split(", ");
const command = gate.match(/^        run: (.+)$/m)![1]!;

test("the final gate waits for every independent validation stage", () => {
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(new Set(required), new Set([...jobs.keys()].filter((name) => name !== "checks")));
  for (const [name, mode] of [["verify-server", "coverage"]]) {
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

test("successful module jobs pass the actual workflow gate", () => {
  assert.equal(runGate(success), 0);
});

for (const name of ["verify", "verify-installed", "verify-macos", "verify-macos-installed", "verify-completion", "verify-server", "verify-web-quality", "verify-web-browser"]) {
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
const macosInstalled = jobs.get("verify-macos-installed")!;
const macosStages = [macos, macosInstalled];

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
  assert.deepEqual(ordinaryUploads.map(artifactName), ["daynight-runtime-package", "daynight-cli-tests-${{ matrix.os }}", "daynight-cli-tests-probes-${{ matrix.os }}"]);
  assert.deepEqual(installedUploads.map(artifactName), ["daynight-cli-installed-${{ matrix.os }}", "daynight-cli-installed-probes-${{ matrix.os }}"]);
  const names = [...ordinaryUploads, ...installedUploads].map(artifactName);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(artifactPaths(ordinaryUploads[1]!), [".tmp/validation-environment.json"]);
  assert.deepEqual(artifactPaths(installedUploads[0]!), [".tmp/validation-environment.json", ".tmp/installed-cli-preparation.json"]);
  for (const probe of [ordinaryUploads[2]!, installedUploads[1]!]) {
    assert.match(probe, /^        if: \$\{\{ always\(\) && steps.environment.outcome != 'skipped' \}\}$/m);
    assert.deepEqual(artifactPaths(probe), [".tmp/validation-probes.json"]);
    assert.match(probe, /^          if-no-files-found: error$/m);
  }
});

const observedVitest = "node packages/daynight/scripts/observe-native-validation.mjs --output .tmp/native-validation -- pnpm --filter @codetreker/daynight exec vitest run";

const stepsOf = (stage: string): string[] => [...stage.matchAll(/^      - [\s\S]*?(?=^      - |$(?![\s\S]))/gm)].map((match) => match[0]);
const stepById = (stage: string, id: string): string => {
  const step = stepsOf(stage).find((block) => block.includes(`        id: ${id}\n`));
  assert.ok(step, `Missing step ${id}`);
  return step;
};

const macosOrdinaryUploads = uploadSteps(macos);
const macosInstalledUploads = uploadSteps(macosInstalled);

test("macOS termination diagnostics belong to ordinary validation and upload after failure", () => {
  assert.match(ordinary, /name: Test the compiled CLI\n        run: pnpm --filter @codetreker\/daynight exec vitest run\n/);
  for (const stage of [...nativeStages, macosInstalled]) assert.doesNotMatch(stage, /observe-native-validation|tests-termination|runner.os/);
  assert.equal((workflow.match(/observe-native-validation\.mjs/g) ?? []).length, 1);
  const phase = stepById(macos, "ordinary-validation");
  assert.ok(phase.includes(`          ${observedVitest}\n`));
  assert.equal((phase.match(/exec vitest run/g) ?? []).length, 1);
  const upload = macosOrdinaryUploads.find((step) => artifactName(step) === "daynight-cli-tests-termination-macos-15")!;
  assert.match(upload, /^        if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(artifactPaths(upload), [".tmp/native-validation/"]);
  assert.match(upload, /^          include-hidden-files: true$/m);
  assert.match(upload, /^          if-no-files-found: warn$/m);
  assert.match(upload, /^          retention-days: 30$/m);
  assert.ok(macos.indexOf(upload) > macos.indexOf(phase));
});

test("unselected CLI stages may skip while other selected modules succeed", () => {
  assert.equal(runGate({ ...success, verify: "skipped", "verify-installed": "skipped", "verify-macos": "skipped", "verify-macos-installed": "skipped", "verify-runtime": "skipped", "verify-completion": "skipped" }), 0);
});

test("macOS ordinary and installed jobs prepare independent ARM64 runners", () => {
  assert.match(macos, /^    name: verify \(CLI tests, macOS ARM64\)$/m);
  assert.match(macosInstalled, /^    name: verify \(installed CLI, macOS ARM64\)$/m);
  for (const stage of macosStages) {
    assert.match(stage, /^    needs: detect-changes$/m);
    assert.match(stage, /^    if: \$\{\{ needs.detect-changes.outputs.cli == 'true' \}\}$/m);
    assert.match(stage, /^    runs-on: macos-15$/m);
    assert.match(stage, /^    timeout-minutes: 20$/m);
    assert.match(stage, /uses: actions\/checkout@/);
    assert.match(stage, /^          persist-credentials: false$/m);
    assert.match(stage, /^          fetch-depth: 0$/m);
    assert.match(stage, /^          node-version: 24$/m);
    assert.match(stage, /^          check-latest: true$/m);
    assert.match(stage, /uses: pnpm\/action-setup@/);
    assert.match(stage, /^          version: 11\.28\.6$/m);
    assert.match(stage, /COREPACK_HOME: \$\{\{ github.workspace \}\}\/\.tmp\/corepack/);
    assert.match(stage, /XDG_CACHE_HOME: \$\{\{ github.workspace \}\}\/\.tmp\/cache/);
    assert.equal((stage.match(/run: pnpm install --frozen-lockfile --store-dir \.tmp\/pnpm-store/g) ?? []).length, 1);
    assert.equal((stage.match(/run: node packages\/daynight\/scripts\/validation-environment\.ts/g) ?? []).length, 1);
    const architecture = stepById(stage, "architecture");
    assert.ok(architecture.includes("assert.equal(process.platform, 'darwin')"));
    assert.ok(architecture.includes("assert.equal(process.arch, 'arm64', 'macOS validation requires ARM64')"));
    const recorder = stepsOf(stage).find((step) => step.includes("scripts/validation-environment.ts"))!;
    assert.ok(stage.indexOf(architecture) < stage.indexOf(recorder));
    assert.doesNotMatch(stage, /strategy:|matrix\.|download-artifact|installed-evidence|!cancelled|VITEST_MAX_WORKERS|--maxWorkers|--no-isolate|continue-on-error|--grep|--shard/);
  }
});

test("each macOS job runs its complete phase once with its own validation bound", () => {
  const ordinaryPhase = stepById(macos, "ordinary-validation");
  const installedPhase = stepById(macosInstalled, "installed-validation");
  assert.equal(stepsOf(macos).filter((step) => step.includes("        id: ordinary-validation\n")).length, 1);
  assert.equal(stepsOf(macosInstalled).filter((step) => step.includes("        id: installed-validation\n")).length, 1);
  assert.equal(ordinaryPhase.split("\n").filter((line) => line === `          ${observedVitest}`).length, 1);
  assert.equal((installedPhase.match(/^          pnpm --filter @codetreker\/daynight exec vitest run --config vitest.acceptance.config.ts$/gm) ?? []).length, 1);
  for (const phase of [ordinaryPhase, installedPhase]) {
    assert.match(phase, /^        timeout-minutes: 10$/m);
    assert.doesNotMatch(phase, /^        if:/m);
  }
  assert.ok(ordinaryPhase.includes(`          pnpm typecheck\n          pnpm build\n          pnpm dev:test\n          ${observedVitest}\n`));
  assert.ok(installedPhase.includes("          pnpm build\n          pnpm --filter @codetreker/daynight exec vitest run --config vitest.acceptance.config.ts\n"));
  assert.doesNotMatch(macos, /installed-environment|installed-validation|vitest\.acceptance/);
  assert.doesNotMatch(macosInstalled, /ordinary-environment|ordinary-validation|pnpm typecheck|pnpm dev:test/);
  for (const [stage, recorderId, validationId] of [[macos, "ordinary-environment", "ordinary-validation"], [macosInstalled, "installed-environment", "installed-validation"]]) {
    const recorder = stepById(stage!, recorderId!);
    assert.doesNotMatch(recorder, /^        if:/m);
    assert.ok(stage!.indexOf(recorder) < stage!.indexOf(stepById(stage!, validationId!)));
  }
});

test("the six native OS phases execute exactly once through two macOS allocations", () => {
  const phases = nativeStages.flatMap((stage, index) => stage.match(/^        os: \[([^\]]+)\]$/m)![1]!.split(", ").map((os) => `${os}:${index === 0 ? "ordinary" : "installed"}`));
  phases.push("macos-15:ordinary", "macos-15:installed");
  assert.deepEqual(phases.sort(), ["ubuntu-latest:ordinary", "ubuntu-latest:installed", "windows-latest:ordinary", "windows-latest:installed", "macos-15:ordinary", "macos-15:installed"].sort());
  assert.equal(new Set(phases).size, 6);
  const allocations = [...jobs.values()].reduce((count, stage) => count
    + (/^    runs-on: macos-/m.test(stage) ? 1 : 0)
    + (stage.match(/^        os: \[([^\]]+)\]$/m)?.[1]!.split(", ").filter((os) => os.startsWith("macos-")).length ?? 0), 0);
  assert.equal(allocations, 2);
  assert.match(jobs.get("verify-runtime")!, /^    needs: \[detect-changes, verify\]$/m);
  for (const stage of macosStages) assert.ok(!stage.includes("daynight-runtime-package"));
});

test("macOS artifacts retain exclusive phase ownership and failure probe uploads", () => {
  assert.deepEqual(macosOrdinaryUploads.map(artifactName), ["daynight-cli-tests-macos-15", "daynight-cli-tests-probes-macos-15", "daynight-cli-tests-termination-macos-15"]);
  assert.deepEqual(macosInstalledUploads.map(artifactName), ["daynight-cli-installed-macos-15", "daynight-cli-installed-probes-macos-15"]);
  const names = [...nativeStages, ...macosStages].flatMap((stage) => uploadSteps(stage).map(artifactName));
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(artifactPaths(macosOrdinaryUploads[0]!), [".tmp/validation-environment.json"]);
  assert.deepEqual(artifactPaths(macosOrdinaryUploads[1]!), [".tmp/validation-probes.json"]);
  assert.deepEqual(artifactPaths(macosInstalledUploads[0]!), artifactPaths(uploadSteps(installed)[0]!));
  assert.deepEqual(artifactPaths(macosInstalledUploads[1]!), [".tmp/validation-probes.json"]);
  for (const [uploads, recorder] of [[macosOrdinaryUploads.slice(0, 2), "ordinary-environment"], [macosInstalledUploads, "installed-environment"]] as const) {
    assert.equal(uploads[0]!.match(/^        if: (.+)$/m)![1], `\${{ always() && steps.${recorder}.outcome == 'success' }}`);
    assert.equal(uploads[1]!.match(/^        if: (.+)$/m)![1], `\${{ always() && steps.${recorder}.outcome != 'skipped' }}`);
    for (const upload of uploads) assert.match(upload, /^          if-no-files-found: error$/m);
  }
});

const selectedWebStep = gate.match(/      - name: Require selected Web jobs to succeed\n([\s\S]*?)(?=      - |$(?![\s\S]))/)![1]!;
const selectedWebCommand = selectedWebStep.match(/^        run: (.+)$/m)![1]!;
const webQuality = jobs.get("verify-web-quality")!;
const webBrowser = jobs.get("verify-web-browser")!;

test("Web quality and browser jobs prepare independent runners after module selection", () => {
  for (const stage of [webQuality, webBrowser]) {
    assert.match(stage, /^    needs: detect-changes$/m);
    assert.match(stage, /^    if: \$\{\{ needs.detect-changes.outputs.web == 'true' \}\}$/m);
    assert.match(stage, /^    runs-on: ubuntu-latest$/m);
    assert.match(stage, /uses: actions\/checkout@/);
    assert.match(stage, /^          persist-credentials: false$/m);
    assert.match(stage, /^          node-version: 24$/m);
    assert.match(stage, /uses: pnpm\/action-setup@/);
    assert.match(stage, /^          version: 11\.28\.6$/m);
    assert.ok(stage.includes("run: pnpm install --frozen-lockfile --store-dir .tmp/pnpm-store"));
    assert.match(stage, /COREPACK_HOME: \$\{\{ github.workspace \}\}\/\.tmp\/corepack/);
    assert.match(stage, /XDG_CACHE_HOME: \$\{\{ github.workspace \}\}\/\.tmp\/cache/);
    assert.doesNotMatch(stage, /download-artifact|continue-on-error/);
  }
  assert.match(webQuality, /^    timeout-minutes: 30$/m);
  assert.match(webBrowser, /^    timeout-minutes: 20$/m);
});

test("Web quality owns types, production build, harness, coverage and evidence", () => {
  assert.match(webQuality, /run: node packages\/daynight-web\/scripts\/ci.mts quality/);
  assert.doesNotMatch(webQuality, /playwright|web-browser|bots-viewport/);
  const uploads = uploadSteps(webQuality);
  assert.deepEqual(uploads.map(artifactName), ["daynight-web-coverage"]);
  assert.match(uploads[0]!, /^        if: \$\{\{ always\(\) && steps.web-quality.outcome != 'skipped' \}\}$/m);
  assert.deepEqual(artifactPaths(uploads[0]!), ["packages/daynight-web/.tmp/coverage/coverage-final.json", "packages/daynight-web/.tmp/coverage/summary.json"]);
  assert.match(uploads[0]!, /^          if-no-files-found: error$/m);
});

test("Web browser owns the unchanged frontend Playwright regressions and evidence", () => {
  const steps = [...webBrowser.matchAll(/^      - [\s\S]*?(?=^      - |$(?![\s\S]))/gm)].map((match) => match[0]);
  const install = steps.find((step) => step.includes("playwright install"))!;
  const browser = steps.find((step) => step.includes("id: web-browser"))!;
  const uploads = uploadSteps(webBrowser);
  const upload = uploads[0]!;
  assert.ok(install); assert.ok(browser); assert.ok(upload);
  assert.deepEqual(uploads.map(artifactName), ["daynight-web-assistant-browser"]);
  assert.doesNotMatch(webBrowser, /ci\.mts quality|id: web-quality|\.tmp\/coverage/);
  assert.match(webBrowser, /PLAYWRIGHT_BROWSERS_PATH: \$\{\{ github.workspace \}\}\/\.tmp\/playwright-browsers/);
  assert.match(install, /^        run: pnpm --filter @codetreker\/daynight-web exec playwright install --with-deps chromium$/m);
  assert.match(browser, /^        run: pnpm --filter @codetreker\/daynight-web exec playwright test --config tests\/navigation\/bots-viewport-playwright.config.ts --reporter=line,junit$/m);
  assert.match(browser, /PLAYWRIGHT_JUNIT_OUTPUT_FILE: \$\{\{ github.workspace \}\}\/packages\/daynight-web\/\.tmp\/acceptance\/bots-viewport-results.xml/);
  assert.ok(webBrowser.indexOf(install) < webBrowser.indexOf(browser));
  assert.ok(webBrowser.indexOf(browser) < webBrowser.indexOf(upload));
  assert.doesNotMatch(browser, /continue-on-error|passWithNoTests|--grep|--shard|--update-snapshots|if:/);
  assert.match(upload, /^        if: \$\{\{ always\(\) && steps.web-browser.outcome != 'skipped' \}\}$/m);
  assert.deepEqual(artifactPaths(upload), ["packages/daynight-web/.tmp/acceptance/bots-viewport-results.xml", "packages/daynight-web/.tmp/acceptance/bots-viewport/"]);
  assert.match(upload, /^          include-hidden-files: true$/m);
  assert.match(upload, /^          if-no-files-found: error$/m);
});

test("selected Web validation requires actual quality and browser success", () => {
  assert.match(selectedWebStep, /^        if: \$\{\{ needs.detect-changes.outputs.web == 'true' \}\}$/m);
  assert.match(selectedWebStep, /WEB_QUALITY_RESULT: \$\{\{ needs.verify-web-quality.result \}\}/);
  assert.match(selectedWebStep, /WEB_BROWSER_RESULT: \$\{\{ needs.verify-web-browser.result \}\}/);
});

for (const quality of ["success", "skipped", "failure", "cancelled"]) {
  for (const browser of ["success", "skipped", "failure", "cancelled"]) {
    test(`selected Web quality=${quality}, browser=${browser} executes the workflow guard`, () => {
      const result = spawnSync("bash", ["-e", "-c", selectedWebCommand], {
        env: { ...process.env, WEB_QUALITY_RESULT: quality, WEB_BROWSER_RESULT: browser },
        encoding: "utf8", timeout: 5_000,
      });
      if (result.error) throw result.error;
      assert.equal(result.signal, null);
      assert.equal(result.status === 0, quality === "success" && browser === "success");
    });
  }
}
