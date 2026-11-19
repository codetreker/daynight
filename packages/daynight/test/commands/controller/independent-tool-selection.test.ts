import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("../../../src/platform/tool-executables.js", async original => {
  const actual = await original<typeof import("../../../src/platform/tool-executables.js")>();
  return { ...actual, resolveToolLaunch: vi.fn(actual.resolveToolLaunch), verifyToolLaunch: vi.fn(actual.verifyToolLaunch) };
});
import { selectIndependentToolLaunch } from "../../../src/commands/controller/independent-tool-selection.js";
import { controllerExecutionDirectory, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { readLaunchToolSelection, writeLaunchToolSelection } from "../../../src/commands/controller/launch-tool-selection.js";
import { resolveToolLaunch, verifyToolLaunch, type ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";
import { createOperation } from "../../../src/api/operation.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { removeFixtureRoot } from "../../helpers/tool-fixture-cleanup.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await removeFixtureRoot(root); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/independent-tool-selection"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "case-")); roots.push(home);
  const bin = path.join(home, "bin"); await mkdir(bin);
  const entry = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  // These bytes exercise real launcher classification and digest I/O, never a native process.
  const bytes = Buffer.from(process.platform === "win32" ? "MZ-original-tool-fixture" : "\x7fELF-original-tool-fixture");
  await writeFile(entry, bytes); await chmod(entry, 0o755);
  const input = { provider: "codex" as const, homeDirectory: home, cwd: home, environment: { PATH: bin, PATHEXT: ".EXE" }, signal: new AbortController().signal };
  return { home, entry, bytes, input };
};
const ticketFor = (home: string, launch?: ResolvedToolLaunch): ControllerLaunchTicket => ({
  schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", testExecutionId: randomUUID(), ownerUserId: randomUUID(), initialInput: "none", serverOrigin: "https://daynight.example", provider: "codex", cwd: home, nativeHome: home,
  configuration: { agent: "codex", agentControlMode: "web", model: "original-model", args: ["--sandbox", "read-only"], recoveryLimit: 0, ...(launch ? { toolLaunch: launch } : {}) },
  initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(home, "credential.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
});

test("freezes the actual Codex PATH artifact without starting a process", async () => {
  const f = await fixture(), launch = await selectIndependentToolLaunch(f.input);
  expect(launch).toMatchObject({ tool: "codex", context: "web", source: "path", executablePath: await realpath(f.entry), interpreterPath: null });
  expect(launch!.artifacts).toContainEqual(expect.objectContaining({ role: "entry", sha256: createHash("sha256").update(f.bytes).digest("hex"), size: String(f.bytes.length) }));
  expect(launch!.command).toEqual({ file: await realpath(f.entry), prefixArgs: [] });
});

test.each(["inline", "sidecar"] as const)("resume retains the original %s recipe and rejects changed bytes without reselecting", async kind => {
  const f = await fixture(), launch = (await selectIndependentToolLaunch(f.input))!;
  const ticket = ticketFor(f.home, kind === "inline" ? launch : undefined), file = await writeLaunchTicket(f.home, ticket), original = await readFile(file);
  if (kind === "sidecar") {
    await mkdir(controllerExecutionDirectory(f.home, ticket.executionId), { recursive: true, mode: 0o700 });
    await writeLaunchToolSelection(f.home, ticket, launch, () => {});
  }
  vi.mocked(resolveToolLaunch).mockClear();
  const input = { ...f.input, environment: { PATH: "missing" }, resumeTicket: ticket };
  expect(await selectIndependentToolLaunch(input)).toEqual(launch);
  expect(resolveToolLaunch).not.toHaveBeenCalled();
  await writeFile(f.entry, Buffer.concat([f.bytes, Buffer.from("replacement")]));
  await expect(selectIndependentToolLaunch(input)).rejects.toMatchObject({ code: "tool_identity_changed" });
  expect(resolveToolLaunch).not.toHaveBeenCalled();
  expect(await readFile(file)).toEqual(original);
  expect(await readLaunchTicket(f.home, ticket.launchId)).toEqual(ticket);
});

test("legacy resume resolves for the new execution without changing its original ticket or adding a sidecar", async () => {
  const f = await fixture(), ticket = ticketFor(f.home), file = await writeLaunchTicket(f.home, ticket), original = await readFile(file);
  const launch = await selectIndependentToolLaunch({ ...f.input, resumeTicket: ticket });
  expect(launch!.executablePath).toBe(await realpath(f.entry));
  expect(await readFile(file)).toEqual(original);
  expect(await readLaunchToolSelection(f.home, ticket)).toBeUndefined();
});

test("a malformed saved selection is refused rather than treated as an unbound legacy ticket", async () => {
  const f = await fixture(), ticket = ticketFor(f.home), dir = path.join(controllerExecutionDirectory(f.home, ticket.executionId), "tool-selections");
  await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(path.join(dir, `${ticket.launchId}.json`), "{}", { mode: 0o600 });
  vi.mocked(resolveToolLaunch).mockClear();
  await expect(selectIndependentToolLaunch({ ...f.input, resumeTicket: ticket })).rejects.toThrow("binding differs");
  expect(resolveToolLaunch).not.toHaveBeenCalled();
});

test("missing executable fails and cancellation never returns a late resolved recipe", async () => {
  const f = await fixture();
  await expect(selectIndependentToolLaunch({ ...f.input, environment: { PATH: path.join(f.home, "missing"), PATHEXT: ".EXE" } })).rejects.toMatchObject({ code: "not_found" });
  const launch = (await selectIndependentToolLaunch(f.input))!, controller = new AbortController();
  vi.mocked(resolveToolLaunch).mockImplementationOnce(async () => { controller.abort(); return launch; });
  await expect(selectIndependentToolLaunch({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ kind: "cancelled" });
  vi.mocked(resolveToolLaunch).mockClear();
  await expect(selectIndependentToolLaunch({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ kind: "cancelled" });
  expect(resolveToolLaunch).not.toHaveBeenCalled();
});

test("the selection operation has a deadline and is disposed after failure", async () => {
  const f = await fixture(); let scope: Parameters<typeof resolveToolLaunch>[1] | undefined;
  vi.mocked(resolveToolLaunch).mockImplementationOnce(async (_input, operation) => { scope = operation; throw new Error("fixture failure"); });
  await expect(selectIndependentToolLaunch(f.input)).rejects.toThrow("fixture failure");
  expect(scope!.limits.totalMs).toBe(30_000); expect(scope!.signal.aborted).toBe(true);
});

test("Claude and non-Windows Copilot preserve their existing launch paths", async () => {
  const f = await fixture(); vi.mocked(resolveToolLaunch).mockClear();
  expect(await selectIndependentToolLaunch({ ...f.input, provider: "claude" })).toBeUndefined();
  const otherPlatform = Object.create(process); Object.defineProperty(otherPlatform, "platform", { value: "linux" }); vi.stubGlobal("process", otherPlatform);
  expect(await selectIndependentToolLaunch({ ...f.input, provider: "copilot" })).toBeUndefined();
  expect(resolveToolLaunch).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== "win32")("Windows Copilot freezes its real bundled direct executable", async () => {
  const f = await fixture();
  const launch = await selectIndependentToolLaunch({ ...f.input, provider: "copilot" });
  expect(launch).toMatchObject({ tool: "copilot", source: "bundled", interpreterPath: null });
  expect(launch!.runtimeProfile).toBeUndefined(); expect(launch!.executablePath).toMatch(/\.exe$/i);
  expect(launch!.command).toEqual({ file: launch!.executablePath, prefixArgs: [] });
  const operation = createOperation();
  try { await verifyToolLaunch(launch!, operation); } finally { operation.dispose(); }
});

test("non-Windows resume verifies its saved Copilot binding before considering the legacy authority path", async () => {
  const f = await fixture(), operation = createOperation();
  const launch = await resolveToolLaunch({ tool: "copilot", context: "web", choice: { kind: "path", path: f.entry }, cwd: f.home, environment: f.input.environment }, operation).finally(() => operation.dispose());
  const original = ticketFor(f.home), ticket: ControllerLaunchTicket = { ...original, provider: "copilot", configuration: { ...original.configuration, agent: "copilot", toolLaunch: launch } };
  const otherPlatform = Object.create(process); Object.defineProperty(otherPlatform, "platform", { value: "linux" }); vi.stubGlobal("process", otherPlatform);
  vi.mocked(resolveToolLaunch).mockClear(); vi.mocked(verifyToolLaunch).mockClear();
  expect(await selectIndependentToolLaunch({ ...f.input, provider: "copilot", resumeTicket: ticket })).toEqual(launch);
  expect(resolveToolLaunch).not.toHaveBeenCalled();
  expect(verifyToolLaunch).toHaveBeenCalledWith(launch, expect.any(Object), { trustedRuntimeRoot: path.join(resolveConfigurationPaths(f.home).stateDirectory, "worker", "tool-runtimes") });
});

test.skipIf(process.platform !== "win32")("a Copilot recipe requiring an interpreter keeps the authority path", async () => {
  const f = await fixture(), launch = (await selectIndependentToolLaunch(f.input))!;
  vi.mocked(resolveToolLaunch).mockResolvedValueOnce({ ...launch, tool: "copilot", interpreterPath: process.execPath });
  expect(await selectIndependentToolLaunch({ ...f.input, provider: "copilot" })).toBeUndefined();
});
