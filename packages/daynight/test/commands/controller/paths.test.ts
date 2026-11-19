import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareControllerIpcEndpoint, resolveControllerIpcEndpoint } from "../../../src/commands/controller/paths.js";
import { controllerExecutionDirectory, controllerTicketPath, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("explicit storage survives removal of shared Controller sources and keeps CLI configuration unchanged", async () => {
  const base = path.resolve("../../.tmp/controller-paths"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const configurationRoot = path.join(home, "state"), botRoot = path.join(configurationRoot, "bots", randomUUID());
  vi.stubEnv("DN_CONFIG_DIR", configurationRoot);
  const executionId = randomUUID(), launchId = randomUUID();
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId, executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(),
    sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: executionId, ownerUserId: randomUUID(),
    provider: "codex", cwd: home, nativeHome: path.join(home, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 },
    initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null,
    credentialFile: path.join(controllerExecutionDirectory(home, executionId, botRoot), "credential.json"),
    ipcEndpoint: resolveControllerIpcEndpoint(home, launchId, process.platform, botRoot), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  const file = await writeLaunchTicket(home, ticket, botRoot);
  expect(file).toBe(controllerTicketPath(home, launchId, botRoot));
  await writeLaunchTicket(home, ticket);
  await rm(path.join(configurationRoot, "controller"), { recursive: true });
  expect(await readLaunchTicket(home, launchId, botRoot)).toEqual(ticket);
  await expect(readLaunchTicket(home, launchId)).rejects.toMatchObject({ code: "ENOENT" });
  expect(process.env.DN_CONFIG_DIR).toBe(configurationRoot);
  expect(resolveControllerIpcEndpoint(home, launchId, "win32", botRoot)).not.toBe(resolveControllerIpcEndpoint(home, launchId, "win32"));
  expect(() => controllerExecutionDirectory(home, executionId, "relative")).toThrow(/absolute directory/);
});
test.skipIf(process.platform === "win32")("short default roots retain the existing socket identity", () => {
  vi.stubEnv("DN_CONFIG_DIR", undefined);
  const launch = randomUUID(), hash = createHash("sha256").update(`/home/user:${launch}`).digest("hex").slice(0, 20);
  expect(resolveControllerIpcEndpoint("/home/user", launch, "darwin")).toBe(`/home/user/.daynight/c/${hash}.sock`);
});
test.skipIf(process.platform === "win32")("custom roots have disjoint short Unix sockets and Windows pipe identities", async () => {
  const launch = randomUUID(), home = "/home/user", root = path.join(path.resolve(".tmp"), randomUUID(), "long-state-root".repeat(15));
  vi.stubEnv("DN_CONFIG_DIR", root);
  const first = resolveControllerIpcEndpoint(home, launch, "darwin"), pipe = resolveControllerIpcEndpoint(home, launch, "win32");
  expect(Buffer.byteLength(first)).toBeLessThanOrEqual(103);
  vi.stubEnv("DN_CONFIG_DIR", root + "-other");
  expect(resolveControllerIpcEndpoint(home, launch, "darwin")).not.toBe(first);
  expect(resolveControllerIpcEndpoint(home, launch, "win32")).not.toBe(pipe);
  vi.stubEnv("DN_CONFIG_DIR", root);
  roots.push(path.dirname(first));
  expect(await prepareControllerIpcEndpoint(home, launch)).toBe(first);
  const metadata = await lstat(path.dirname(first));
  expect(metadata.mode & 0o077).toBe(0);
  const server = net.createServer();
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(first, resolve); }); }
  finally { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test.skipIf(process.platform === "win32")("refuses an unsafe or symlink IPC directory instead of changing its permissions", async () => {
  const base = path.resolve("../../.tmp/controller-paths"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "h-")); roots.push(root);
  vi.stubEnv("DN_CONFIG_DIR", path.join(root, "long".repeat(50)));
  const endpoint = resolveControllerIpcEndpoint(root, randomUUID()), directory = path.dirname(endpoint); roots.push(directory);
  await mkdir(directory, { mode: 0o755 }); await chmod(directory, 0o755);
  await expect(prepareControllerIpcEndpoint(root, randomUUID())).rejects.toThrow(/private.*directory/);
  expect((await lstat(directory)).mode & 0o077).toBe(0o055);
  await rm(directory, { recursive: true });
  await symlink(root, directory, "dir");
  await expect(prepareControllerIpcEndpoint(root, randomUUID())).rejects.toThrow(/private.*directory/);
});
