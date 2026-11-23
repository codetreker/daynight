import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("persists and freezes a native history larger than the legacy 64 MiB limit", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-history-capacity");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "h-")); roots.push(root);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: root, nativeHome: path.join(root, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeFile(ticket.credentialFile, JSON.stringify({ token: "controller-grant-only", expiresAt: new Date(Date.now() + 900000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
  const file = path.join(root, "journal.sqlite"), journal = openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true });
  try {
    journal.recordRelayHistory("opaque-current-history");
    const text = "x".repeat(1048576);
    for (let index = 0; index < 65; index++) journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text }] });
    journal.acknowledgeEvents(journal.getLastSourceSequence());
    const intent = journal.prepareImageHistorySync()!;
    expect(Number(intent.byteLength)).toBeGreaterThan(64 * 1048576);
    expect((await stat(intent.filename)).size).toBe(Number(intent.byteLength));
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(intent.filename)) hash.update(chunk);
    expect(hash.digest("hex")).toBe(intent.sha256);
    expect(journal.prepareImageHistorySync()).toEqual(intent);
  } finally { journal.close(); }
}, 240000);
