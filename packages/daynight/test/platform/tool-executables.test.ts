import path from "node:path";
import { chmod, copyFile, link, mkdir, mkdtemp, open, realpath, rm, symlink, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { fstatSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../src/api/operation.js";
import { probeResourceKey, resolveToolLaunch, toolCommand, verifyToolLaunch } from "../../src/platform/tool-executables.js";

const execute = promisify(execFile);
const roots: string[] = [], operations: Operation[] = [];
const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/tool-executables-tests");
const fixture = async () => { await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, "launch-")); roots.push(root); return root; };
const operation = () => { const result = createOperation({ limits: { totalMs: 20_000 } }); operations.push(result); return result; };
const script = async (root: string, name: string, label: string) => {
  const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ label: ${JSON.stringify(label)}, node: process.execPath, args: process.argv.slice(2) }));\n`);
  await chmod(file, 0o755); return file;
};
const resolve = (entry: string, cwd: string, workerNode = process.execPath) => resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: entry }, cwd, workerNode, environment: process.env }, operation());
const codexFixture = async () => {
  const root = await fixture(), packageRoot = path.join(root, "node_modules/@openai/codex"), entry = path.join(packageRoot, "bin/codex.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await copyFile(new URL("./fixtures/tool-launchers/codex-0.156.1.js", import.meta.url), entry);
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", type: "module", bin: { codex: "bin/codex.js" } }));
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
  const target = process.platform === "win32" ? "pc-windows-msvc" : process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const relativeRuntime = path.join("vendor", `${architecture}-${target}`, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const runtime = path.join(packageRoot, relativeRuntime);
  await mkdir(path.dirname(runtime), { recursive: true }); await copyFile(process.execPath, runtime); await chmod(runtime, 0o755);
  return { root, entry, runtime, relativeRuntime, packageRoot };
};
afterEach(async () => { vi.restoreAllMocks(); for (const item of operations.splice(0)) item.dispose(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("resolved tool commands", () => {
  it("passes literal arguments and path punctuation to the selected Node script", async () => {
    const root = await fixture();
    const name = process.platform === "win32" ? "Unicode 工具 $() & %.js" : "Unicode 工具 '$()\" & %.js";
    const entry = await script(root, name, "A"), launch = await resolve(entry, root);
    const args = ["", "hello world", "'\"$()&%", "\\", "--model", "模型"];
    const command = toolCommand(launch, args);
    const receipt = JSON.parse((await execute(command.file, command.args, { cwd: root, timeout: 5000 })).stdout);
    expect(receipt).toEqual({ label: "A", node: await realpath(process.execPath), args });
    expect(launch).toMatchObject({ source: "explicit", executablePath: await realpath(entry), interpreterPath: await realpath(process.execPath) });
  });

  it("freezes Worker Node A rather than PATH Node B or the script's nvm directory C", async () => {
    const root = await fixture(), node = path.join(root, process.platform === "win32" ? "worker-node.exe" : "worker-node");
    await copyFile(process.execPath, node); await chmod(node, 0o755);
    const entry = await script(root, "nvm-C/bin/codex.js", "C");
    const pathNode = path.join(root, "node-B"), nodeName = process.platform === "win32" ? "node.exe" : "node";
    await mkdir(pathNode);
    await link(node, path.join(pathNode, nodeName));
    await link(node, path.join(path.dirname(entry), nodeName));
    const launch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: entry }, cwd: root, workerNode: node, environment: { PATH: pathNode } }, operation());
    const command = toolCommand(launch, []);
    expect(JSON.parse((await execute(command.file, command.args, { cwd: root, timeout: 5000 })).stdout).node).toBe(await realpath(node));
    await rm(node);
    await expect(verifyToolLaunch(launch, operation())).rejects.toMatchObject({ tool: "codex", context: "web", stage: "verify", code: "tool_identity_changed" });
  });

  it.skipIf(process.platform === "win32")("captures relative PATH entries and never changes an existing selection to PATH B", async () => {
    const root = await fixture(), first = await script(root, "A/codex", "A"); await script(root, "B/codex", "B");
    const input = { tool: "codex" as const, context: "web" as const, choice: { kind: "auto" as const }, cwd: root, workerNode: process.execPath };
    const launchA = await resolveToolLaunch({ ...input, environment: { PATH: "A" } }, operation());
    const launchB = await resolveToolLaunch({ ...input, environment: { PATH: "B" } }, operation());
    for (const [launch, label] of [[launchA, "A"], [launchB, "B"]] as const) {
      const command = toolCommand(launch, []);
      expect(JSON.parse((await execute(command.file, command.args, { timeout: 5000 })).stdout).label).toBe(label);
    }
    await rm(first); await expect(verifyToolLaunch(launchA, operation())).rejects.toMatchObject({ code: "tool_identity_changed" });
  });

  it("searches the captured PATH on this OS and launches the absolute native result", async () => {
    const root = await fixture(), directory = path.join(root, "native-bin"); await mkdir(directory);
    const entry = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    await copyFile(process.execPath, entry); await chmod(entry, 0o755);
    const launch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "auto" }, cwd: root, environment: { PATH: "native-bin", PATHEXT: ".EXE" } }, operation());
    const command = toolCommand(launch, ["--eval", "console.log('captured-native')"]);
    expect((await execute(command.file, command.args, { cwd: root, timeout: 5000 })).stdout.trim()).toBe("captured-native");
    // Windows discovery retains the captured PATHEXT spelling in its lexical entry.
    const discovered = process.platform === "win32" ? path.join(directory, "codex.EXE") : entry;
    expect(launch).toMatchObject({ entryPath: discovered, canonicalEntryPath: await realpath(entry), interpreterPath: null, source: "path" });
  });

  it("uses canonical identity for a shared probe but retains each symlink mapping for verification", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A"), other = await script(root, "other.js", "B");
    const left = path.join(root, "left.js"), right = path.join(root, "right.js");
    await symlink(entry, left, "file"); await symlink(entry, right, "file");
    const a = await resolve(left, root), b = await resolve(right, root), direct = await resolve(entry, root);
    if (process.platform !== "win32") await symlink(entry, path.join(root, "codex"), "file");
    const automatic = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "auto" }, cwd: root, environment: { PATH: root, PATHEXT: ".JS" } }, operation());
    const scope = { cwd: root, environment: { HOME: root, CODEX_HOME: path.join(root, "native-home") } };
    expect(a.selectionKey).not.toBe(b.selectionKey);
    expect(probeResourceKey(a, scope)).toBe(probeResourceKey(b, scope));
    expect(probeResourceKey(a, scope)).toBe(probeResourceKey(direct, scope));
    expect(probeResourceKey(a, scope)).toBe(probeResourceKey(automatic, scope));
    expect(probeResourceKey(a, scope)).not.toBe(probeResourceKey(a, { ...scope, cwd: path.join(root, "other") }));
    expect(probeResourceKey(a, scope)).not.toBe(probeResourceKey(a, { ...scope, environment: { HOME: "other" } }));
    await rm(left); await symlink(other, left, "file");
    await expect(verifyToolLaunch(a, operation())).rejects.toMatchObject({ code: "tool_identity_changed" });
    await verifyToolLaunch(b, operation());
  });

  it("rejects content changes even when the path and file size stay the same", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A"), launch = await resolve(entry, root);
    await script(root, "codex.js", "B");
    await expect(verifyToolLaunch(launch, operation())).rejects.toMatchObject({ code: "tool_identity_changed" });
  });

  it("reuses a stable digest but invalidates it when equal-size content changes with restored mtime", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A"), timestamp = new Date("2020-01-01T00:00:00Z");
    const content = (label: string) => `#!/usr/bin/env node\n//${"x".repeat(8192)}\nconsole.log('${label}');\n`;
    await writeFile(entry, content("A"));
    await utimes(entry, timestamp, timestamp); const launch = await resolve(entry, root);
    const handle = await open(entry), prototype = Object.getPrototypeOf(handle) as FileHandle; await handle.close();
    const observed = vi.spyOn(prototype, "createReadStream");
    await verifyToolLaunch(launch, operation());
    // Repeated verification still reads metadata and mappings, but does not
    // rescan the large interpreter when its complete stat signature matches.
    expect(observed).not.toHaveBeenCalled();
    await writeFile(entry, content("B")); await utimes(entry, timestamp, timestamp);
    await expect(verifyToolLaunch(launch, operation())).rejects.toMatchObject({ code: "tool_identity_changed" });
    expect(observed).toHaveBeenCalled();
  });

  it("does not search PATH when an explicit entry or its interpreter is missing", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A");
    await expect(resolve(path.join(root, "missing"), root)).rejects.toMatchObject({ stage: "resolve", code: "not_found" });
    await expect(resolve(entry, root, path.join(root, "missing-node"))).rejects.toMatchObject({ stage: "resolve", code: "incompatible_runtime" });
  });

  it("rejects a cancelled resolution without returning a usable command", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A");
    const controller = new AbortController(); controller.abort(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    await expect(resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: entry }, cwd: root, workerNode: process.execPath, environment: process.env }, op)).rejects.toMatchObject({ tool: "codex", stage: "resolve", code: "cancelled" });
  });

  it("does not publish inconsistent or tampered launch identities", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A"), launch = await resolve(entry, root);
    await expect(verifyToolLaunch({ ...launch, command: { file: process.execPath, prefixArgs: ["--eval", "throw 0"] } }, operation())).rejects.toMatchObject({ code: "tool_identity_changed" });
  });

  it("rejects a file that changes while its real content stream is being hashed", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A");
    const handle = await open(entry), identity = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    const original = prototype.createReadStream;
    await handle.close();
    let modified = false;
    // Observe the actual target descriptor before mutating it; no timing delay
    // or replacement filesystem implementation stands in for the read race.
    vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
      const target = fstatSync(this.fd).ino === identity.ino;
      const stream = original.call(this, options);
      if (target && !modified) stream.once("data", () => { modified = true; writeFileSync(entry, "#!/usr/bin/env node\nconsole.log('changed during read')\n"); });
      return stream;
    });
    await expect(resolve(entry, root)).rejects.toMatchObject({ stage: "resolve", code: "tool_identity_changed" });
    expect(modified).toBe(true);
  });

  it("returns cancellation while an owned filesystem close is still pending", async () => {
    const root = await fixture(), entry = await script(root, "codex.js", "A"), handle = await open(entry);
    const prototype = Object.getPrototypeOf(handle) as FileHandle, original = prototype.createReadStream; await handle.close();
    let entered!: () => void, release!: () => void;
    const closeEntered = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
      const close = this.close.bind(this);
      this.close = async () => { await close(); entered(); await gate; };
      return original.call(this, options);
    });
    const controller = new AbortController(), op = createOperation({ signal: controller.signal }); operations.push(op);
    const result = resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: entry }, cwd: root, environment: process.env }, op);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await closeEntered; controller.abort();
      await expect(Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Resolution did not respect cancellation while closing.")), 1000); })])).rejects.toMatchObject({ code: "cancelled" });
    } finally { if (timer) clearTimeout(timer); release(); await result.catch(() => {}); }
  });

  it("keeps Web Copilot bundled while Herdr uses the captured external installation", async () => {
    const root = await fixture(), entry = await script(root, "copilot.js", "external");
    if (process.platform !== "win32") await symlink(entry, path.join(root, "copilot"), "file");
    const web = await resolveToolLaunch({ tool: "copilot", context: "web", choice: { kind: "auto" }, cwd: root, environment: { PATH: root } }, operation());
    const external = await resolveToolLaunch({ tool: "copilot", context: "herdr", choice: { kind: "auto" }, cwd: root, environment: { PATH: root, PATHEXT: ".JS" } }, operation());
    expect(web.source).toBe("bundled"); expect(web.interpreterPath).toBeNull();
    expect(external.source).toBe("path");
    expect(web.artifacts.some(item => item.role === "runtime" && item.realPath === web.executablePath)).toBe(true);
    expect(web.executablePath).not.toBe(external.executablePath);
    const command = toolCommand(external, []);
    expect(JSON.parse((await execute(command.file, command.args, { timeout: 5000 })).stdout).label).toBe("external");
  });

  it("runs the registered Codex loader with its frozen native and detects native-only replacement", async () => {
    const { root, entry, runtime } = await codexFixture();
    const launch = await resolve(entry, root), command = toolCommand(launch, ["--eval", "console.log(JSON.stringify({native:process.execPath,managed:process.env.CODEX_MANAGED_BY_NPM}))"]);
    expect(JSON.parse((await execute(command.file, command.args, { cwd: root, timeout: 5000 })).stdout)).toEqual({ native: await realpath(runtime), managed: "1" });
    expect(launch.executablePath).toBe(await realpath(entry));
    await writeFile(runtime, "replaced native");
    await expect(verifyToolLaunch(launch, operation())).rejects.toMatchObject({ stage: "verify", code: "tool_identity_changed" });
  });

  it("rejects a newly preferred platform package even when the frozen vendor native is unchanged", async () => {
    const { root, entry, relativeRuntime } = await codexFixture(), launch = await resolve(entry, root);
    const platformPackage = path.join(root, `node_modules/@openai/codex-${process.platform}-${process.arch}`);
    await mkdir(path.dirname(path.join(platformPackage, relativeRuntime)), { recursive: true });
    await writeFile(path.join(platformPackage, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    await copyFile(process.execPath, path.join(platformPackage, relativeRuntime));
    await expect(verifyToolLaunch(launch, operation())).rejects.toMatchObject({ code: "tool_identity_changed" });
  });

  it.skipIf(process.platform === "win32")("refuses an official loader whose selected native has no execute permission", async () => {
    const { root, entry, runtime } = await codexFixture(); await chmod(runtime, 0o644);
    await expect(resolve(entry, root)).rejects.toMatchObject({ stage: "resolve", code: "permission_denied" });
  });
});
