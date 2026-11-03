import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { resolveControllerIpcEndpoint } from "../../../src/commands/controller/paths.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (process.platform !== "win32") await rm(path.dirname(resolveControllerIpcEndpoint(root, randomUUID())), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
it.each([true, false])("freezes the Copilot profile in the launch ticket and durable execution (explicit=%s)", async explicit => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "cp-")); roots.push(home);
  vi.stubEnv("DN_CONFIG_DIR", explicit ? path.join(home, "dev-state") : undefined);
  vi.stubEnv("COPILOT_HOME", explicit ? path.join(home, "native") : undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "other-provider"));
  const store = openWebExecutionStore(path.join(home, "worker.sqlite"));
  try {
    const project = { serverOrigin: "https://daynight.example", projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: home };

    const claim = { ...project, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID() };
    store.register({ ...claim, project, configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: randomUUID() }, 1);
    store.bindWorktree(claim, { repositoryPath: home, commonDirectory: path.join(home, ".git"), worktreePath: home, branch: "task" }, 3);
    const task = store.initializeWebExecution(claim, 4);
    const sessionApi = { register: vi.fn(async () => ({ sessionId: randomUUID() })), grant: vi.fn(async () => ({})), verifySupport: vi.fn() } as unknown as WorkerSessionApi;
    const launcher = createWebControllerLauncher({ homeDirectory: home, packageDirectory: home, store, sessionApi, now: () => 5 });
    const ticket = await launcher.prepare(task, "managed task", new AbortController().signal);
    const expected = path.join(home, explicit ? "native" : ".copilot");
    expect(ticket.credentialFile).toContain(path.join(home, explicit ? "dev-state" : ".daynight", "controller"));
    expect(ticket.provider).toBe("copilot"); expect(ticket.nativeHome).toBe(expected);
    expect(store.getTask(claim)?.webExecution?.nativeHome).toBe(expected);
    vi.stubEnv("COPILOT_HOME", path.join(home, "changed"));
    const repeated = await launcher.prepare(store.getTask(claim)!, "managed task", new AbortController().signal);
    expect(repeated).toEqual(ticket); expect(sessionApi.register).toHaveBeenCalledOnce(); expect(sessionApi.grant).toHaveBeenCalledOnce();
  } finally { store.close(); }
});

it("renews before two default polling cycles and serializes concurrent credential refresh", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "gr-")); roots.push(home);
  const store = openWebExecutionStore(path.join(home, "worker.sqlite")), now = Date.now();
  try {
    const project = { projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: home };
    const identity = { projectId: project.projectId, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), serverOrigin: "https://daynight.example" };
    store.register({ ...identity, project, configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: randomUUID() }, now);
    store.bindWorktree(identity, { repositoryPath: home, commonDirectory: path.join(home, ".git"), worktreePath: home, branch: "task" }, now);
    const task = store.initializeWebExecution(identity, now);
    const grant = vi.fn().mockResolvedValueOnce({ token: "initial", expiresAt: new Date(now + 90_000).toISOString() }).mockResolvedValue({ token: "renewed", expiresAt: new Date(now + 900_000).toISOString() });
    const sessionApi = { register: vi.fn(async () => ({ sessionId: randomUUID() })), grant, verifySupport: vi.fn(), verifyUnregistered: vi.fn() } as unknown as WorkerSessionApi;
    const launcher = createWebControllerLauncher({ homeDirectory: home, packageDirectory: home, store, sessionApi, now: () => now });
    const ticket = await launcher.prepare(task, "managed task", new AbortController().signal);
    const active = store.updateWebExecution(task, { launchSubmission: "acknowledged" }, now);
    await Promise.all([launcher.refreshGrant(active, ticket, new AbortController().signal), launcher.refreshGrant(active, ticket, new AbortController().signal)]);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(ticket.credentialFile, "utf8"))).toEqual({ token: "renewed", expiresAt: new Date(now + 900_000).toISOString() });
  } finally { store.close(); }
});
