import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { copilotDeadline, startCopilotProcess } from "../../../src/commands/controller/providers/copilot-owned-process.js";
import { removeFixtureRoot } from "../../helpers/tool-fixture-cleanup.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeFixtureRoot(root); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-owned-process");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const node = path.join(root, process.platform === "win32" ? "worker-node.exe" : "worker-node");
  await copyFile(process.execPath, node); await chmod(node, 0o755);
  const entry = path.join(root, "copilot.mjs"), receipt = path.join(root, "receipt.json");
  await writeFile(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)},JSON.stringify({node:process.execPath,args:process.argv.slice(2),routeGate:process.env.COPILOT_ALLOW_GET_PROVIDER_ENDPOINT??null})); console.log('Listening on port 12345'); setInterval(()=>{},1000);`);
  const operation = createOperation();
  try {
    const launch = await resolveToolLaunch({ tool: "copilot", context: "web", choice: { kind: "path", path: entry }, cwd: root, environment: process.env, workerNode: node }, operation);
    let closed = Promise.resolve();
    const onSpawn = (child: ChildProcess) => { closed = new Promise<void>(resolve => child.once("close", () => resolve())); };
    const close = async (runtime: ReturnType<typeof startCopilotProcess>) => {
      // The owner may settle at exit; fixture deletion also needs closed stdio.
      try { await runtime.close(); }
      finally { await copilotDeadline(closed, "Fixture native process close", 5000); }
    };
    return { root, node, entry, receipt, launch, onSpawn, close };
  } finally { operation.dispose(); }
};

test("the shared Copilot owner starts the frozen Node and literal recipe despite a changed PATH", async () => {
  const f = await fixture();
  const runtime = startCopilotProcess({ cwd: f.root, toolLaunch: f.launch, env: { ...process.env, PATH: "" }, onSpawn: f.onSpawn }, () => {});
  try {
    await expect(runtime.ready).resolves.toMatchObject({ port: 12345 });
    expect(runtime.nativeExecutableSha256).toBeNull();
    expect(JSON.parse(await readFile(f.receipt, "utf8"))).toMatchObject({ node: await realpath(f.node), args: ["--headless", "--no-auto-update"] });
  } finally { await f.close(runtime); }
});

test.each([
  { observe: false, configured: undefined, expected: null },
  { observe: true, configured: undefined, expected: "true" },
  ...["false", "1", "", "true"].map(configured => ({ observe: true, configured, expected: configured })),
])("owned image observation preserves native read policy: %j", async ({ observe, configured, expected }) => {
  const f = await fixture();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "COPILOT_ALLOW_GET_PROVIDER_ENDPOINT"));
  environment.COPILOT_ALLOW_GET_PROVIDER_ENDPOINT = configured;
  const original = { ...environment }, parent = process.env.COPILOT_ALLOW_GET_PROVIDER_ENDPOINT;
  const runtime = startCopilotProcess({ cwd: f.root, toolLaunch: f.launch, env: environment, observeImageRoute: observe, onSpawn: f.onSpawn }, () => {});
  try {
    await runtime.ready;
    expect(JSON.parse(await readFile(f.receipt, "utf8")).routeGate).toBe(expected);
    expect(environment).toEqual(original);
    expect(process.env.COPILOT_ALLOW_GET_PROVIDER_ENDPOINT).toBe(parent);
  } finally { await f.close(runtime); }
});

test.skipIf(process.platform !== "win32").each(["false", "1", ""])("Windows preserves an explicitly mixed-case read gate: %j", async value => {
  const f = await fixture();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "COPILOT_ALLOW_GET_PROVIDER_ENDPOINT"));
  environment.Copilot_Allow_Get_Provider_Endpoint = value;
  const runtime = startCopilotProcess({ cwd: f.root, toolLaunch: f.launch, env: environment, observeImageRoute: true, onSpawn: f.onSpawn }, () => {});
  try { await runtime.ready; expect(JSON.parse(await readFile(f.receipt, "utf8")).routeGate).toBe(value); }
  finally { await f.close(runtime); }
  expect(environment.Copilot_Allow_Get_Provider_Endpoint).toBe(value);
  expect(environment).not.toHaveProperty("COPILOT_ALLOW_GET_PROVIDER_ENDPOINT");
});

test("changed frozen Copilot input rejects before any process or receipt is created", async () => {
  const f = await fixture(); await writeFile(f.entry, "throw new Error('replacement');");
  let spawned = false;
  const runtime = startCopilotProcess({ cwd: f.root, toolLaunch: f.launch, onSpawn(child) { spawned = true; f.onSpawn(child); } }, () => {});
  try { await expect(runtime.ready).rejects.toMatchObject({ code: "tool_identity_changed" }); }
  finally { await f.close(runtime); }
  expect(spawned).toBe(false);
  await expect(readFile(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
});
