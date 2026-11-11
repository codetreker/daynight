import path from "node:path";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { startCopilotProcess } from "../../../src/commands/controller/providers/copilot-owned-process.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-owned-process");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const node = path.join(root, process.platform === "win32" ? "worker-node.exe" : "worker-node");
  await copyFile(process.execPath, node); await chmod(node, 0o755);
  const entry = path.join(root, "copilot.mjs"), receipt = path.join(root, "receipt.json");
  await writeFile(entry, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)},JSON.stringify({node:process.execPath,args:process.argv.slice(2)})); console.log('Listening on port 12345'); setInterval(()=>{},1000);`);
  const operation = createOperation();
  try {
    const launch = await resolveToolLaunch({ tool: "copilot", context: "herdr", choice: { kind: "path", path: entry }, cwd: root, environment: process.env, workerNode: node }, operation);
    return { root, node, entry, receipt, launch };
  } finally { operation.dispose(); }
};

test("the shared Copilot owner starts the frozen Node and literal recipe despite a changed PATH", async () => {
  const f = await fixture();
  const runtime = startCopilotProcess({ cwd: f.root, toolLaunch: f.launch, env: { ...process.env, PATH: "" }, onSpawn() {} }, () => {});
  try {
    await expect(runtime.ready).resolves.toMatchObject({ port: 12345 });
    expect(JSON.parse(await readFile(f.receipt, "utf8"))).toEqual({ node: await realpath(f.node), args: ["--headless", "--no-auto-update"] });
  } finally { await runtime.close(); }
});

test("changed frozen Copilot input rejects before any process or receipt is created", async () => {
  const f = await fixture(); await writeFile(f.entry, "throw new Error('replacement');");
  let spawned = false;
  const runtime = startCopilotProcess({ cwd: f.root, toolLaunch: f.launch, onSpawn() { spawned = true; } }, () => {});
  await expect(runtime.ready).rejects.toMatchObject({ code: "tool_identity_changed" });
  await runtime.close();
  expect(spawned).toBe(false);
  await expect(readFile(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
});
