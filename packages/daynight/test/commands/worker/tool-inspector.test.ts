import path from "node:path";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { createWorkerToolInspector } from "../../../src/commands/worker/native-selection.js";
import { BotCliProbeCleanupError } from "../../../src/commands/worker/bots/cli-probe.js";
const controlled = vi.hoisted(() => ({ create: vi.fn(), command: vi.fn() }));
vi.mock("../../../src/commands/worker/bots/cli-probe.js", async original => ({ ...await original<object>(), createBotCliProbe: controlled.create }));
vi.mock("../../../src/commands/worker/herdr/command.js", async original => ({ ...await original<object>(), runHerdrCommand: controlled.command }));
const roots: string[] = [];
const operation = () => createOperation({ limits: { totalMs: 20_000 } });
const fixture = async (tool: "codex" | "copilot") => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/tool-inspector"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const file = path.join(root, process.platform === "win32" ? "native.exe" : "native");
  if (tool === "copilot") { await copyFile(process.execPath, file); await chmod(file, 0o755); }
  else await writeFile(file, "#!/usr/bin/env node\nconsole.log('fixture');\n");
  const alias = path.join(root, process.platform === "win32" ? "alias.exe" : "alias"); await symlink(file, alias, "file");
  const op = operation();
  try {
    const resolve = (entry: string) => resolveToolLaunch({ tool, context: "web", choice: { kind: "path", path: entry }, cwd: root, environment: process.env }, op);
    return { root, launch: await resolve(file), alias: await resolve(alias) };
  } finally { op.dispose(); }
};
beforeEach(() => {
  controlled.create.mockReset(); controlled.command.mockReset();
  controlled.command.mockImplementation(async ({ args }: { args: string[] }) => ({ stdout: args.includes("--version") ? "codex-cli 0.156.1" : "app-server --stdio", stderr: "" }));
});
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("Web Copilot status carries the frozen recipe and does not execute version or help commands", async () => {
  const f = await fixture("copilot"), op = operation(), run = vi.fn(async (_file: string, _args: readonly string[]) => ({ stdout: '{"ok":true,"version":"1.0.105"}', stderr: "" }));
  controlled.create.mockResolvedValue({ run, close: async () => {} });
  const inspector = createWorkerToolInspector({ cwd: f.root, environment: process.env });
  try {
    expect(await inspector.check(f.launch, op)).toMatchObject({ version: "1.0.105" });
    const args = run.mock.calls[0]![1] as unknown as string[];
    expect(args.at(-1)).toBe("status");
    expect(JSON.parse(args[1]!)).toMatchObject({ agent: "copilot", mode: "web", toolLaunch: f.launch });
    expect(controlled.command).not.toHaveBeenCalled();
  } finally { await inspector.close(); op.dispose(); }
});

test("symlink aliases share cleanup barriers and a completed cleanup cannot reuse an earlier success generation", async () => {
  const f = await fixture("copilot"), op = operation();
  const retry = vi.fn().mockRejectedValue(new Error("unconfirmed descendants"));
  const cleanup = new BotCliProbeCleanupError({ launchId: "owned", pid: 123, process: null, jobObjectName: null, targetStarted: true }, retry);
  controlled.create.mockResolvedValueOnce({ run: async () => ({ stdout: '{"ok":true,"version":"1.0.105"}' }), close: async () => { throw cleanup; } })
    .mockResolvedValue({ run: async () => ({ stdout: '{"ok":true,"version":"1.0.105"}' }), close: async () => {} });
  const inspector = createWorkerToolInspector({ cwd: f.root, environment: process.env });
  try {
    const before = inspector.revision(f.launch);
    await expect(inspector.check(f.launch, op)).rejects.toMatchObject({ code: "cleanup_unknown" });
    expect(() => inspector.assertAvailable(f.alias)).toThrow("cleanup");
    expect(inspector.revision(f.alias)).toBeGreaterThan(before);
    await expect(inspector.check(f.alias, op)).rejects.toThrow("unconfirmed");
    expect(controlled.create).toHaveBeenCalledOnce();
    retry.mockResolvedValue(undefined);
    await expect(inspector.check(f.alias, op)).resolves.toMatchObject({ version: "1.0.105" });
    expect(controlled.create).toHaveBeenCalledTimes(2);
    expect(inspector.revision(f.alias)).toBeGreaterThan(before);
  } finally { retry.mockResolvedValue(undefined); await inspector.close(); op.dispose(); }
});

