import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand, startCommand, type ManagedCommand } from "../src/command.ts";
import { workerFixtureConfiguration } from "../src/worker-config.ts";
import { cli, cliEnvironment, expect, topology } from "./fixtures.ts";

type Task = { id: string; version: number; status: string; session?: { lifecycle?: string }; properties: { paused?: boolean; worker?: { claimId: string; workerId: string; worktreeId: string; nativeSessionId: string | null; state: string } } };
type PeerEvent = { method: string; threadId: string; text?: string };

// The native peer is controlled; Worker, Controller, Server, relay and PostgreSQL are real.
export const verifyWorkerPatrol = async (server: { serverUrl: string; serverToken: string }): Promise<void> => {
  const root = path.join(path.dirname(topology.cliConfigDirectory), `worker-patrol-${randomUUID()}`);
  const repository = path.join(root, "repository"), bare = path.join(root, "remote.git"), peer = path.join(root, "codex.mjs"), log = path.join(root, "peer.jsonl");
  await mkdir(root, { recursive: true });
  const git = async (cwd: string, args: string[]) => runCommand("git", args, { cwd, env: cliEnvironment, timeoutMs: 30_000 });
  let worker: ManagedCommand | undefined, exited = false, output = "";
  const config = path.join(topology.cliConfigDirectory, "config.yml");
  const originalConfig = await readFile(config, "utf8");
  const stop = async (): Promise<void> => {
    if (!worker) return;
    if (!exited) { process.kill(worker.pid, "SIGINT"); await worker.finished; }
    await worker.stop(); worker = undefined;
  };
  try {
    await git(root, ["init", "--bare", bare]);
    await git(root, ["init", "-b", "main", repository]);
    await git(repository, ["config", "user.name", "Product E2E"]);
    await git(repository, ["config", "user.email", "product-e2e@example.test"]);
    await writeFile(path.join(repository, "README.md"), "isolated product test\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initialize fixture"]);
    const remote = `https://example.test/worker/${randomUUID()}.git`;
    await git(repository, ["remote", "add", "origin", remote]);
    await git(repository, ["config", `url.file://${bare}.insteadOf`, remote]);
    await git(repository, ["push", "origin", "HEAD:main"]);
    await git(root, ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await copyFile(path.join(import.meta.dirname, "native-worker-peer.mjs"), peer); await chmod(peer, 0o700);
    const projectCreation = await cli(["project", "create", `Worker patrol ${randomUUID()}`, "--repo", remote, "--team", "personal", "--confirm"]);
    const projectId = projectCreation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (!projectId) throw new Error("Worker test Project creation did not return an ID.");
    const creation = await cli(["task", "create", "--project", projectId, "--title", "Worker patrol product flow", "--description", "Exercise the original managed execution.", "--status", "todo"]);
    const taskId = creation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (!taskId) throw new Error("Worker test Task creation did not return an ID.");
    const readTask = async (): Promise<Task> => JSON.parse((await cli(["task", "show", taskId, "--project", projectId, "--json"])).stdout) as Task;
    const task = await readTask();
    await cli(["task", "update", taskId, "--project", projectId, "--allow-agents", "true", "--if-version", String(task.version)]);
    await writeFile(config, workerFixtureConfiguration({ ...server, workerId: randomUUID(), repositoryRoot: path.join(root, "repositories"),
      peer, projectId, remote, repository }), { mode: 0o600 });
    const entries = async (): Promise<PeerEvent[]> => {
      try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as PeerEvent); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
    };
    const start = () => {
      exited = false;
      worker = startCommand(process.execPath, [topology.cliEntry, "worker", "run"], { cwd: root,
        env: { ...cliEnvironment, ...(process.env.DAYNIGHT_E2E_WORKER_GIT_DIR ? { PATH: `${process.env.DAYNIGHT_E2E_WORKER_GIT_DIR}${path.delimiter}${process.env.PATH}` } : {}), CODEX_HOME: path.join(root, "native"), DAYNIGHT_WORKER_PEER_LOG: log }, timeoutMs: 180_000,
        onOutput: (_channel, chunk) => { output += chunk; } });
      void worker.finished.then(() => { exited = true; }, () => { exited = true; });
    };
    const events = async () => { if (exited) throw new Error(`Worker exited unexpectedly:\n${output}`); return entries(); };
    start();
    await expect.poll(async () => (await events()).filter(event => event.method === "turn/start").length, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThanOrEqual(2);
    const firstTurns = (await entries()).filter(event => event.method === "turn/start");
    expect(firstTurns[0]!.text).toContain("Assignment:");
    expect(firstTurns[1]!.text).toContain("periodic check");
    await expect.poll(async () => (await readTask()).properties.worker?.nativeSessionId, { timeout: 30_000, intervals: [1_000] }).toEqual(expect.any(String));
    const first = await readTask(), workerClaim = first.properties.worker;
    expect(first.status).toBe("in_progress"); expect(workerClaim).toMatchObject({ state: "active", nativeSessionId: expect.any(String) });
    const original = { claimId: workerClaim!.claimId, workerId: workerClaim!.workerId, worktreeId: workerClaim!.worktreeId, nativeSessionId: workerClaim!.nativeSessionId, state: "active" };
    await stop();
    const stopped = await readTask(); expect(stopped.properties.worker).toMatchObject(original);
    start();
    await expect.poll(async () => (await events()).filter(event => event.method === "thread/resume").length, { timeout: 90_000, intervals: [1_000] }).toBe(1);
    await expect.poll(async () => {
      const current = await events(), index = current.findIndex(event => event.method === "thread/resume");
      return index < 0 ? 0 : current.slice(index + 1).filter(event => event.method === "turn/start").length;
    }, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThanOrEqual(4);
    const afterRestart = await entries(), resume = afterRestart.findIndex(event => event.method === "thread/resume");
    expect(afterRestart[resume]!.threadId).toBe(original!.nativeSessionId);
    const turns = afterRestart.slice(resume + 1).filter(event => event.method === "turn/start");
    expect(turns[0]!.text).toContain("Assignment:");
    for (const turn of turns.slice(1, 4)) expect(turn.text).toContain("periodic check");
    const resumed = await readTask(); expect(resumed.properties.worker).toMatchObject(original!);
    await cli(["task", "set-property", taskId, "paused", "true", "--project", projectId, "--if-version", String(resumed.version)]);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const pausedCount = (await entries()).filter(event => event.method === "turn/start").length;
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect((await entries()).filter(event => event.method === "turn/start").length).toBe(pausedCount);
    const paused = await readTask(); expect(paused.properties.paused).toBe(true);
    await cli(["task", "set-property", taskId, "paused", "false", "--project", projectId, "--if-version", String(paused.version)]);
    await expect.poll(async () => (await events()).filter(event => event.method === "turn/start").length, { timeout: 30_000, intervals: [1_000] }).toBeGreaterThan(pausedCount);
    const active = await readTask();
    await cli(["task", "set-status", taskId, "done", "--project", projectId, "--claim-id", original!.claimId, "--if-version", String(active.version)]);
    const completed = await readTask(); expect(completed).toMatchObject({ status: "done", properties: { worker: { claimId: original!.claimId, state: "completed" } } });
    // Already submitted inputs may settle after completion; compare subsequent patrols after that window.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const completedPings = (await entries()).filter(event => event.method === "turn/start" && event.text?.includes("periodic check")).length;
    await expect.poll(async () => (await readTask()).session?.lifecycle, { timeout: 90_000, intervals: [1_000] }).toBe("archived");
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect((await entries()).filter(event => event.method === "turn/start" && event.text?.includes("periodic check")).length).toBe(completedPings);
  } finally {
    try { await stop(); }
    finally { await writeFile(config, originalConfig, { mode: 0o600 }); await rm(root, { recursive: true, force: true }); }
  }
};
