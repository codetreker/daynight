import path from "node:path";
import { chmod, copyFile, link, mkdir, mkdtemp, open, realpath, readFile, rm, stat, symlink, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { fstatSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../src/api/operation.js";
import { fingerprintToolArtifact, probeResourceKey, resolveToolLaunch, toolCommand, toolSelectionKey, verifyToolLaunch } from "../../src/platform/tool-executables.js";
import { parseResolvedToolLaunch } from "../../src/platform/tool-launch-record.js";
import { removeFixtureRoot } from "../helpers/tool-fixture-cleanup.js";
import { holdToolFileWithoutDeleteSharing, ToolUnlinkDiagnostics } from "./tool-unlink-diagnostics.js";

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
  const root = await fixture(), packageRoot = path.join(root, "node_modules/@openai/codex"), entry = path.join(packageRoot, "custom/loader.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "#!/usr/bin/env node\nconsole.log('loader')\n");
  const manifest = path.join(packageRoot, "package.json");
  await writeFile(manifest, JSON.stringify({ name: "@openai/codex", bin: { codex: "custom/loader.js" } }));
  const runtime = path.join(packageRoot, process.platform === "win32" ? "native.exe" : "native");
  await copyFile(process.execPath, runtime); await chmod(runtime, 0o755);
  return { root, entry, runtime, manifest };
};
afterEach(async () => { vi.restoreAllMocks(); for (const item of operations.splice(0)) item.dispose(); await Promise.all(roots.splice(0).map(root => removeFixtureRoot(root))); });

describe("resolved tool commands", () => {
  it.skipIf(process.platform === "win32")("rejects FIFO entries and replacements without starving unrelated filesystem work", async () => {
    const root = await fixture(), fifos = Array.from({ length: 4 }, (_, i) => path.join(root, `fifo-${i}`));
    await execute("mkfifo", [...fifos, path.join(root, "entry-replacement"), path.join(root, "artifact-replacement")], { timeout: 5000 });
    await writeFile(path.join(root, "healthy"), "ready");
    await script(root, "race-entry", "unused");
    await writeFile(path.join(root, "race-artifact"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    await chmod(path.join(root, "race-artifact"), 0o755);
    const helper = fileURLToPath(new URL("./fixtures/tool-fifo.mjs", import.meta.url));
    const { stdout } = await execute(process.execPath, [helper, root], { timeout: 8000, env: { ...process.env, UV_THREADPOOL_SIZE: "4" } });
    expect(JSON.parse(stdout)).toEqual({ rejected: 4, replacementsRejected: 2, filesystemResponsive: true });
  }, 12_000);

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
    const diagnostics = process.platform === "win32" ? new ToolUnlinkDiagnostics() : undefined;
    const execution = execute(command.file, command.args, { cwd: root, timeout: 5000 });
    diagnostics?.observe(execution.child);
    const result = await execution;
    diagnostics?.executionCompleted();
    expect(JSON.parse(result.stdout).node).toBe(await realpath(node));
    if (diagnostics) await diagnostics.unlink(node); else await rm(node);
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
    if (process.platform !== "win32") {
      expect(probeResourceKey(a, { ...scope, environment: { Path: "A" } })).not.toBe(probeResourceKey(a, { ...scope, environment: { Path: "B" } }));
    }
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

  it.skipIf(process.platform === "win32")("executes a Node loader that replaces itself and propagates argv and exit", async () => {
    const root = await fixture(), entry = path.join(root, "loader.js");
    const program = "process.stdout.write(JSON.stringify({pid:process.pid,args:process.argv.slice(1)}));process.exit(23)";
    await writeFile(entry, `#!/usr/bin/env node\nprocess.execve(process.execPath, [process.execPath, "-e", ${JSON.stringify(program)}, "--", ...process.argv.slice(2)], process.env);\n`);
    const launch = await resolve(entry, root), args = ["space and 中文", "$(literal)", "&", "'quoted'"], command = toolCommand(launch, args);
    const child = spawn(command.file, command.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const result = await closed;
      expect(result, stderr).toEqual({ code: 23, signal: null });
      expect(JSON.parse(stdout)).toEqual({ pid: child.pid, args });
      expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
  }, 10_000);

  it("verifies a legacy recipe using its recorded files and Node flags", async () => {
    const { root, entry, runtime, manifest } = await codexFixture();
    const current = await resolve(entry, root);
    const artifacts = [...current.artifacts,
      await fingerprintToolArtifact({ role: "manifest", path: manifest }, operation()),
      await fingerprintToolArtifact({ role: "runtime", path: runtime }, operation())];
    const command = { file: current.command.file, prefixArgs: ["--no-global-search-paths", "--no-preserve-symlinks", "--no-preserve-symlinks-main", entry] };
    const old = { ...current, command, artifacts };
    const legacy = { ...old, selectionKey: toolSelectionKey(old) };
    const persisted = parseResolvedToolLaunch(JSON.parse(JSON.stringify(legacy)));
    await verifyToolLaunch(persisted, operation());
    expect((await execute(toolCommand(legacy, []).file, toolCommand(legacy, []).args, { timeout: 5000 })).stdout.trim()).toBe("loader");
    await writeFile(runtime, "changed runtime");
    await expect(verifyToolLaunch(legacy, operation())).rejects.toMatchObject({ stage: "verify", code: "tool_identity_changed" });
  });

  it.skipIf(process.platform === "win32")("rejects loss of execute permission on a recorded runtime", async () => {
    const { root, entry, runtime } = await codexFixture(), current = await resolve(entry, root);
    const artifacts = [...current.artifacts, await fingerprintToolArtifact({ role: "runtime", path: runtime }, operation())];
    const old = { ...current, artifacts }, legacy = { ...old, selectionKey: toolSelectionKey(old) };
    await chmod(runtime, 0o644);
    await expect(verifyToolLaunch(legacy, operation())).rejects.toMatchObject({ stage: "verify", code: "tool_identity_changed" });
  });

});

describe("tool executable unlink diagnostics", () => {
  it("keeps secrets out of the receipt and rethrows the original unlink error without retry", async () => {
    const secret = "PRIVATE-UNLINK-SENTINEL";
    const failure = Object.assign(new Error(`${secret}/worker-node.exe`), {
      code: "EBUSY", errno: -4082, syscall: "unlink", path: `${secret}/worker-node.exe`,
      cmd: secret, stdout: secret, stderr: secret, env: { TOKEN: secret },
    });
    const output = vi.spyOn(console, "error");
    const remove = vi.fn(async () => { throw failure; });
    const diagnostics = new ToolUnlinkDiagnostics();
    await expect(diagnostics.unlink(`${secret}/worker-node.exe`, remove)).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
    const line = output.mock.calls[0]![0] as string;
    expect(line).not.toContain(secret);
    expect(JSON.parse(line)).toMatchObject({ target: "<fixture>/worker-node.exe", holder: { kind: "unknown" }, process: { exitObserved: false, closeObserved: false } });
    expect(diagnostics.receipt().events.at(-1)).toMatchObject({ kind: "unlink-error", error: { code: "EBUSY", errno: -4082, syscall: "unlink" } });
  });

  it.skipIf(process.platform !== "win32").each([true, false])("distinguishes known handle evidence (%s) from child exit before explicit unlink", async knownOwner => {
    const root = await fixture(), node = path.join(root, "worker-node.exe");
    await copyFile(process.execPath, node); await chmod(node, 0o755);
    const entry = await script(root, "codex.js", "controlled");
    const diagnostics = new ToolUnlinkDiagnostics();
    const execution = execute(node, [entry], { cwd: root, timeout: 5000 });
    diagnostics.observe(execution.child);
    const result = await execution; diagnostics.executionCompleted();
    expect(JSON.parse(result.stdout).node).toBe(await realpath(node));
    const release = await holdToolFileWithoutDeleteSharing(node, knownOwner ? diagnostics : undefined);
    const output = vi.spyOn(console, "error");
    let receipt: ReturnType<ToolUnlinkDiagnostics["receipt"]>;
    try {
      await expect(diagnostics.unlink(node)).rejects.toMatchObject({ code: "EBUSY", syscall: "unlink", path: node });
      expect(output).toHaveBeenCalledTimes(1);
      const line = output.mock.calls[0]![0] as string;
      expect(line).not.toContain(root);
      receipt = JSON.parse(line);
      expect(receipt).toMatchObject({
        holder: knownOwner ? { kind: "test-owned-handle-present", pid: process.pid } : { kind: "unknown", pid: null },
        process: { pid: execution.child.pid, identityPrecision: "pid-only", birth: null, spawnObserved: true,
          exitObserved: true, closeObserved: true, executionCompleted: true, exitCode: 0, signal: null },
      });
      const kinds = receipt.events.map(event => event.kind);
      expect(kinds.indexOf("exit")).toBeLessThan(kinds.indexOf("close"));
      expect(kinds.indexOf("close")).toBeLessThan(kinds.indexOf("execution-completed"));
      expect(kinds.indexOf("execution-completed")).toBeLessThan(kinds.indexOf("unlink-start"));
      expect(kinds.at(-1)).toBe("unlink-error");
      if (knownOwner) {
        expect(kinds.indexOf("test-handle-opened")).toBeGreaterThan(kinds.indexOf("execution-completed"));
        expect(kinds.indexOf("test-handle-opened")).toBeLessThan(kinds.indexOf("unlink-start"));
        expect(kinds).not.toContain("test-handle-closed");
      } else expect(kinds).not.toContain("test-handle-opened");
      expect((await stat(node)).isFile()).toBe(true);
    } finally { release(); }
    // A real, explicitly released test handle permits a new deletion. This is
    // not a retry policy, and a later success cannot identify an unknown owner.
    await diagnostics.unlink(node);
    await expect(realpath(node)).rejects.toMatchObject({ code: "ENOENT" });
    expect(output).toHaveBeenCalledTimes(1);
    expect(receipt!.events.at(-1)?.kind).toBe("unlink-error");
    expect(diagnostics.receipt().holder.kind).toBe("unknown");
    if (knownOwner) {
      expect(diagnostics.receipt().events.slice(-4).map(event => event.kind)).toEqual(["unlink-error", "test-handle-closed", "unlink-start", "unlink-success"]);
    }
  });
});

describe("tool fixture cleanup", () => {
  it("retries a busy root without multiplying waits by directory depth", async () => {
    const root = await fixture(), nested = path.join(root, "a/b/c/d/file");
    await mkdir(path.dirname(nested), { recursive: true }); await writeFile(nested, "owned");
    const waits: number[] = [], targets: unknown[] = [];
    const busy = Object.assign(new Error("Controlled busy fixture"), { code: "EBUSY" });
    let attempts = 0;
    await removeFixtureRoot(root, async (target, options) => {
      targets.push(target);
      expect(options).toEqual({ recursive: true, force: true, maxRetries: 0 });
      if (++attempts < 4) throw busy;
      await rm(target, options);
    }, async ms => { waits.push(ms); });
    expect(targets).toEqual([root, root, root, root]);
    expect(waits).toEqual([100, 200, 300]);
    await expect(realpath(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["EBUSY", "EPERM", "EACCES", "EIO"])("retains the original %s error after its permitted attempts", async code => {
    const root = await fixture(), failures: Error[] = [], waits: number[] = [];
    await writeFile(path.join(root, "preserved"), "owned");
    await expect(removeFixtureRoot(root, async () => {
      const failure = Object.assign(new Error("Controlled fixture refusal"), { code }); failures.push(failure); throw failure;
    }, async ms => { waits.push(ms); })).rejects.toSatisfy(error => error === failures.at(-1));
    expect(failures).toHaveLength(code === "EBUSY" ? 4 : 1);
    expect(waits).toEqual(code === "EBUSY" ? [100, 200, 300] : []);
    expect(await readFile(path.join(root, "preserved"), "utf8")).toBe("owned");
  });

  it.skipIf(process.platform !== "win32").each(["release", "retain"] as const)("keeps native executable cleanup bounded when the holder must %s its lock", async mode => {
    const root = await fixture(), directory = path.join(root, "native-bin"); await mkdir(directory);
    const entry = path.join(directory, "codex.exe"); await copyFile(process.execPath, entry);
    const helper = fileURLToPath(new URL("./fixtures/tool-cleanup-holder.mjs", import.meta.url));
    const child = spawn(process.execPath, [helper, entry], { cwd: scratch, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "", childError: Error | undefined, released = false, primary: unknown;
    child.stdout!.resume(); child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("error", error => { childError = error; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.on("message", message => {
        if (typeof message !== "object" || message === null || !("kind" in message)) return;
        if (message.kind === "held") resolve();
        if (message.kind === "released") released = true;
        if (message.kind === "failed") reject(new Error(JSON.stringify(message)));
      });
      child.once("error", reject);
      child.once("close", () => reject(new Error(`Executable holder closed before readiness: ${stderr}`)));
    });
    // The parent owns a separate deadline; cleanup still joins the actual close.
    const watchdog = setTimeout(() => { child.kill("SIGKILL"); }, 6000);
    const release = async () => {
      let sendError: unknown;
      try { if (child.connected) await new Promise<void>((resolve, reject) => child.send({ kind: "release" }, error => error ? reject(error) : resolve())); }
      catch (error) { sendError = error; }
      const outcome = await closed;
      if (sendError || childError || outcome.code !== 0 || outcome.signal !== null || !released) {
        throw new Error(`Executable holder did not release and close: ${JSON.stringify({ ...outcome, released, sendError: String(sendError ?? ""), childError: childError?.message, stderr })}`);
      }
    };
    const busy: unknown[] = [];
    try {
      await ready;
      const removal = removeFixtureRoot(root, async (target, options) => {
        try { await rm(target, options); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error;
          expect(error).toMatchObject({ code: "EBUSY", syscall: "unlink", path: entry });
          busy.push(error);
          // Release is triggered by an actual kernel refusal, never a timer.
          if (mode === "release" && busy.length === 1) await release();
          throw error;
        }
      });
      if (mode === "release") {
        await removal;
        expect(busy.length).toBeGreaterThan(0);
        await expect(realpath(root)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(removal).rejects.toSatisfy(error => error === busy.at(-1));
        expect(busy).toHaveLength(4);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect((await stat(entry)).isFile()).toBe(true);
      }
    } catch (error) { primary = error; }
    finally {
      let cleanup: unknown;
      try { await release(); } catch (error) { cleanup = error; }
      finally { clearTimeout(watchdog); }
      if (cleanup !== undefined) throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], "Executable holder cleanup failed.");
    }
    if (primary !== undefined) throw primary;
  }, 10_000);
});
