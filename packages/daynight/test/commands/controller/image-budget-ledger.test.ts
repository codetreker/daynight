import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { openMediaBudgetLedger } from "../../../src/commands/controller/media/budget-ledger.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
test("stateDirectory reservations are shared and retained after close and reopen", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-budget-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "b-")); roots.push(root); const MiB = 1048576;
  const ledgers = ["a", "b", "c", "d"].map(id => openMediaBudgetLedger(root, id));
  try {
    for (const ledger of ledgers.slice(0, 3)) ledger.reserve(2200 * MiB);
    ledgers[3]!.reserve(1592 * MiB);
    expect(() => ledgers[3]!.reserve(1592 * MiB + 1)).toThrow("stateDirectory");
    expect(() => ledgers[3]!.reserve(2200 * MiB + 1)).toThrow("execution");
  } finally { for (const ledger of ledgers) ledger.close(); }
  const reopened = openMediaBudgetLedger(root, "new");
  try { expect(() => reopened.reserve(1)).toThrow("stateDirectory"); }
  finally { reopened.close(); }
});


test("independent processes cannot overbook the shared durable media reservation", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-budget-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "p-")); roots.push(root);
  const module = fileURLToPath(new URL("../../../src/commands/controller/media/budget-ledger.ts", import.meta.url));
  const children = await Promise.all(["a", "b", "c", "d"].map(id => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { openMediaBudgetLedger } from ${JSON.stringify(pathToFileURL(module).href)}; try { const ledger = openMediaBudgetLedger(process.argv[1], process.argv[2]); ledger.reserve(2200 * 1048576); ledger.close(); } catch(error) { if (!String(error).includes('stateDirectory')) { process.stderr.write(String(error)); process.exitCode = 3; } else process.exitCode = 2; }`, root, id], { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = ""; child.stderr.on("data", value => { diagnostics += String(value).slice(0, 4096); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", reject); child.once("close", code => { clearTimeout(timer); if (code !== 0 && code !== 2) reject(new Error(diagnostics || `Ledger child exited ${code}.`)); else resolve(code); });
  })));
  expect(children.filter(code => code === 0)).toHaveLength(3); expect(children.filter(code => code === 2)).toHaveLength(1);
  const check = openMediaBudgetLedger(root, "remaining");
  try { check.reserve(1592 * 1048576); expect(() => check.reserve(1592 * 1048576 + 1)).toThrow("stateDirectory"); }
  finally { check.close(); }
});
