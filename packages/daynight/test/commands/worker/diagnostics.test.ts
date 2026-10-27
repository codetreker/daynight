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
  const logger = await createWorkerDiagnostics({ paths: resolveWorkerPaths(home), workerId: "00000000-0000-4000-8000-000000000001", platform: "linux", secrets: [token], log: (text) => { output.push(text); } });
  logger.emit({ kind: "start", message: "Started.", task: { projectId: "project", taskId: "task", claimId: "claim", status: "active", agent: "codex", sessionId: "native-session" } });
  logger.emit({ kind: "error", message: `Request failed: ${token}.`, error: new Error("Connection failed.", { cause: new Error(`Bearer ${token} https://name:password@example.test`) }) });
  await logger.flush();
  const text = await readFile(logger.filename, "utf8");
  expect(text).not.toContain(token);
  expect(text).not.toContain("password");
  expect(output.join("")).not.toContain(token);
  expect(output.join("")).not.toContain("password");
  const records = text.trim().split("\n").map((line) => JSON.parse(line));
  expect(records.map((record) => record.kind)).toEqual(["start", "error"]);
  expect(records[0]).toMatchObject({ projectId: "project", taskId: "task", claimId: "claim", agent: "codex", sessionId: "native-session", status: "active" });
  expect(records[0]).not.toHaveProperty("cleanup");
  expect(records[1].error.cause.message).toContain("[redacted]");
  expect(JSON.stringify(records)).not.toContain("should-stay-private");
  expect(records.every((record) => record.workerId === "00000000-0000-4000-8000-000000000001" && record.platform === "linux")).toBe(true);
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
