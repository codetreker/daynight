import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptanceCoverageCommand, parseAcceptanceMode } from "../../scripts/project-task-acceptance.js";
import { budgetProbeNames, budgetProbesPassed } from "../../scripts/project-task-budgets.js";
import type { BudgetMode, BudgetProbeReceipt } from "../../scripts/project-task-budgets.js";

const routine = ["command-deadline-with-progress", "request-deadline-after-headers"];
const stress = [...routine, "decoded-single-response-at-limit", "decoded-single-response-over-limit", "decoded-cumulative-response-at-limit", "decoded-cumulative-response-over-limit"];
const passedProbe = (name: string): BudgetProbeReceipt => ({
  name, passed: true, elapsedMs: 1, deadlines: { totalMs: 300_000, requestMs: 30_000, mocked: false },
  requests: 1, bearerRequests: 1, credentialSource: "normal-uniauth-session-pat", authenticationScope: "bearer-transport-only",
  completedPages: 1, uniqueCursors: 1, responseBodyBytes: [], generatedDecodedBytes: 0, compressedBytes: 0,
  exitCode: 0, signal: null, stdoutBytes: 0, stdout: "", stderr: "", childReaped: true, socketsClosed: true,
  serverClosed: true, fixtureRemoved: true, failures: [],
});
const directories: string[] = [];
const script = path.resolve(import.meta.dirname, "../../../daynight-server/scripts/check.sh");
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("project/task acceptance selection", () => {
  it("keeps stress selection explicit and rejects unknown or repeated arguments", () => {
    expect(parseAcceptanceMode([])).toBe("routine");
    expect(parseAcceptanceMode(["--stress"])).toBe("stress");
    for (const args of [[""], ["--unknown"], ["--stress", "--stress"], ["--stress", "extra"]]) expect(() => parseAcceptanceMode(args)).toThrow("[--stress]");
  });

  it("keeps routine coverage deadlines and adds native stress selection only on request", () => {
    const ordinary = acceptanceCoverageCommand("routine");
    expect(ordinary.watchdogMs).toBe(12 * 60_000);
    expect(ordinary.args).not.toContain("--tags");
    expect(ordinary.args).not.toContain("--timeout");
    expect(acceptanceCoverageCommand("stress")).toEqual({ args: [...ordinary.args, "--tags", "stress", "--timeout", "20m"], watchdogMs: 22 * 60_000 });
  });

  it.each(["routine", "stress"] as const)("requires exactly the selected %s probe identities regardless of completion order", (mode) => {
    const names = mode === "routine" ? routine : stress;
    expect(budgetProbeNames(mode)).toEqual(names);
    const receipts = names.map(passedProbe).reverse();
    expect(budgetProbesPassed(mode, receipts)).toBe(true);
    expect(budgetProbesPassed(mode, [])).toBe(false);
    expect(budgetProbesPassed(mode, receipts.slice(1))).toBe(false);
    expect(budgetProbesPassed(mode, [...receipts, passedProbe("unknown")])).toBe(false);
    expect(budgetProbesPassed(mode, receipts.map((value, index) => index === 0 ? { ...value, name: "unknown" } : value))).toBe(false);
    expect(budgetProbesPassed(mode, receipts.map((value, index) => index === 0 ? { ...value, name: receipts[1]!.name } : value))).toBe(false);
  });

  it.each(["passed", "childReaped", "socketsClosed", "serverClosed", "fixtureRemoved"] as const)("rejects selected receipts with %s=false", (field) => {
    const receipts = routine.map(passedProbe);
    receipts[0] = { ...receipts[0]!, [field]: false };
    expect(budgetProbesPassed("routine", receipts)).toBe(false);
  });

  it("rejects recorded failures even if the receipt claims success", () => {
    const receipts = routine.map(passedProbe);
    receipts[0] = { ...receipts[0]!, failures: ["cleanup failed"] };
    expect(budgetProbesPassed("routine", receipts)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects shell arguments before environment or resource preparation", () => {
    for (const args of [[""], ["--unknown"], ["--stress", "--stress"]]) {
      const result = spawnSync("bash", [script, ...args], { encoding: "utf8", timeout: 5_000, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "DAYNIGHT_TEST_DATABASE_URL")) });
      expect({ status: result.status, stdout: result.stdout, error: result.error }).toEqual({ status: 2, stdout: "", error: undefined });
      expect(result.stderr).toContain("Usage: bash packages/daynight-server/scripts/check.sh [--stress]");
    }
  });

  it.skipIf(process.platform === "win32").each(["routine", "stress"] as const)("forwards only explicit %s selection and clears ambient Go tags", async (mode: BudgetMode) => {
    const temporary = path.resolve(import.meta.dirname, "../../../../.tmp/check-script-tests");
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "selection-"));
    directories.push(directory);
    const moduleRoot = path.join(directory, "module");
    const bin = path.join(directory, "bin");
    const record = path.join(directory, "commands.jsonl");
    await mkdir(moduleRoot);
    await mkdir(bin);
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
    const copied = path.join(directory, "check.sh");
    await copyFile(script, copied);
    await writeFile(path.join(directory, "env.sh"), 'export DAYNIGHT_MODULE_ROOT="$DAYNIGHT_CHECK_TEST_MODULE"\n');
    for (const name of ["pnpm", "go", "node"]) {
      const executable = path.join(bin, name);
      await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nimport path from "node:path";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.DAYNIGHT_CHECK_TEST_RECORD, JSON.stringify({ name: path.basename(process.argv[1]), args, buildTags: process.env.BUILD_TAGS ?? null }) + "\\n");\nif (args[0] === "scripts/prepare-uniauth-fixture.mts") process.stdout.write("fixture-uniauth\\n");\n`);
      await chmod(executable, 0o700);
    }
    const args = mode === "stress" ? ["--stress"] : [];
    const result = spawnSync("bash", [copied, ...args], { encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DAYNIGHT_TEST_DATABASE_URL: "fixture-database",
        DAYNIGHT_CHECK_TEST_MODULE: moduleRoot, DAYNIGHT_CHECK_TEST_RECORD: record, BUILD_TAGS: "ambient-stress" } });
    expect({ status: result.status, stderr: result.stderr, error: result.error }).toEqual({ status: 0, stderr: "", error: undefined });
    const calls = (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; args: string[]; buildTags: string | null });
    expect(calls.at(-1)).toEqual({ name: "node", args: [`${moduleRoot}/../daynight/scripts/project-task-acceptance.ts`, ...args], buildTags: null });
    expect(calls.filter(({ name }) => name === "go").map(({ buildTags }) => buildTags)).toEqual([null, null, null]);
  });
});
