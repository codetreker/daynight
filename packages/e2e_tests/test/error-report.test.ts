import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
test("Playwright JSON retains both scenario and cleanup failures", async () => {
  const base = path.resolve(import.meta.dirname, "../../../.tmp/e2e-reporter-test");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  try {
    const testModule = import.meta.resolve("@playwright/test");
    const failureModule = pathToFileURL(path.resolve(import.meta.dirname, "../src/failures.ts")).href;
    const cli = path.resolve(import.meta.dirname, "../node_modules/@playwright/test/cli.js");
    const report = path.join(root, "report.json");
    await writeFile(path.join(root, "case.spec.ts"), `import { test } from ${JSON.stringify(testModule)};\nimport { aggregateFailures } from ${JSON.stringify(failureModule)};\ntest('failure', () => { throw aggregateFailures('both failed', [new Error('scenario evidence'), new Error('stop evidence')]); });\n`);
    await writeFile(path.join(root, "playwright.config.mjs"), `export default { testDir: ${JSON.stringify(root)}, reporter: [['json', { outputFile: ${JSON.stringify(report)} }]], outputDir: ${JSON.stringify(path.join(root, "test-results"))}, workers: 1 };\n`);
    await assert.rejects(run(process.execPath, [cli, "test", "--config", path.join(root, "playwright.config.mjs")], { cwd: root, timeout: 15_000 }), error => error instanceof Error && "code" in error && error.code === 1);
    const result = await readFile(report, "utf8");
    assert.match(result, /scenario evidence/); assert.match(result, /stop evidence/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
