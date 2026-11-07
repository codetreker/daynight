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

for (const name of ["verify", "verify-installed", "verify-completion", "verify-server", "verify-web-quality", "verify-web-browser"]) {
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
const nativePlatforms = ["ubuntu-latest", "windows-latest", "macos-15"];

test("Linux, Windows and macOS share independent ordinary and installed CLI matrices", () => {
  assert.equal(jobs.has("verify-macos"), false);
  assert.equal(jobs.has("verify-macos-installed"), false);
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
  assert.deepEqual(ordinaryUploads.map(artifactName), ["daynight-runtime-package", "daynight-cli-tests-${{ matrix.os }}", "daynight-cli-tests-probes-${{ matrix.os }}", "daynight-cli-tests-termination-macos-15"]);
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

const selectsPlatform = (step: string, platform: string): boolean => {
  const condition = step.match(/^        if: (.+)$/m)?.[1];
  if (condition === undefined) return true;
  const comparison = condition.match(/^matrix\.os (==|!=) '([^']+)'$/);
  assert.ok(comparison, `Unsupported platform condition: ${condition}`);
  return comparison[1] === "==" ? platform === comparison[2] : platform !== comparison[2];
};

test("each matrix checks Darwin ARM64 before recording its macOS environment", () => {
  for (const stage of nativeStages) {
    const architecture = stepsOf(stage).filter((step) => step.includes("name: Require macOS ARM64"));
    assert.equal(architecture.length, 1);
    const check = architecture[0]!;
    assert.match(check, /^        if: matrix.os == 'macos-15'$/m);
    assert.ok(check.includes("assert.equal(process.platform, 'darwin')"));
    assert.ok(check.includes("assert.equal(process.arch, 'arm64', 'macOS validation requires ARM64')"));
    const recorder = stepsOf(stage).find((step) => step.includes("scripts/validation-environment.ts"))!;
    assert.ok(recorder);
    assert.ok(stage.indexOf(check) < stage.indexOf(recorder));
    assert.doesNotMatch(recorder, /^        if:/m);
    for (const platform of nativePlatforms) assert.equal(selectsPlatform(check, platform), platform === "macos-15");
  }
});

test("each platform runs its ordinary and installed suite exactly once", () => {
  const ordinarySuites = stepsOf(ordinary).filter((step) => step.includes("exec vitest run"));
  const installedSuites = stepsOf(installed).filter((step) => step.includes("exec vitest run"));
  assert.equal(ordinarySuites.length, 2);
  assert.equal(installedSuites.length, 1);
  assert.doesNotMatch(installedSuites[0]!, /^        if:/m);
  const phases: string[] = [];
  for (const platform of nativePlatforms) {
    const selectedOrdinary = ordinarySuites.filter((step) => selectsPlatform(step, platform));
    const selectedInstalled = installedSuites.filter((step) => selectsPlatform(step, platform));
    assert.equal(selectedOrdinary.length, 1, `${platform} ordinary suite count`);
    assert.equal(selectedInstalled.length, 1, `${platform} installed suite count`);
    assert.equal(selectedOrdinary[0]!.match(/^        run: (.+)$/m)![1], platform === "macos-15" ? observedVitest : "pnpm --filter @codetreker/daynight exec vitest run");
    assert.match(selectedInstalled[0]!, /^        run: pnpm --filter @codetreker\/daynight exec vitest run --config vitest.acceptance.config.ts$/m);
    phases.push(`${platform}:ordinary`, `${platform}:installed`);
  }
  assert.equal(phases.length, 6);
  assert.equal(new Set(phases).size, 6);
  for (const stage of nativeStages) {
    for (const run of ["pnpm install --frozen-lockfile --store-dir .tmp/pnpm-store", "pnpm build"]) {
      const matching = stepsOf(stage).filter((step) => step.includes(`      - run: ${run}\n`) || step.includes(`        run: ${run}\n`));
      assert.equal(matching.length, 1);
      assert.doesNotMatch(matching[0]!, /^        if:/m);
    }
    assert.doesNotMatch(stage, /timeout-minutes: 20|installed-evidence|!cancelled|--grep|--shard/);
  }
});

test("macOS termination diagnostics use only the ordinary matrix and upload after failure", () => {
  assert.equal((workflow.match(/observe-native-validation\.mjs/g) ?? []).length, 1);
  assert.doesNotMatch(installed, /observe-native-validation|tests-termination/);
  const observer = stepsOf(ordinary).find((step) => step.includes("observe-native-validation.mjs"))!;
  assert.match(observer, /^        if: matrix.os == 'macos-15'$/m);
  const upload = uploadSteps(ordinary).find((step) => artifactName(step) === "daynight-cli-tests-termination-macos-15")!;
  assert.match(upload, /^        if: \$\{\{ always\(\) && matrix.os == 'macos-15' \}\}$/m);
  assert.deepEqual(artifactPaths(upload), [".tmp/native-validation/"]);
  assert.match(upload, /^          include-hidden-files: true$/m);
  assert.match(upload, /^          if-no-files-found: warn$/m);
  assert.match(upload, /^          retention-days: 30$/m);
  assert.ok(ordinary.indexOf(upload) > ordinary.indexOf(observer));
});

test("matrix artifacts retain unique names across all three platforms", () => {
  const names = nativeStages.flatMap((stage) => uploadSteps(stage).flatMap((step) => {
    const name = artifactName(step);
    if (name === "daynight-runtime-package") return [name];
    if (name === "daynight-cli-tests-termination-macos-15") return [name];
    return nativePlatforms.map((platform) => name.replace("${{ matrix.os }}", platform));
  }));
  assert.equal(names.length, 14);
  assert.equal(new Set(names).size, names.length);
  for (const platform of nativePlatforms) {
    for (const prefix of ["daynight-cli-tests", "daynight-cli-tests-probes", "daynight-cli-installed", "daynight-cli-installed-probes"]) {
      assert.ok(names.includes(`${prefix}-${platform}`));
    }
  }
});

test("unselected CLI matrices may skip while other selected modules succeed", () => {
  assert.equal(runGate({ ...success, verify: "skipped", "verify-installed": "skipped", "verify-runtime": "skipped", "verify-completion": "skipped" }), 0);
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
