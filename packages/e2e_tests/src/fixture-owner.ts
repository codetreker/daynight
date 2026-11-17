import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { CommandOptions, CommandResult, ManagedCommand } from "./command.ts";
import { startGatedCommand, stopGate } from "./gated-command.ts";
import { captureProcessEvidence, inspectProcessEvidence, type ProcessEvidence } from "./process-evidence.ts";
import { loadFixtureStopProofs, readFixtureExecutions, stopRecordedFixtureExecutions, type FixtureExecutionIdentity } from "./worker-cleanup.ts";

type Launch = { id: string; stopped: boolean };
type Owner = { schemaVersion: 1; runId: string; runner: ProcessEvidence; verified: boolean; playwright: Launch | null; browserUnconfirmed: boolean; commands: Launch[]; controllerUnconfirmed: boolean; fixture: { prepared: boolean; identity: FixtureExecutionIdentity | null; interrupted: boolean; launches: Launch[] } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ownerPath = (run: string) => path.join(run, "results", "fixture-owner.json");
const lockPath = (run: string) => path.join(run, "results", "fixture-owner-lock.sqlite");
const withLock = async <T>(run: string, operation: () => Promise<T>): Promise<T> => {
  if (!(await stat(lockPath(run))).isFile()) throw new Error("Fixture ownership lock is unavailable.");
  const db = new DatabaseSync(lockPath(run));
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    try { const result = await operation(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
};
const validateRun = async (repository: string, run: string): Promise<string> => {
  const actual = await realpath(run), parent = path.join(await realpath(repository), ".tmp", "product-e2e");
  if (path.dirname(actual) !== parent || !uuid.test(path.basename(actual))) throw new Error("Fixture owner requires its original run directory.");
  return actual;
};
const rootFor = (repository: string, run: string) => path.join(repository, ".tmp", "product-e2e-retained", path.basename(run));
const writeOwner = async (run: string, value: Owner): Promise<void> => {
  const file = ownerPath(run), temp = `${file}.${process.pid}.${randomUUID()}.tmp`, handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
  const parent = await open(path.dirname(file), "r"); try { await parent.sync(); } finally { await parent.close(); }
};
const readOwner = async (run: string): Promise<Owner> => {
  let value: Owner;
  try { value = JSON.parse(await readFile(ownerPath(run), "utf8")) as Owner; } catch { throw new Error("Original fixture ownership is unavailable."); }
  const validLaunch = (launch: Launch) => launch && uuid.test(launch.id) && typeof launch.stopped === "boolean";
  if (!value || value.schemaVersion !== 1 || value.runId !== path.basename(run) || typeof value.verified !== "boolean" || !value.runner
    || !(value.playwright === null || validLaunch(value.playwright)) || typeof value.browserUnconfirmed !== "boolean" || !Array.isArray(value.commands) || !value.commands.every(validLaunch) || typeof value.controllerUnconfirmed !== "boolean" || !value.fixture || typeof value.fixture.prepared !== "boolean"
    || typeof value.fixture.interrupted !== "boolean" || !Array.isArray(value.fixture.launches) || !value.fixture.launches.every(validLaunch)
    || !(value.fixture.identity === null || typeof value.fixture.identity === "object")) throw new Error("Original fixture ownership is invalid.");
  return value;
};
export const initializeRunOwnership = async (repository: string, runDirectory: string): Promise<void> => {
  const run = await validateRun(repository, runDirectory);
  await mkdir(path.join(run, "results"), { recursive: true });
  const lock = await open(ownerPath(run), "wx", 0o600); await lock.close();
  const database = new DatabaseSync(lockPath(run)); database.exec("CREATE TABLE ownership_lock (id INTEGER PRIMARY KEY)"); database.close();
  await writeOwner(run, { schemaVersion: 1, runId: path.basename(run), runner: await captureProcessEvidence(process.pid), verified: false, playwright: null, browserUnconfirmed: false, commands: [], controllerUnconfirmed: false, fixture: { prepared: false, identity: null, interrupted: false, launches: [] } });
};
export const startOwnedPlaywright = async (input: { repository: string; runDirectory: string; command: string; args: readonly string[]; options: CommandOptions }): Promise<ManagedCommand> => {
  const run = await validateRun(input.repository, input.runDirectory), launch = { id: randomUUID(), stopped: false };
  await withLock(run, async () => { const owner = await readOwner(run);
    if (owner.verified || owner.playwright !== null || owner.runner.pid !== process.pid || await inspectProcessEvidence(owner.runner) !== "running") throw new Error("Playwright launch does not own this run.");
    owner.playwright = launch; owner.browserUnconfirmed = true; await writeOwner(run, owner); });
  const command = await startGatedCommand({ runDirectory: run, gateId: launch.id, command: input.command, args: input.args, options: input.options });
  const finished = command.finished.then(async result => {
    if (result.exitCode === 0) await withLock(run, async () => { const owner = await readOwner(run);
      if (owner.playwright?.id !== launch.id || owner.playwright.stopped) throw new Error("Playwright completion conflicts with original ownership.");
      owner.playwright.stopped = true; owner.browserUnconfirmed = false; await writeOwner(run, owner); });
    return result;
  });
  void finished.catch(() => {});
  return { ...command, finished, stop: async () => { await command.stopProcesses(); await finished; } };
};
export const startOwnedAuxiliary = async (input: { repository: string; runDirectory: string; command: string; args: readonly string[]; options: CommandOptions; independentController?: boolean }): Promise<ManagedCommand> => {
  const run = await validateRun(input.repository, input.runDirectory), launch = { id: randomUUID(), stopped: false };
  await withLock(run, async () => { const owner = await readOwner(run);
    if (owner.verified || owner.playwright === null || owner.playwright.stopped) throw new Error("Auxiliary launch conflicts with original ownership.");
    if (input.independentController) {
      if (owner.controllerUnconfirmed) throw new Error("Original Test Session controller remains unconfirmed.");
      owner.controllerUnconfirmed = true;
    }
    owner.commands.push(launch); await writeOwner(run, owner); });
  const command = await startGatedCommand({ runDirectory: run, gateId: launch.id, command: input.command, args: input.args, options: input.options });
  const finished = (async () => {
    let result: CommandResult | undefined, failure: unknown;
    try { result = await command.finished; } catch (error) { failure = error; }
    await command.stopProcesses();
    await withLock(run, async () => { const owner = await readOwner(run), original = owner.commands.find(item => item.id === launch.id);
      if (!original || original.stopped) throw new Error("Auxiliary stop conflicts with original ownership.");
      original.stopped = true;
      if (input.independentController && failure === undefined && result?.exitCode === 0 && result.stdout.includes("Test Session stopped and archived.")) owner.controllerUnconfirmed = false;
      await writeOwner(run, owner); });
    if (failure !== undefined) throw failure;
    return result!;
  })();
  void finished.catch(() => {});
  return { ...command, finished, stop: async () => { await command.stopProcesses(); await finished; } };
};
export const prepareFixtureOwnership = async (repository: string, runDirectory: string): Promise<string> => {
  const run = await validateRun(repository, runDirectory), root = rootFor(repository, run);
  return withLock(run, async () => { const owner = await readOwner(run);
    if (owner.verified || owner.fixture.prepared || owner.playwright === null) throw new Error("Fixture preparation conflicts with original ownership.");
    owner.fixture.prepared = true; await writeOwner(run, owner);
    await mkdir(path.dirname(root), { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 }); return root; });
};
export const registerFixtureIdentity = async (repository: string, runDirectory: string, identity: FixtureExecutionIdentity): Promise<void> => {
  const run = await validateRun(repository, runDirectory), root = rootFor(repository, run);
  await withLock(run, async () => { const owner = await readOwner(run);
    if (!owner.fixture.prepared || owner.fixture.launches.length || owner.fixture.identity !== null || identity.repository !== path.join(root, "repository")) throw new Error("Fixture identity conflicts with original ownership.");
    owner.fixture.identity = identity; await writeOwner(run, owner); });
};
export const registerFixtureClaim = async (repository: string, runDirectory: string, claimId: string): Promise<void> => {
  if (!uuid.test(claimId)) throw new Error("Fixture claim identity is invalid.");
  const run = await validateRun(repository, runDirectory);
  await withLock(run, async () => { const owner = await readOwner(run), identity = owner.fixture.identity;
    if (!identity || identity.claimId !== undefined && identity.claimId !== claimId) throw new Error("Fixture claim conflicts with its original identity.");
    identity.claimId = claimId; await writeOwner(run, owner); });
};
export const startOwnedFixture = async (input: { repository: string; runDirectory: string; command: string; args: readonly string[]; options: CommandOptions }): Promise<ManagedCommand> => {
  const run = await validateRun(input.repository, input.runDirectory), launch = { id: randomUUID(), stopped: false };
  await withLock(run, async () => { const owner = await readOwner(run);
    if (owner.verified || !owner.fixture.prepared || owner.fixture.identity === null || owner.fixture.launches.some(item => !item.stopped)) throw new Error("Fixture launch conflicts with original ownership.");
    owner.fixture.launches.push(launch); await writeOwner(run, owner); });
  return startGatedCommand({ runDirectory: run, gateId: launch.id, command: input.command, args: input.args, options: input.options });
};
export const markFixtureStopped = async (repository: string, runDirectory: string): Promise<void> => {
  const run = await validateRun(repository, runDirectory);
  await withLock(run, async () => { const owner = await readOwner(run), launch = owner.fixture.launches.at(-1);
    if (!launch || launch.stopped) throw new Error("Fixture stop does not match its original launch.");
    launch.stopped = true; await writeOwner(run, owner); });
};
export const recoverRunOwnership = async (input: { repository: string; runDirectory: string; mode: "owner" | "independent" }): Promise<void> => {
  const run = await validateRun(input.repository, input.runDirectory);
  await withLock(run, async () => {
  const owner = await readOwner(run);
  const runner = await inspectProcessEvidence(owner.runner);
  if (input.mode === "owner" ? owner.runner.pid !== process.pid || runner !== "running" : runner !== "stopped") throw new Error("Original runner ownership does not permit recovery.");
  if (owner.verified) return;
  if (owner.playwright !== null && !owner.playwright.stopped) await stopGate(run, owner.playwright.id, Date.now() + 15_000);
  const latest = await readOwner(run);
  if (owner.playwright !== null) {
    if (latest.playwright?.id !== owner.playwright.id) throw new Error("Playwright ownership changed during recovery.");
    latest.playwright.stopped = true; await writeOwner(run, latest);
  }
  for (const launch of latest.commands) if (!launch.stopped) { await stopGate(run, launch.id, Date.now() + 15_000); launch.stopped = true; await writeOwner(run, latest); }
  for (const launch of latest.fixture.launches) if (!launch.stopped) { latest.fixture.interrupted = true; await writeOwner(run, latest); await stopGate(run, launch.id, Date.now() + 15_000); launch.stopped = true; await writeOwner(run, latest); }
  if (latest.fixture.launches.length) {
    const root = rootFor(input.repository, run), identity = latest.fixture.identity;
    if (!identity || identity.repository !== path.join(root, "repository")) throw new Error("Original fixture identity is unavailable.");
    const config = path.join(root, "worker-config"), dist = path.join(run, "artifacts", "cli", "dist");
    const proofs = await loadFixtureStopProofs(name => import(pathToFileURL(path.join(dist, name)).href));
    await stopRecordedFixtureExecutions(await readFixtureExecutions(config), identity, config, proofs, Date.now() + 15_000);
  }
  if (latest.controllerUnconfirmed) throw new Error("Test Session Controller stop is unconfirmed; original private evidence is retained.");
  if (latest.fixture.interrupted) throw new Error("Interrupted Worker subprocess ownership remains unconfirmed; original state is retained.");
  if (latest.browserUnconfirmed) throw new Error("Playwright browser stop is unconfirmed; original state is retained.");
  if (latest.fixture.prepared) await rm(rootFor(input.repository, run), { recursive: true, force: true });
  latest.verified = true; await writeOwner(run, latest);
  });
};
