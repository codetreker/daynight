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

for (const name of ["verify", "verify-installed", "verify-completion", "verify-server", "verify-server-startup-shutdown", "verify-api-integration", "verify-web-quality", "verify-web-browser", "verify-e2e"]) {
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
  assert.deepEqual(ordinaryUploads.map(artifactName), ["daynight-runtime-package", "daynight-cli-tests-${{ matrix.os }}", "daynight-cli-tests-probes-${{ matrix.os }}", "daynight-cli-tests-failures-${{ matrix.os }}", "daynight-cli-tests-termination-macos-15"]);
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
  const failures = ordinaryUploads[3]!;
  assert.match(failures, /^        if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(artifactPaths(failures), [".tmp/cli-test-failures/*.jsonl"]);
  assert.match(failures, /^          include-hidden-files: true$/m);
  assert.match(failures, /^          if-no-files-found: warn$/m);
  assert.match(failures, /^          retention-days: 30$/m);
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
  assert.equal(names.length, 17);
  assert.equal(new Set(names).size, names.length);
  for (const platform of nativePlatforms) {
    for (const prefix of ["daynight-cli-tests", "daynight-cli-tests-probes", "daynight-cli-tests-failures", "daynight-cli-installed", "daynight-cli-installed-probes"]) {
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

const productE2E = jobs.get("verify-e2e")!;
const selectedE2EStep = gate.match(/      - name: Require selected product E2E to succeed\n([\s\S]*?)(?=      - |$(?![\s\S]))/)![1]!;
const selectedE2ECommand = selectedE2EStep.match(/^        run: (.+)$/m)![1]!;

test("product E2E has an independent Linux runner selected by its own inputs", () => {
  assert.match(workflow, /^      e2e: \$\{\{ steps.modules.outputs.e2e \}\}$/m);
  assert.match(productE2E, /^    needs: detect-changes$/m);
  assert.match(productE2E, /^    if: \$\{\{ needs.detect-changes.outputs.e2e == 'true' \}\}$/m);
  assert.match(productE2E, /^    runs-on: ubuntu-latest$/m);
  assert.match(productE2E, /^    timeout-minutes: 40$/m);
  assert.match(productE2E, /^          fetch-depth: 0$/m);
  assert.match(productE2E, /^          persist-credentials: false$/m);
  assert.match(productE2E, /^          node-version: 24$/m);
  assert.match(productE2E, /^          version: 11.28.6$/m);
  assert.match(productE2E, /^          go-version: 1.27.2$/m);
  assert.match(productE2E, /^          cache: true$/m);
  assert.match(productE2E, /^      DAYNIGHT_E2E_RUN_POINTER: \$\{\{ github.workspace \}\}\/\.tmp\/product-e2e-run\.json$/m);
  for (const [name, directory] of [["COREPACK_HOME", ".tmp/corepack"], ["XDG_CACHE_HOME", ".tmp/cache"], ["PLAYWRIGHT_BROWSERS_PATH", ".tmp/playwright-browsers"], ["GOCACHE", ".tmp/product-e2e-cache/go-build"], ["GOMODCACHE", ".tmp/product-e2e-cache/go-mod"], ["GOPATH", ".tmp/product-e2e-cache/go"]]) {
    assert.ok(productE2E.includes(`${name}: \${{ github.workspace }}/${directory}`));
  }
  assert.doesNotMatch(productE2E, /services:|DAYNIGHT_TEST_DATABASE_URL|DAYNIGHT_UNIAUTH_APP_SECRET|download-artifact|continue-on-error/);
});

test("product E2E budgets every step and reserves cleanup time within the job", () => {
  const jobMinutes = Number(productE2E.match(/^    timeout-minutes: (\d+)$/m)![1]);
  const stepMinutes = stepsOf(productE2E).map((step) => {
    const match = step.match(/^        timeout-minutes: ([1-9]\d*)$/m);
    assert.ok(match, `Product E2E step lacks a positive timeout: ${step.split("\n")[0]}`);
    return Number(match[1]);
  });
  assert.deepEqual(stepMinutes, [2, 2, 2, 1, 3, 3, 4, 1, 1, 15, 3, 1]);
  assert.ok(stepMinutes.reduce((total, minutes) => total + minutes, 0) <= jobMinutes - 2);
});

test("product E2E runs its own harness and builds the complete journey every time", () => {
  const steps = stepsOf(productE2E);
  const install = steps.find((step) => step.includes("run: pnpm install --frozen-lockfile --store-dir .tmp/pnpm-store"))!;
  const browser = steps.find((step) => step.includes("name: Install the locked product E2E Chromium browser"))!;
  const types = steps.find((step) => step.includes("run: pnpm --filter @codetreker/daynight-e2e typecheck"))!;
  const harness = steps.find((step) => step.includes("run: pnpm e2e:test:harness"))!;
  const journey = steps.find((step) => step.includes("id: product-e2e"))!;
  for (const step of [install, browser, types, harness, journey]) {
    assert.ok(step);
    assert.doesNotMatch(step, /if:|continue-on-error|--grep|--shard|--update-snapshots|passWithNoTests/);
  }
  assert.match(browser, /^        run: pnpm --filter @codetreker\/daynight-e2e exec playwright install chromium$/m);
  assert.doesNotMatch(productE2E, /--with-deps|\binstall-deps\b/);
  assert.match(journey, /^        timeout-minutes: 15$/m);
  assert.match(journey, /^        run: pnpm e2e:test$/m);
  assert.ok(steps.indexOf(install) < steps.indexOf(browser));
  assert.ok(steps.indexOf(browser) < steps.indexOf(types));
  assert.ok(steps.indexOf(types) < steps.indexOf(harness));
  assert.ok(steps.indexOf(harness) < steps.indexOf(journey));
});

test("product E2E reconciles after failure and uploads only results and logs", () => {
  const steps = stepsOf(productE2E);
  const journey = steps.find((step) => step.includes("id: product-e2e"))!;
  const cleanup = steps.find((step) => step.includes("run: pnpm e2e:cleanup"))!;
  const uploads = uploadSteps(productE2E);
  assert.equal(uploads.length, 1);
  const upload = uploads[0]!;
  assert.match(cleanup, /^        if: \$\{\{ always\(\) && steps.product-e2e.outcome != 'skipped' \}\}$/m);
  assert.match(cleanup, /^        timeout-minutes: 3$/m);
  assert.match(upload, /^        if: \$\{\{ always\(\) && steps.product-e2e.outcome != 'skipped' \}\}$/m);
  assert.equal(artifactName(upload), "daynight-product-e2e");
  assert.deepEqual(artifactPaths(upload), [".tmp/product-e2e/*/results/**", ".tmp/product-e2e/*/logs/**"]);
  assert.match(upload, /^          include-hidden-files: true$/m);
  assert.match(upload, /^          if-no-files-found: error$/m);
  assert.match(upload, /^          retention-days: 30$/m);
  assert.ok(productE2E.indexOf(journey) < productE2E.indexOf(cleanup));
  assert.ok(productE2E.indexOf(cleanup) < productE2E.indexOf(upload));
});

test("selected product E2E requires actual success", () => {
  assert.match(selectedE2EStep, /^        if: \$\{\{ needs.detect-changes.outputs.e2e == 'true' \}\}$/m);
  assert.match(selectedE2EStep, /E2E_RESULT: \$\{\{ needs.verify-e2e.result \}\}/);
});

for (const result of ["success", "skipped", "failure", "cancelled"]) {
  test(`selected product E2E ${result} executes the workflow guard`, () => {
    const outcome = spawnSync("bash", ["-e", "-c", selectedE2ECommand], {
      env: { ...process.env, E2E_RESULT: result }, encoding: "utf8", timeout: 5_000,
    });
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.signal, null);
    assert.equal(outcome.status === 0, result === "success");
  });
}

test("unselected product E2E may skip while selected modules succeed", () => {
  assert.equal(runGate({ ...success, "verify-e2e": "skipped" }), 0);
});


test("Web jobs validate the current checkout without restoring retired acceptance", () => {
  for (const [name, id] of [["verify-web-quality", "web-quality"], ["verify-web-browser", "web-browser"]]) {
    const stage = jobs.get(name!)!;
    const validation = stepsOf(stage).find((entry) => entry.includes(`id: ${id}\n`));
    assert.ok(validation);
  }
  assert.doesNotMatch(workflow, /verify-web:|verify-web-[12]|WEB_SHARD_RESULT|daynight-web-summary|scripts\/acceptance|ci\.mts browser/);
  assert.doesNotMatch(workflow, /GITHUB_SHA=.*GITHUB_ENV|^\s+GITHUB_SHA:/m);
});

const server = jobs.get("verify-server")!;
const startupShutdown = jobs.get("verify-server-startup-shutdown")!;
const apiIntegration = jobs.get("verify-api-integration")!;
const selectedServerStep = stepsOf(gate).find((step) => step.includes("name: Require selected Go server jobs to succeed\n"))!;
const selectedServerCommand = selectedServerStep.match(/^        run: (.+)$/m)![1]!;
const selectedAPIStep = stepsOf(gate).find((step) => step.includes("name: Require selected Go API integration to succeed\n"))!;
const selectedAPICommand = selectedAPIStep.match(/^        run: (.+)$/m)![1]!;

test("Go module coverage and API integration prepare independent runners", () => {
  assert.match(apiIntegration, /^    needs: detect-changes$/m);
  assert.match(apiIntegration, /^    if: \$\{\{ needs.detect-changes.outputs.api == 'true' \}\}$/m);
  for (const stage of [server, startupShutdown, apiIntegration]) {
    assert.match(stage, /^    runs-on: ubuntu-latest$/m);
    assert.match(stage, /uses: actions\/checkout@/);
    assert.match(stage, /^          persist-credentials: false$/m);
    assert.match(stage, /^          go-version: 1\.27\.2$/m);
    assert.match(stage, /^          node-version: 24$/m);
    assert.match(stage, /^      DAYNIGHT_TEST_DATABASE_URL: postgres:\/\/daynight:daynight-test@127\.0\.0\.1:5432\/daynight\?sslmode=disable$/m);
    assert.match(stage, /^        image: postgres:18\.6-bookworm@sha256:/m);
    assert.doesNotMatch(stage, /download-artifact|continue-on-error|pnpm (?:web:test|test|e2e:test)|vitest|playwright/);
  }
  assert.doesNotMatch(server, /pnpm|integration\.sh|integration-runtime\.test\.mts|server-integration|integration-results/);
  const moduleCheck = readFileSync(new URL("../../packages/daynight-server/scripts/check.sh", import.meta.url), "utf8");
  assert.doesNotMatch(moduleCheck, /integration-runtime\.test\.mts/);
  const validation = stepsOf(server).find((entry) => entry.includes("id: server-validation\n"))!;
  assert.ok(validation.includes("run: bash scripts/check.sh --coverage\n"));
  const coverage = uploadSteps(server).find((entry) => artifactName(entry) === "daynight-server-acceptance")!;
  assert.deepEqual(artifactPaths(coverage), ["packages/daynight-server/coverage.out"]);
  assert.doesNotMatch(apiIntegration, /scripts\/check\.sh|server-validation|coverage\.out/);
  assert.doesNotMatch(workflow, /verify-server-e2e|check\.sh --e2e|project-task-service-evidence|project-task-e2e-evidence|DAYNIGHT_TEST_RACE/);
});

test("startup and shutdown uses an independent selected runner and coverage artifact", () => {
  assert.match(startupShutdown, /^    name: verify \(Go server startup & shutdown\)$/m);
  assert.match(startupShutdown, /^    needs: detect-changes$/m);
  assert.match(startupShutdown, /^    if: \$\{\{ needs.detect-changes.outputs.server == 'true' \}\}$/m);
  const steps = stepsOf(startupShutdown);
  const validation = steps.find((step) => step.includes("id: startup-shutdown\n"))!;
  assert.ok(validation.includes("run: bash scripts/startup-shutdown.sh\n"));
  assert.doesNotMatch(startupShutdown, /node --test scripts\/startup-shutdown\.test\.mts/);
  assert.doesNotMatch(validation, /if:|continue-on-error/);
  assert.doesNotMatch(startupShutdown, /pnpm|scripts\/check\.sh|integration\.sh/);
  const uploads = uploadSteps(startupShutdown);
  assert.equal(uploads.length, 1);
  assert.equal(artifactName(uploads[0]!), "daynight-server-startup-shutdown");
  assert.deepEqual(artifactPaths(uploads[0]!), ["packages/daynight-server/startup-shutdown-coverage.out"]);
  assert.match(uploads[0]!, /^        if: \$\{\{ always\(\) && steps.startup-shutdown.outcome != 'skipped' \}\}$/m);
  assert.match(uploads[0]!, /^          if-no-files-found: error$/m);
  const jobMinutes = Number(startupShutdown.match(/^    timeout-minutes: (\d+)$/m)![1]);
  const stepMinutes = steps.map((step) => {
    const match = step.match(/^        timeout-minutes: ([1-9]\d*)$/m);
    assert.ok(match, `Startup/shutdown step lacks a timeout: ${step.split("\n")[0]}`);
    return Number(match[1]);
  });
  assert.ok(stepMinutes.reduce((sum, minutes) => sum + minutes, 0) <= jobMinutes - 2);
});

test("selected Go server validation requires module and startup/shutdown success", () => {
  assert.match(selectedServerStep, /^        if: \$\{\{ needs.detect-changes.outputs.server == 'true' \}\}$/m);
  assert.match(selectedServerStep, /SERVER_RESULT: \$\{\{ needs.verify-server.result \}\}/);
  assert.match(selectedServerStep, /STARTUP_SHUTDOWN_RESULT: \$\{\{ needs.verify-server-startup-shutdown.result \}\}/);
});

for (const module of ["success", "skipped", "failure", "cancelled"]) {
  for (const lifecycle of ["success", "skipped", "failure", "cancelled"]) {
    test(`selected Go server module=${module}, startup/shutdown=${lifecycle} executes the workflow guard`, () => {
      const result = spawnSync("bash", ["-e", "-c", selectedServerCommand], {
        env: { ...process.env, SERVER_RESULT: module, STARTUP_SHUTDOWN_RESULT: lifecycle },
        encoding: "utf8", timeout: 5_000,
      });
      if (result.error) throw result.error;
      assert.equal(result.signal, null);
      assert.equal(result.status === 0, module === "success" && lifecycle === "success");
    });
  }
}

test("API integration builds production Web resources and runs its explicit suite", () => {
  assert.match(apiIntegration, /uses: pnpm\/action-setup@/);
  assert.match(apiIntegration, /^          version: 11\.28\.6$/m);
  const steps = stepsOf(apiIntegration);
  const preparation = steps.find((entry) => entry.includes("name: Prepare production Web resources for API integration\n"))!;
  const integration = steps.find((entry) => entry.includes("id: server-integration\n"))!;
  assert.ok(preparation.includes("pnpm install --frozen-lockfile --store-dir .tmp/pnpm-store"));
  assert.ok(preparation.includes("pnpm web:build"));
  assert.ok(integration.includes("run: bash scripts/integration.sh\n"));
  assert.doesNotMatch(integration, /if:|continue-on-error/);
  assert.ok(steps.indexOf(preparation) < steps.indexOf(integration));
});

test("Linux API integration runs its runtime tools once before production preparation", () => {
  const command = "node --test scripts/integration-runtime.test.mts";
  const tools = stepsOf(apiIntegration).filter((entry) => entry.includes(`run: ${command}\n`));
  assert.equal(tools.length, 1);
  assert.equal(workflow.split(`run: ${command}\n`).length - 1, 1);
  const runtimeTools = tools[0]!;
  assert.match(apiIntegration, /^    runs-on: ubuntu-latest$/m);
  assert.match(runtimeTools, /^      - name: Validate API integration runtime tools$/m);
  assert.match(runtimeTools, /^        timeout-minutes: 1$/m);
  assert.match(runtimeTools, /^        run: node --test scripts\/integration-runtime\.test\.mts$/m);
  assert.doesNotMatch(runtimeTools, /if:|continue-on-error/);
  const steps = stepsOf(apiIntegration);
  const nodeSetup = steps.find((entry) => entry.includes("uses: actions/setup-node@"))!;
  const preparation = steps.find((entry) => entry.includes("name: Prepare production Web resources for API integration\n"))!;
  const integration = steps.find((entry) => entry.includes("id: server-integration\n"))!;
  assert.ok(steps.indexOf(nodeSetup) < steps.indexOf(runtimeTools));
  assert.ok(steps.indexOf(runtimeTools) < steps.indexOf(preparation));
  assert.ok(steps.indexOf(runtimeTools) < steps.indexOf(integration));
});

test("API integration budgets every step and reserves independent cleanup time", () => {
  const jobMinutes = Number(apiIntegration.match(/^    timeout-minutes: (\d+)$/m)![1]);
  const stepMinutes = stepsOf(apiIntegration).map((step) => {
    const match = step.match(/^        timeout-minutes: ([1-9]\d*)$/m);
    assert.ok(match, `API integration step lacks a positive timeout: ${step.split("\n")[0]}`);
    return Number(match[1]);
  });
  assert.deepEqual(stepMinutes, [1, 1, 2, 1, 1, 1, 7, 20, 3, 1]);
  assert.ok(stepMinutes.reduce((total, minutes) => total + minutes, 0) <= jobMinutes - 2);
});

test("API integration reconciles after failure and uploads only safe results and logs", () => {
  const steps = stepsOf(apiIntegration);
  const integration = steps.find((entry) => entry.includes("id: server-integration\n"))!;
  const cleanup = steps.find((entry) => entry.includes("run: bash scripts/integration.sh --cleanup\n"))!;
  const uploads = uploadSteps(apiIntegration);
  assert.equal(uploads.length, 1);
  const upload = uploads[0]!;
  for (const step of [cleanup, upload]) {
    assert.match(step, /^        if: \$\{\{ always\(\) && steps.server-integration.outcome != 'skipped' \}\}$/m);
    assert.doesNotMatch(step, /continue-on-error/);
  }
  assert.equal(artifactName(upload), "daynight-server-api-integration");
  assert.deepEqual(artifactPaths(upload), [
    "packages/daynight-server/.tmp/integration-results/**/build.json",
    "packages/daynight-server/.tmp/integration-results/**/result.json",
    "packages/daynight-server/.tmp/integration-results/**/run.log",
  ]);
  assert.match(upload, /^          include-hidden-files: true$/m);
  assert.match(upload, /^          if-no-files-found: error$/m);
  assert.match(upload, /^          retention-days: 30$/m);
  assert.ok(steps.indexOf(integration) < steps.indexOf(cleanup));
  assert.ok(steps.indexOf(cleanup) < steps.indexOf(upload));
});

test("selected API integration requires actual success", () => {
  assert.match(selectedAPIStep, /^        if: \$\{\{ needs.detect-changes.outputs.api == 'true' \}\}$/m);
  assert.match(selectedAPIStep, /API_INTEGRATION_RESULT: \$\{\{ needs.verify-api-integration.result \}\}/);
});

for (const outcome of ["success", "skipped", "failure", "cancelled"]) {
  test(`selected API integration ${outcome} executes the workflow guard`, () => {
    const result = spawnSync("bash", ["-e", "-c", selectedAPICommand], {
      env: { ...process.env, API_INTEGRATION_RESULT: outcome },
      encoding: "utf8", timeout: 5_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.signal, null);
    assert.equal(result.status === 0, outcome === "success");
  });
}