test("Codex model discovery and version/transport inspection serialize through the same canonical owner", async () => {
  const f = await fixture("codex"), op = operation();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  controlled.create.mockResolvedValue({ run: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { stdout: '{"ok":true,"observation":{"model":null,"models":[{"id":"model","efforts":null}]}}' }; }, close: async () => {} });
  const inspector = createWorkerToolInspector({ cwd: f.root, environment: process.env });
  try {
    const model = inspector.discover({ native: { agent: "codex", model: null, args: [] }, cwd: f.root, environment: process.env, mode: "web", toolLaunch: f.launch }, op);
    await started;
    const version = inspector.check(f.alias, op); void version.catch(() => {});
    await Promise.resolve(); expect(controlled.command).not.toHaveBeenCalled();
    release(); await model;
    await expect(version).resolves.toMatchObject({ version: "0.156.1" });
    expect(controlled.command.mock.calls.map(([command]) => command.args.slice(-3))).toEqual([[f.alias.executablePath, "--version"], ["app-server", "--stdio", "--help"]]);
  } finally { release?.(); await inspector.close(); op.dispose(); }
});


test("shutdown retains a failed historical resource after another selected tool succeeds", async () => {
  const first = await fixture("copilot"), next = await fixture("copilot"), op = operation();
  const retry = vi.fn().mockRejectedValue(new Error("old scope remains live"));
  const cleanup = new BotCliProbeCleanupError({ launchId: "historical", pid: 123, process: null, jobObjectName: null, targetStarted: true }, retry);
  controlled.create.mockResolvedValueOnce({ run: async () => ({ stdout: '{"ok":true,"version":"1.0.105"}' }), close: async () => { throw cleanup; } })
    .mockResolvedValue({ run: async () => ({ stdout: '{"ok":true,"version":"1.0.105"}' }), close: async () => {} });
  const inspector = createWorkerToolInspector({ cwd: first.root, environment: process.env });
  try {
    await expect(inspector.check(first.launch, op)).rejects.toMatchObject({ code: "cleanup_unknown" });
    await expect(inspector.check(next.launch, op)).resolves.toMatchObject({ version: "1.0.105" });
    await expect(inspector.close()).rejects.toThrow("cleanup");
    expect(retry).toHaveBeenCalled();
  } finally { retry.mockResolvedValue(undefined); await inspector.close(); op.dispose(); }
});

test("shutdown shares one deadline across historical owners and rejoins an unfinished original cleanup", async () => {
  const first = await fixture("copilot"), next = await fixture("copilot"), op = operation();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const retryFirst = vi.fn(async () => { entered(); await blocked; }), retryNext = vi.fn(async () => {});
  const cleanup = (launchId: string, retry: () => Promise<void>) => new BotCliProbeCleanupError({ launchId, pid: 123, process: null, jobObjectName: null, targetStarted: true }, retry);
  controlled.create.mockResolvedValueOnce({ run: async () => ({ stdout: '{"ok":true,"version":"1.0.105"}' }), close: async () => { throw cleanup("bounded-first", retryFirst); } })
    .mockResolvedValueOnce({ run: async () => ({ stdout: '{"ok":true,"version":"1.0.105"}' }), close: async () => { throw cleanup("bounded-next", retryNext); } });
  const inspector = createWorkerToolInspector({ cwd: first.root, environment: process.env });
  let short: ReturnType<typeof operation> | undefined, later: ReturnType<typeof operation> | undefined;
  try {
    await expect(inspector.check(first.launch, op)).rejects.toMatchObject({ code: "cleanup_unknown" });
    await expect(inspector.check(next.launch, op)).rejects.toMatchObject({ code: "cleanup_unknown" });
    vi.useFakeTimers(); short = createOperation({ limits: { totalMs: 100 } });
    const closing = inspector.close(short), failed = expect(closing).rejects.toThrow("cleanup remains unconfirmed");
    await started; await vi.advanceTimersByTimeAsync(100); await failed;
    expect(retryFirst).toHaveBeenCalledOnce(); expect(retryNext).not.toHaveBeenCalled();
    later = operation(); const recovered = inspector.close(later);
    await Promise.resolve(); expect(retryFirst).toHaveBeenCalledOnce(); expect(retryNext).not.toHaveBeenCalled();
    release(); await recovered;
    expect(retryFirst).toHaveBeenCalledOnce(); expect(retryNext).toHaveBeenCalledOnce();
  } finally { release(); short?.dispose(); later?.dispose(); vi.useRealTimers(); await inspector.close(); op.dispose(); }
});
