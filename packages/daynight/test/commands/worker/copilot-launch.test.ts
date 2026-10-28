import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each([true, false])("freezes the Copilot profile in the launch ticket and durable execution (explicit=%s)", async explicit => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "cp-")); roots.push(home);
  vi.stubEnv("COPILOT_HOME", explicit ? path.join(home, "native") : undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "other-provider"));
  const store = openWorkerStore(path.join(home, "worker.sqlite"));
  try {
    const project = { serverOrigin: "https://daynight.example", projectId: randomUUID(), repoUrl: "https://example.test/repo.git", localPath: home };
    store.registerProject(project);
    const claim = { ...project, taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID() };
    store.registerPending(claim, { kind: "new", configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1, randomUUID());
    store.activateTask(claim, 2);
    store.bindWorktree(claim, { repositoryPath: home, commonDirectory: path.join(home, ".git"), worktreePath: home, branch: "task" }, 3);
    const task = store.initializeWebExecution(claim, 4);
    const sessionApi = { register: vi.fn(async () => ({ sessionId: randomUUID() })), grant: vi.fn(async () => ({})), verifySupport: vi.fn() } as unknown as WorkerSessionApi;
    const launcher = createWebControllerLauncher({ homeDirectory: home, packageDirectory: home, store, sessionApi, now: () => 5 });
    const ticket = await launcher.prepare(task, "managed task", new AbortController().signal);
    const expected = path.join(home, explicit ? "native" : ".copilot");
    expect(ticket.provider).toBe("copilot"); expect(ticket.nativeHome).toBe(expected);
    expect(store.getTask(claim)?.webExecution?.nativeHome).toBe(expected);
    vi.stubEnv("COPILOT_HOME", path.join(home, "changed"));
    const repeated = await launcher.prepare(store.getTask(claim)!, "managed task", new AbortController().signal);
    expect(repeated).toEqual(ticket); expect(sessionApi.register).toHaveBeenCalledOnce(); expect(sessionApi.grant).toHaveBeenCalledOnce();
  } finally { store.close(); }
});
