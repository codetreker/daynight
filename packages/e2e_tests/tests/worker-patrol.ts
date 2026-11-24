import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { aggregateFailures } from "../src/failures.ts";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ManagedCommand } from "../src/command.ts";
import { markFixtureStopped, prepareFixtureOwnership, registerFixtureBot, registerFixtureClaim, registerFixtureIdentity, startOwnedFixture } from "../src/fixture-owner.ts";
import { prepareWorkerFixtureConfiguration } from "../src/worker-config.ts";
import { completeFixtureTask, type WorkerCompletionTask } from "../src/worker-completion.ts";
import { stopAndRecordFixtureWorker, type FixtureExecutionIdentity } from "../src/worker-cleanup.ts";
import { cli, cliEnvironment, expect, runOwnedCommand, topology } from "./fixtures.ts";
import { verifyAssistantInbox, type PeerEvent } from "./assistant-inbox.ts";

type Task = WorkerCompletionTask & { session?: { lifecycle?: string } };
// POSIX single quotes keep every byte literal; an embedded quote closes, escapes and reopens the literal.
const shellLiteral = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// The native peer is controlled; Worker, Controller, Server, relay and PostgreSQL are real.
export const verifyWorkerPatrol = async (server: { serverUrl: string; serverToken: string }): Promise<void> => {
  const checkout = path.resolve(import.meta.dirname, "../../.."), runDirectory = process.env.DAYNIGHT_E2E_RUN_DIRECTORY;
  if (runDirectory === undefined) throw new Error("Fixture requires its original E2E run.");
  const root = await prepareFixtureOwnership(checkout, runDirectory);
  const repository = path.join(root, "repository"), bare = path.join(root, "remote.git"), peer = path.join(root, "codex.mjs"), log = path.join(root, "peer.jsonl"), launcher = path.join(root, "daynight");
  const git = async (cwd: string, args: string[]) => runOwnedCommand("git", args, { cwd, env: cliEnvironment, timeoutMs: 30_000 });
  let worker: ManagedCommand | undefined, exited = false, launchNumber = 0;
  let scenarioFailure: unknown;
  let workerConfigDirectory: string | undefined, identity: FixtureExecutionIdentity | undefined;
  const workerId = randomUUID();
  const stop = async (): Promise<void> => {
    if (!worker) return;
    const original = worker; worker = undefined;
    await stopAndRecordFixtureWorker({ worker: original, exited, runDirectory, workerId, launchNumber });
    await markFixtureStopped(checkout, runDirectory);
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
    await writeFile(launcher, `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(topology.cliEntry)} "$@"\n`, { mode: 0o700 });
    const projectCreation = await cli(["project", "create", `Worker patrol ${randomUUID()}`, "--repo", remote, "--team", "personal", "--confirm"]);
    const projectId = projectCreation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (!projectId) throw new Error("Worker test Project creation did not return an ID.");
    const creation = await cli(["task", "create", "--project", projectId, "--title", "Worker patrol product flow", "--description", "Exercise the original managed execution.", "--status", "todo"]);
    const taskId = creation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (!taskId) throw new Error("Worker test Task creation did not return an ID.");
    const readTask = async (): Promise<Task> => JSON.parse((await cli(["task", "show", taskId, "--project", projectId, "--json"])).stdout) as Task;
    const task = await readTask();
    if (task.assignedTo === null) throw new Error("Fixture Task has no assigned user.");
    await cli(["task", "update", taskId, "--project", projectId, "--allow-agents", "true", "--if-version", String(task.version)]);
    workerConfigDirectory = await prepareWorkerFixtureConfiguration(root, { ...server, workerId, repositoryRoot: path.join(root, "repositories"),
      peer, projectId, remote, repository, cli: launcher });
    identity = { projectId, taskId, workerId, userId: task.assignedTo, serverOrigin: server.serverUrl, repository };
    await registerFixtureIdentity(checkout, runDirectory, identity);
    const entries = async (): Promise<PeerEvent[]> => {
      try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as PeerEvent); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
    };
    const start = async () => {
      exited = false; launchNumber++;
      worker = await startOwnedFixture({ repository: checkout, runDirectory, command: process.execPath, args: [topology.cliEntry, "worker", "run"], options: { cwd: root,
        env: { ...cliEnvironment, DN_CONFIG_DIR: workerConfigDirectory, ...(process.env.DAYNIGHT_E2E_WORKER_GIT_DIR ? { PATH: `${process.env.DAYNIGHT_E2E_WORKER_GIT_DIR}${path.delimiter}${process.env.PATH}` } : {}), CODEX_HOME: path.join(root, "native"), DAYNIGHT_WORKER_PEER_LOG: log }, timeoutMs: 420_000,
        onOutput: () => {} } });
      void worker.finished.then(() => { exited = true; }, () => { exited = true; });
    };
    const events = async () => {
      if (exited) {
        let failure: unknown;
        try { await worker!.finished; } catch (error) { failure = error; }
        throw new Error(`Worker exited unexpectedly: ${inspect({ diagnostics: worker!.diagnostics(), failure }, { depth: 8, maxStringLength: 1024 * 1024 })}`, { cause: failure });
      }
      return entries();
    };
    await start();
    await expect.poll(async () => (await events()).filter(event => event.method === "turn/start").length, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThanOrEqual(2);
    const firstTurns = (await entries()).filter(event => event.method === "turn/start");
    expect(firstTurns[0]!.text).toContain("Assignment:");
    expect(firstTurns[1]!.text).toContain("periodic check");
    await expect.poll(async () => (await readTask()).properties.worker?.nativeSessionId, { timeout: 30_000, intervals: [1_000] }).toEqual(expect.any(String));
    const first = await readTask(), workerClaim = first.properties.worker;
    expect(first.status).toBe("in_progress"); expect(workerClaim).toMatchObject({ state: "active", workerId, userId: task.assignedTo, platform: "linux", agent: "codex", agentControlMode: "web", nativeSessionId: expect.any(String) });
    const original = { claimId: workerClaim!.claimId, workerId: workerClaim!.workerId, worktreeId: workerClaim!.worktreeId, nativeSessionId: workerClaim!.nativeSessionId, state: "active", platform: workerClaim!.platform, agent: workerClaim!.agent, agentControlMode: workerClaim!.agentControlMode };
    identity.claimId = original.claimId;
    await registerFixtureClaim(checkout, runDirectory, original.claimId);
    await stop();
    const stopped = await readTask(); expect(stopped.properties.worker).toMatchObject(original);
    await start();
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
    await completeFixtureTask({ projectId, taskId, userId: task.assignedTo, original, read: readTask,
      complete: version => cli(["task", "set-status", taskId, "done", "--project", projectId, "--claim-id", original.claimId, "--if-version", String(version)]) });
    const completed = await readTask(); expect(completed).toMatchObject({ status: "done", properties: { worker: { claimId: original!.claimId, state: "completed" } } });
    // Already submitted inputs may settle after completion; compare subsequent patrols after that window.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const completedPings = (await entries()).filter(event => event.method === "turn/start" && event.text?.includes("periodic check")).length;
    await expect.poll(async () => (await readTask()).session?.lifecycle, { timeout: 90_000, intervals: [1_000] }).toBe("archived");
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect((await entries()).filter(event => event.method === "turn/start" && event.text?.includes("periodic check")).length).toBe(completedPings);
    // The completed Task released the Worker's only execution slot for a hosted Bot.
    await verifyAssistantInbox({ workerId, root, events, registerBot: async botId => {
      identity!.botId = botId; await registerFixtureBot(checkout, runDirectory, botId);
    } });
  } catch (error) { scenarioFailure = error; }
  finally {
    const failures: unknown[] = [];
    try { await stop(); } catch (error) { failures.push(error); }
    if (scenarioFailure !== undefined) failures.unshift(scenarioFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw aggregateFailures("Fixture execution or cleanup failed.", failures);
  }
};
