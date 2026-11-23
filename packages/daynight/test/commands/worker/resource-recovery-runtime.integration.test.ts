import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { createOperation } from "../../../src/api/operation.js";
import { runRepositoryGit } from "../../../src/repository/git.js";
import { captureProcessProof, confirmControllerProcessesStopped } from "../../../src/commands/controller/process-proof.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { runCompletedWebResourceRecovery } from "../../../src/commands/worker/resource-recovery-runtime.js";

const roots: string[] = [], servers: Server[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = async () => {
  const base = path.resolve("../../.tmp/resource-recovery-runtime"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "case-")); roots.push(home);
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "config"));
  const paths = resolveWorkerPaths(home); await mkdir(paths.workerDirectory, { recursive: true });
  const owner = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() }, workerId = randomUUID(), userId = randomUUID(), nativeSessionId = randomUUID();
  const requests: string[] = [], now = new Date().toISOString();
  const receipt = { state: "ready", schemaVersion: 3, completeness: "complete", sha256: "a".repeat(64), byteLength: "100", errorCode: null };
  let wrongArchive = false, successor = false;
  const repository = path.join(home, "repository"), repoUrl = "https://example.test/recovery/repository.git";
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json"); response.setHeader("Daynight-User-ID", userId);
    if (request.method !== "GET") { response.statusCode = 405; response.end("{}"); return; }
    const url = request.url!;
    if (url === "/api/v1/me") response.end(JSON.stringify({ id: userId, name: "Fixture", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: randomUUID(), kind: "personal", name: null } }));
    else if (url === `/api/v1/projects/${owner.projectId}`) response.end(JSON.stringify({ id: owner.projectId, name: "Recovery", repoUrl, settings: { version: 1, executionWarningMinutes: 120 }, ownership: { teamId: randomUUID(), version: 1 }, createdAt: now, updatedAt: now }));
    else if (url === `/api/v1/projects/${owner.projectId}/tasks/${owner.taskId}`) response.end(JSON.stringify({ id: owner.taskId, projectId: owner.projectId, type: "task", parentId: null, title: "Recovery fixture", description: "", tags: [], version: 1, status: "done", allowAgents: true, requiredPlatform: null, assignedTo: userId, startedAt: now, completedAt: now, cancelledAt: null, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: now, updatedAt: now, properties: { worker: { claimId: successor ? randomUUID() : owner.claimId, worktreeId: owner.worktreeId, workerId, userId, state: "completed", agent: "codex", agentControlMode: "web", machine: { id: randomUUID(), name: "fixture" }, platform: "macos", phase: "completing", herdr: null, nativeSessionId, claimedAt: now } } }));
    else if (url.endsWith("/archive")) response.end(JSON.stringify({ archive: wrongArchive ? { ...receipt, sha256: "b".repeat(64) } : receipt }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(paths.configFile, stringify({ serverUrl: origin, serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId }));
  await mkdir(repository);
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  let binding;
  try {
    const git = async (args: string[]) => (await runRepositoryGit(repository, args, operation)).stdout.trim();
    await git(["init", "-b", "main"]); await git(["config", "user.name", "Fixture"]); await git(["config", "user.email", "fixture@example.test"]); await git(["remote", "add", "origin", repoUrl]);
    await writeFile(path.join(repository, "preserved.txt"), "original content\n"); await writeFile(path.join(repository, ".gitignore"), ".worktrees/\n");
    await git(["add", "."]); await git(["commit", "-m", "fixture"]); await git(["update-ref", "refs/remotes/origin/main", await git(["rev-parse", "HEAD"])]);
    const worktreePath = path.join(repository, ".worktrees/daynight", owner.worktreeId), branch = `daynight/${owner.taskId}`;
    await git(["worktree", "add", "-b", branch, worktreePath]);
    binding = { repositoryPath: repository, commonDirectory: path.join(repository, ".git"), worktreePath, branch };
    const manifests = createWorktreeManifestStore(binding.commonDirectory); manifests.publish({ ...owner, schemaVersion: 1, directoryName: owner.worktreeId });
    // An interrupted earlier conversion can leave an unrelated manifest and lock.
    const unknown = { projectId: owner.projectId, taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
    const unknownPath = path.join(repository, ".worktrees/daynight", unknown.taskId);
    await git(["worktree", "add", "--lock", "--reason", `daynight-worker:${JSON.stringify(unknown)}`, "-b", `daynight/${unknown.taskId}`, unknownPath]);
    manifests.publish({ ...unknown, schemaVersion: 1, directoryName: unknown.taskId });
    await writeFile(path.join(binding.commonDirectory, "daynight/worktrees/format.json"), '{"version":1}\n');
  } finally { operation.dispose(); }
  const project = { projectId: owner.projectId, localPath: repository, repoUrl };
  const worker = openWorkerStore(paths.databaseFile); worker.registerProject(project); expect(worker.listTasks()).toEqual([]); worker.close();
  const web = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite"));
  let record = web.register({ ...owner, project, workerId, userId, serverOrigin: origin, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 1 } }, Date.now());
  record = web.bindWorktree(record, binding, Date.now()); record = web.initializeWebExecution(record, Date.now());
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] }); children.push(child); await once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
  const proof = await captureProcessProof(child.pid!);
  expect(proof.processGroupId).toBe(proof.pid);
  const execution = record.webExecution!, sessionId = randomUUID();
  record = web.updateWebExecution(record, { sessionId, initialPrompt: "fixture", launchSubmission: "acknowledged", controllerProcess: proof }, Date.now());
  record = web.bindNativeSession(record, { source: "controller", sessionId: nativeSessionId }, Date.now());
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, ...owner, workerId, userId, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId, executionGeneration: execution.executionGeneration, serverOrigin: origin, provider: "codex", cwd: binding.worktreePath, nativeHome: path.join(home, "native"), configuration: record.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "fixture", resumeNativeSessionId: nativeSessionId, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: now };
  record = web.updateWebExecution(record, { ticketPath: await writeLaunchTicket(home, ticket) }, Date.now());
  const journalDirectory = controllerExecutionDirectory(home, execution.executionId); await mkdir(journalDirectory, { recursive: true });
  const journalPath = path.join(journalDirectory, "journal.sqlite");
  const controller = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true, controllerProcess: proof });
  const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
  expect(await confirmControllerProcessesStopped(proof, [], Date.now() + 5000)).toBe(true);
  controller.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, stoppedAt: now, nativeSessionId, activity: "stopped" }); controller.close();
  await writeFile(`${journalPath}.archive-receipt-${execution.executionGeneration}.json`, JSON.stringify(receipt));
  const cleanupStartedAt = Date.now();
  record = web.beginCleanup(record, { kind: "terminal", deadline: cleanupStartedAt }, cleanupStartedAt); web.completeTask(record, Date.now()); web.close();
  return { home, owner, paths, binding, requests, rejectArchive: () => { wrongArchive = true; }, supersede: () => { successor = true; } };
};

