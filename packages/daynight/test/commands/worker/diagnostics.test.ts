import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkerDiagnostics } from "../../../src/commands/worker/diagnostics.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("writes ordered JSONL and foreground errors without leaking credentials through cause chains", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-"));
  directories.push(home);
  const output: string[] = [];
  const token = 'service-secret-"\\should-stay-private';
  const guidToken = "11223344-5566-7788-99aa-bbccddeeff00";
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId: "00000000-0000-4000-8000-000000000001", platform: "linux", secrets: [token, guidToken], log: (text) => { output.push(text); } });
  logger.emit({ kind: "start", message: "Started.", task: { projectId: "project", taskId: "task", claimId: "claim", status: "active", agent: "codex", sessionId: "native-session" } });
  logger.emit({ kind: "error", message: `Request failed: ${token}; ${guidToken}.`, task: { projectId: guidToken, taskId: "task", claimId: "claim", status: "active", agent: "codex", sessionId: null }, error: new Error("Connection failed.", { cause: new Error(`Bearer ${token} https://name:password@example.test ${guidToken}`) }) });
  await logger.flush();
  const text = await readFile(logger.filename, "utf8");
  expect(text).not.toContain(token);
  expect(text).not.toContain("password");
  expect(output.join("")).not.toContain(token);
  expect(output.join("")).not.toContain("password");
  expect(text).not.toContain(guidToken);
  expect(output.join("")).not.toContain("11223344");
  const records = text.trim().split("\n").map((line) => JSON.parse(line));
  expect(records.map((record) => record.kind)).toEqual(["start", "error"]);
  expect(records[0]).toMatchObject({ projectId: "project", taskId: "task", claimId: "claim", agent: "codex", sessionId: "native-session", status: "active" });
  expect(records[0]).not.toHaveProperty("cleanup");
  expect(records[1].error.cause.message).toContain("[redacted]");
  expect(JSON.stringify(records)).not.toContain("should-stay-private");
  expect(records.every((record) => record.workerId === "00000000-0000-4000-8000-000000000001" && record.platform === "linux")).toBe(true);
});

it("abbreviates foreground GUIDs while preserving complete JSONL identities and errors", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-"));
  directories.push(home);
  const output: string[] = [];
  const workerId = "00112233-4455-6677-8899-aabbccddeeff";
  const task = { projectId: "FB1A3E30-f945-4c48-ab0f-55be117e098e", taskId: "49bc3068-2633-4949-8f7d-3600ffea4351", claimId: "fb0484fe-e27a-4573-8d54-3fe00c232f4e", status: "active", agent: "codex", sessionId: "aabbccdd-eeff-0011-2233-445566778899" } as const;
  const message = `Worker ${workerId} stopped; native-session and native-session-with-hyphens remain available.`;
  const cause = new Error(`Session ${task.sessionId} failed.`);
  const error = new AggregateError([new Error(`Claim ${task.claimId} failed.`, { cause })], `Project ${task.projectId} failed.`);
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId, platform: "linux", log: (text) => { output.push(text); } });
  logger.emit({ kind: "error", message, task, error });
  await logger.flush();
  expect(output).toHaveLength(1);
  expect(output[0]).toContain(" error FB1A3E30/49bc3068/fb0484fe active Worker 00112233 stopped; native-session and native-session-with-hyphens remain available.");
  expect(output[0]).toContain('"message":"Project FB1A3E30 failed."');
  expect(output[0]).toContain('"message":"Claim fb0484fe failed."');
  expect(output[0]).toContain('"message":"Session aabbccdd failed."');
  for (const id of [workerId, task.projectId, task.taskId, task.claimId, task.sessionId]) expect(output[0]).not.toContain(id);
  const record = JSON.parse(await readFile(logger.filename, "utf8"));
  expect(record).toMatchObject({ workerId, ...task, message, error: { name: "AggregateError", message: error.message, errors: [{ name: "Error", message: `Claim ${task.claimId} failed.`, cause: { name: "Error", message: cause.message } }] } });
});

it("reports an output failure at flush without letting diagnostics prevent shutdown work", async () => {
  const root = path.resolve("../../.tmp/worker-diagnostic-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "d-"));
  directories.push(home);
  const failure = new Error("Foreground output is unavailable.");
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId: "00000000-0000-4000-8000-000000000001", platform: "linux", log: () => { throw failure; } });
  expect(() => logger.emit({ kind: "start", message: "Starting." })).not.toThrow();
  await expect(logger.flush()).rejects.toBe(failure);
  expect(() => logger.emit({ kind: "shutdown", message: "Cleanup must still run." })).not.toThrow();
  await expect(logger.flush()).rejects.toBe(failure);
});
