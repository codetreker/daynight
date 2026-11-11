import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { controllerExecutionDirectory, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { botToolActivity, readWebToolActivity } from "../../../src/commands/worker/tool-activity.js";
import type { BotRecord } from "../../../src/commands/worker/bots/types.js";
import type { BotExecution } from "../../../src/commands/worker/bots/execution-store.js";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";

const { fixture } = createWebBackendFixtures("file");

it("keeps stopped activity unconfirmed until the matching durable controller stop is complete", async () => {
  const f = await fixture();
  let task = f.store.initializeWebExecution(f.identity, 2);
  const proof = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "fixture", commandHash: "a".repeat(64) };
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), launchSubmission: "acknowledged", controllerProcess: proof, activity: "stopped" }, 3);
  const execution = task.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId,
    controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: "1", serverOrigin: task.serverOrigin,
    projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: "codex", cwd: f.home,
    nativeHome: path.join(f.home, ".codex"), configuration: task.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "fixture", resumeNativeSessionId: null,
    credentialFile: path.join(f.home, "credential.json"), ipcEndpoint: path.join(f.home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  expect(readWebToolActivity(f.home, task)).toBe("unconfirmed");
  await mkdir(controllerExecutionDirectory(f.home, execution.executionId), { recursive: true });
  const journal = openControllerLifecycleStore(path.join(controllerExecutionDirectory(f.home, execution.executionId), "journal.sqlite"), ticket, { onMigration: () => {} });
  try {
    journal.patchSnapshot({ controllerProcess: proof, activity: "stopped", lifecycle: "stopping" });
    expect(readWebToolActivity(f.home, task)).toBe("unconfirmed");
    journal.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() });
    expect(readWebToolActivity(f.home, task)).toBe("inactive");
    expect(readWebToolActivity(f.home, { ...task, webExecution: { ...execution, controllerInstanceId: randomUUID() } })).toBe("unconfirmed");
    const snapshot = journal.getSnapshot();
    const record = { intent: { ...execution, sessionId: execution.sessionId }, cleanup: undefined } as unknown as BotRecord;
    const botSnapshot = { ...snapshot, claimId: undefined, testExecutionId: execution.executionId } as unknown as typeof snapshot;
    const botExecution = { ...execution, snapshot: botSnapshot } as unknown as BotExecution;
    expect(botToolActivity(record, botExecution)).toBe("inactive");
    expect(botToolActivity(record, { ...botExecution, snapshot: { ...botSnapshot, stoppedAt: null } })).toBe("unconfirmed");
    expect(botToolActivity(record, { ...botExecution, snapshot: { ...botSnapshot, controllerInstanceId: randomUUID() } })).toBe("unconfirmed");
  } finally { journal.close(); }
  // The committed proof remains readable after the writer's database handle closes.
  expect(readWebToolActivity(f.home, task)).toBe("inactive");
});