// This fixture records a real POSIX group birth and confirms the whole group is
// empty. Windows Job proof has its own process tests and is not simulated by a
// fabricated stopped PID here.
describe.runIf(process.platform !== "win32")("completed Web resource recovery runtime", () => {
  it("verifies original SQLite, process, ticket, archive and Git evidence before confirmed removal", { timeout: 45_000 }, async () => {
    const f = await fixture(), output: string[] = [];
    const run = (confirmed: boolean) => runCompletedWebResourceRecovery({ homeDirectory: f.home, request: { ...f.owner, confirmed }, output: value => output.push(value), signal: AbortSignal.timeout(30_000) });
    await writeFile(path.join(f.paths.workerDirectory, "herdr-executions.sqlite"), "unreadable legacy journal");
    await run(false);
    expect(JSON.parse(output.at(-1)!).outcome).toBe("verified");
    expect(await readFile(path.join(f.binding.worktreePath, "preserved.txt"), "utf8")).toBe("original content\n");
    await run(true);
    expect(JSON.parse(output.at(-1)!).outcome).toBe("recovered");
    await expect(readFile(path.join(f.binding.worktreePath, "preserved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(createWorktreeManifestStore(f.binding.commonDirectory).lookupOwner(f.owner).byClaim).toBeNull();
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite")); expect(web.getTask(f.owner)?.status).toBe("done"); web.close();
    expect(f.requests.every(value => value.startsWith("GET "))).toBe(true);
  });
  it("refuses recovery when the target worktree is quarantined", { timeout: 45_000 }, async () => {
    const f = await fixture();
    const operation = createOperation({ limits: { totalMs: 10_000 } });
    try { await runRepositoryGit(f.binding.repositoryPath, ["worktree", "lock", "--reason", "foreign lock", f.binding.worktreePath], operation); }
    finally { operation.dispose(); }
    await expect(runCompletedWebResourceRecovery({ homeDirectory: f.home, request: { ...f.owner, confirmed: true }, output: () => {}, signal: AbortSignal.timeout(30_000) })).rejects.toThrow(/enumeration|conflicting/);
    expect(await readFile(path.join(f.binding.worktreePath, "preserved.txt"), "utf8")).toBe("original content\n");
    expect(createWorktreeManifestStore(f.binding.commonDirectory).lookupOwner(f.owner).byClaim?.worktreeId).toBe(f.owner.worktreeId);
  });
  it.each(["archive", "successor"])("preserves the checkout and manifest when original %s evidence conflicts", { timeout: 45_000 }, async kind => {
    const f = await fixture(); if (kind === "archive") f.rejectArchive(); else f.supersede();
    await expect(runCompletedWebResourceRecovery({ homeDirectory: f.home, request: { ...f.owner, confirmed: true }, output: () => {}, signal: AbortSignal.timeout(30_000) })).rejects.toThrow(/archive|claim/);
    expect(await readFile(path.join(f.binding.worktreePath, "preserved.txt"), "utf8")).toBe("original content\n");
    expect(createWorktreeManifestStore(f.binding.commonDirectory).lookupOwner(f.owner).byClaim?.worktreeId).toBe(f.owner.worktreeId);
  });
});
