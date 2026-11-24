import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "@playwright/test";

type Launch = { kind: "linux-controller-launch"; pid: number; launchId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const verifyLaunchIds = (launchId: string, executionId: string): void => {
  expect(uuid.test(launchId) && uuid.test(executionId), "Controller launch and execution IDs are canonical UUIDs").toBe(true);
};

// Select only identity fields: tickets, snapshots and process argv can contain private data.
const launch = (value: unknown): Launch => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Controller launch record is unavailable.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "kind,launchId,pid" || record.kind !== "linux-controller-launch"
    || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || (record.pid as number) > 2_147_483_647
    || typeof record.launchId !== "string" || !uuid.test(record.launchId)) throw new Error("Controller launch record has an invalid Linux identity.");
  return { kind: record.kind, pid: record.pid as number, launchId: record.launchId };
};

export const verifyControllerLaunch = async (input: { parent: unknown; launchId: string; executionId: string; journal: string }): Promise<Launch> => {
  const parent = launch(input.parent);
  expect(parent.launchId === input.launchId, "Parent launch identity matches the execution ticket").toBe(true);
  const db = new DatabaseSync(input.journal, { readOnly: true, timeout: 5000 });
  let row: { snapshot: string; owner_pid: number | null } | undefined;
  try { row = db.prepare("SELECT snapshot, owner_pid FROM execution WHERE id=1").get() as typeof row; }
  finally { db.close(); }
  if (!row || typeof row.snapshot !== "string") throw new Error("Controller journal execution is unavailable.");
  let snapshot: { executionId?: string; controllerProcess?: unknown; startup?: { state?: string } };
  try { snapshot = JSON.parse(row.snapshot) as typeof snapshot; }
  catch { throw new Error("Controller journal snapshot is invalid."); }
  expect(snapshot.executionId === input.executionId, "Journal belongs to the original execution").toBe(true);
  expect(launch(snapshot.controllerProcess), "Parent and journal Controller identities match").toEqual(parent);
  expect(row.owner_pid, "Journal writer is the recorded Controller").toBe(parent.pid);
  expect(snapshot.startup?.state, "Controller reached ready").toBe("ready");

  const cmdline = await readFile(`/proc/${parent.pid}/cmdline`);
  const argv = cmdline.toString("utf8").split("\0");
  // Never include the raw command line in assertion messages or output.
  const matches = argv.length === 8 && argv[7] === "" && path.basename(argv[1]!) === "controller-bootstrap.js"
    && path.basename(argv[2]!) === "main.js" && argv[3] === "codex" && argv[4] === "--launch-id"
    && argv[5] === parent.launchId && argv.filter(arg => arg === "--launch-id").length === 1;
  expect(matches, "Live Controller argv carries the recorded launchId").toBe(true);
  return parent;
};

export const verifyLaunchTicket = async (file: string, expected: { launchId: string; executionId: string; sessionId: string }): Promise<void> => {
  let ticket: { launchId?: string; executionId?: string; sessionId?: string };
  try { ticket = JSON.parse(await readFile(file, "utf8")) as typeof ticket; }
  catch { throw new Error("Controller launch ticket is unreadable."); }
  expect(ticket.launchId === expected.launchId && ticket.executionId === expected.executionId && ticket.sessionId === expected.sessionId,
    "Launch ticket matches the original execution and Session").toBe(true);
};

export const verifyIndependentControllerLaunch = async (stateDirectory: string, sessionId: string): Promise<void> => {
  const root = path.join(stateDirectory, "controller", "executions");
  const matches: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    let result: { session?: { sessionId?: string } };
    try { result = JSON.parse(await readFile(path.join(directory, "registration-result.json"), "utf8")) as typeof result; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw new Error("Test Controller registration is unreadable."); }
    if (result.session?.sessionId === sessionId) matches.push(entry.name);
  }
  expect(matches, "One local execution belongs to the Test Session").toHaveLength(1);
  const executionId = matches[0]!, directory = path.join(root, executionId);
  let parent: unknown;
  try { parent = JSON.parse(await readFile(path.join(directory, "process.json"), "utf8")) as unknown; }
  catch { throw new Error("Test Controller parent process record is unreadable."); }
  const identity = launch(parent);
  await verifyLaunchTicket(path.join(stateDirectory, "controller", "launches", `${identity.launchId}.json`), { ...identity, executionId, sessionId });
  await verifyControllerLaunch({ parent, launchId: identity.launchId, executionId, journal: path.join(directory, "journal.sqlite") });
};
