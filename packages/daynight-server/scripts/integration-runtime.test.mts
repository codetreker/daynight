import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm, access, chmod } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, finalizeRun, initializeRun, readProcessIdentity, recordCleanupBinary, planPostgres, recordPostgres, planRedis, recordRedis, setPhase, terminateOwnedProcess } from "./integration-runtime.mts";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = { DAYNIGHT_TEST_DATABASE_URL: "postgres://fixture", GITHUB_RUN_ID: "runtime-tools", GITHUB_JOB: "cleanup", GITHUB_RUN_ATTEMPT: "1" };

const ownedRun = async (t: TestContext) => {
  await mkdir(join(moduleRoot, ".tmp"), { recursive: true });
  const temporary = await mkdtemp(join(moduleRoot, ".tmp/integration-runtime-test."));
  const ownerModule = join(temporary, "module");
  const root = join(ownerModule, ".tmp", "integration." + randomBytes(4).toString("hex"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await initializeRun(ownerModule, root, process.pid, environment);
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  return { ownerModule, root, output: join(ownerModule, ".tmp/integration-results", basename(root)) };
};

const child = async (t: TestContext, root?: string, ignoreTerm = false) => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "DAYNIGHT_INTEGRATION_RUN_ROOT"));
  if (root !== undefined) inherited.DAYNIGHT_INTEGRATION_RUN_ROOT = root;
  const command = spawn(process.execPath, ["-e", `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ''} process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`], { env: inherited, stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(command, "exit");
  await once(command.stdout, "data");
  const identity = await readProcessIdentity(command.pid!);
  assert.notEqual(identity, null);
  t.after(async () => {
    await terminateOwnedProcess(identity!, 20, 1_000);
    await closed;
  });
  return { command, closed, identity: identity! };
};

const schemaCleanup = async (run: Awaited<ReturnType<typeof ownedRun>>, exitCode: number) => {
  await mkdir(join(run.root, "storage"));
  await writeFile(join(run.root, "resources.json"), JSON.stringify({ databaseUrl: "postgres://fixture", schema: "api_fixture", storageRoot: join(run.root, "storage") }));
  await writeFile(join(run.root, "cleanup"), `#!/bin/sh\nprintf '%s\\n' "$1" > "$0.received"\nprintf 'database-cleanup-probe\\n' >&2\nexit ${exitCode}\n`, { mode: 0o700 });
  await recordCleanupBinary(run.ownerModule, run.root);
  await setPhase(run.ownerModule, run.root, "test");
};

test("owned process termination waits for real exit and escalates within its configured budget", async (t) => {
  const graceful = await child(t);
  await terminateOwnedProcess(graceful.identity, 1_000, 1_000);
  assert.deepEqual(await graceful.closed, [null, "SIGTERM"]);
  assert.equal(await readProcessIdentity(graceful.identity.pid), null);
  const forced = await child(t, undefined, true);
  await terminateOwnedProcess(forced.identity, 20, 1_000);
  assert.deepEqual(await forced.closed, [null, "SIGKILL"]);
  assert.equal(await readProcessIdentity(forced.identity.pid), null);
});

test("a reused PID receipt does not signal the current process", async (t) => {
  const process_ = await child(t);
  await terminateOwnedProcess({ ...process_.identity, startTicks: (BigInt(process_.identity.startTicks) + 1n).toString() }, 20, 1_000);
  assert.deepEqual(await readProcessIdentity(process_.identity.pid), process_.identity);
});

test("cleanup drains run-root-marked children and leaves unrelated processes alive", async (t) => {
  const run = await ownedRun(t);
  const owned = await child(t, run.root);
  const unrelated = await child(t);
  await setPhase(run.ownerModule, run.root, "test");
  const result = await finalizeRun(run.ownerModule, run.root, 0);
  assert.equal(result.cleanup, "passed");
  assert.equal(result.status, "passed");
  await owned.closed;
  assert.equal(await readProcessIdentity(owned.identity.pid), null);
  assert.deepEqual(await readProcessIdentity(unrelated.identity.pid), unrelated.identity);
  await assert.rejects(access(run.root), { code: "ENOENT" });
});

test("cleanup failure retains receipts and cannot erase the original failing command", async (t) => {
  const run = await ownedRun(t);
  await schemaCleanup(run, 19);
  const result = await finalizeRun(run.ownerModule, run.root, 23);
  assert.equal(result.cleanup, "failed");
  assert.equal(result.commandExitCode, 23);
  assert.equal(result.testExitCode, 23);
  assert.equal(result.exitCode, 23);
  assert.match(result.error!, /database-cleanup-probe/);
  assert.equal((await readFile(join(run.root, "cleanup.received"), "utf8")).trim(), join(run.root, "resources.json"));
  await access(join(run.root, "resources.json"));
  assert.deepEqual(JSON.parse(await readFile(join(run.output, "result.json"), "utf8")), result);

  await writeFile(join(run.root, "cleanup"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await recordCleanupBinary(run.ownerModule, run.root);
  const [reconciled] = await cleanupAll(run.ownerModule, environment);
  assert.equal(reconciled.cleanup, "passed");
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.testExitCode, 23);
  assert.equal(reconciled.exitCode, 23);
  await assert.rejects(access(run.root), { code: "ENOENT" });
});

test("an otherwise passing command fails its cleanup gate and an interrupted run stays unverified", async (t) => {
  const failure = await ownedRun(t);
  await schemaCleanup(failure, 19);
  const failed = await finalizeRun(failure.ownerModule, failure.root, 0);
  assert.equal(failed.cleanup, "failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.commandExitCode, 0);
  assert.equal(failed.exitCode, 1);
  await access(failure.root);
  await writeFile(join(failure.root, "cleanup"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await recordCleanupBinary(failure.ownerModule, failure.root);
  const [reconciled] = await cleanupAll(failure.ownerModule, environment);
  assert.equal(reconciled.cleanup, "passed");
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.commandExitCode, 0);
  assert.equal(reconciled.testExitCode, 0);
  assert.equal(reconciled.exitCode, 1);

  const interrupted = await ownedRun(t);
  await setPhase(interrupted.ownerModule, interrupted.root, "test");
  const result = await finalizeRun(interrupted.ownerModule, interrupted.root, null);
  assert.equal(result.status, "interrupted");
  assert.equal(result.testExitCode, null);
  assert.equal(result.cleanup, "passed");
});

test("directory cleanup failure preserves ownership and the failed overall outcome", async (t) => {
  const run = await ownedRun(t);
  const locked = join(run.root, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "data"), "owned");
  await chmod(locked, 0o000);
  t.after(async () => { try { await chmod(locked, 0o700); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } });
  const failed = await finalizeRun(run.ownerModule, run.root, 0);
  assert.equal(failed.cleanup, "failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.cleanupPhase, "directory");
  await access(join(run.ownerModule, ".tmp/integration-owners", failed.runId + ".json"));
  await chmod(locked, 0o700);
  const [reconciled] = await cleanupAll(run.ownerModule, environment);
  assert.equal(reconciled.cleanup, "passed");
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.exitCode, 1);
  await assert.rejects(access(run.root), { code: "ENOENT" });
});


const dockerFixture = async (t: TestContext, run: Awaited<ReturnType<typeof ownedRun>>) => {
  const binary = join(run.ownerModule, "bin");
  const statePath = join(run.ownerModule, "docker.json");
  await mkdir(binary);
  await writeFile(join(binary, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const path = process.env.DAYNIGHT_DOCKER_FIXTURE;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
if (args[0] === "ps") {
  let items = state.containers;
  for (let i = 0; i < args.length; i++) if (args[i] === "--filter") {
    const filter = args[++i];
    if (filter.startsWith("label=")) {
      const [key, value] = filter.slice(6).split("=");
      items = items.filter(item => item.Config.Labels[key] === value);
    } else if (filter.startsWith("name=")) {
      const pattern = new RegExp(filter.slice(5));
      items = items.filter(item => pattern.test(item.Name));
    }
  }
  process.stdout.write(items.map(item => item.Id).join("\\n") + (items.length ? "\\n" : ""));
} else if (args[0] === "inspect") {
  const item = state.containers.find(item => item.Id === args[1]);
  if (!item) process.exit(1);
  process.stdout.write(JSON.stringify([item]));
} else if (args[0] === "rm") {
  const id = args.at(-1);
  state.removed.push(id);
  state.containers = state.containers.filter(item => item.Id !== id);
  fs.writeFileSync(path, JSON.stringify(state));
} else process.exit(2);
`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  const oldFixture = process.env.DAYNIGHT_DOCKER_FIXTURE;
  process.env.PATH = binary + ":" + oldPath;
  process.env.DAYNIGHT_DOCKER_FIXTURE = statePath;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldFixture === undefined) delete process.env.DAYNIGHT_DOCKER_FIXTURE; else process.env.DAYNIGHT_DOCKER_FIXTURE = oldFixture;
  });
  const set = (containers: unknown[]) => writeFile(statePath, JSON.stringify({ containers, removed: [] }));
  const get = async () => JSON.parse(await readFile(statePath, "utf8"));
  return { set, get };
};

const container = (runId: string, role: string, id: string) => ({
  Id: id,
  Name: "/daynight-api-" + (role === "redis" ? "redis-" : "") + runId,
  Config: { Labels: { "daynight.api-integration": runId, "daynight.api-integration-role": role } },
});

test("cleanup finds planned unrecorded Redis and recorded PostgreSQL without touching another run", async (t) => {
  const run = await ownedRun(t);
  // This run owns its PostgreSQL too, as in the default integration entry.
  const ownerPath = join(run.ownerModule, ".tmp/integration-owners", basename(run.root) + ".json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  owner.localPostgres = true;
  await writeFile(ownerPath, JSON.stringify(owner));
  const docker = await dockerFixture(t, run);
  const pg = container(basename(run.root), "postgres", "a".repeat(64));
  const redis = container(basename(run.root), "redis", "b".repeat(64));
  const unrelated = container("integration.87654321", "redis", "c".repeat(64));
  await planPostgres(run.ownerModule, run.root);
  await recordPostgres(run.ownerModule, run.root, pg.Id, pg.Name.slice(1));
  await planRedis(run.ownerModule, run.root);
  await docker.set([pg, redis, unrelated]);
  const result = await finalizeRun(run.ownerModule, run.root, null);
  assert.equal(result.cleanup, "passed");
  assert.equal(result.status, "interrupted");
  const state = await docker.get();
  assert.deepEqual(new Set(state.removed), new Set([pg.Id, redis.Id]));
  assert.deepEqual(state.containers, [unrelated]);
});

test("mismatched Redis identity or unknown role fails before removing any container, then recovery succeeds", async (t) => {
  const run = await ownedRun(t);
  const docker = await dockerFixture(t, run);
  const redis = container(basename(run.root), "redis", "b".repeat(64));
  await planRedis(run.ownerModule, run.root);
  await recordRedis(run.ownerModule, run.root, redis.Id, redis.Name.slice(1));
  const foreign = container(basename(run.root), "unknown", "c".repeat(64));
  await docker.set([redis, foreign]);
  const failed = await finalizeRun(run.ownerModule, run.root, 0);
  assert.equal(failed.cleanup, "failed");
  assert.match(failed.error!, /identity, role or ownership label/);
  assert.deepEqual((await docker.get()).removed, []);
  const tampered = structuredClone(redis);
  tampered.Config.Labels["daynight.api-integration"] = "integration.other123";
  await docker.set([tampered]);
  const stillFailed = await finalizeRun(run.ownerModule, run.root, 0);
  assert.equal(stillFailed.cleanup, "failed");
  assert.deepEqual((await docker.get()).removed, []);
  await docker.set([redis]);
  const [reconciled] = await cleanupAll(run.ownerModule, environment);
  assert.equal(reconciled.cleanup, "passed");
  assert.equal(reconciled.status, "failed");
  assert.deepEqual((await docker.get()).removed, [redis.Id]);
});


test("legacy receipt is reported and preserved while current runs are cleaned", async (t) => {
  const run = await ownedRun(t);
  const legacyRoot = join(run.ownerModule, ".tmp", "integration.00000000");
  const legacyReceipt = join(run.ownerModule, ".tmp/integration-owners", "integration.00000000.json");
  await mkdir(legacyRoot);
  const legacyData = JSON.stringify({ version: 1, context: { runId: environment.GITHUB_RUN_ID, job: environment.GITHUB_JOB, attempt: environment.GITHUB_RUN_ATTEMPT } });
  await writeFile(legacyReceipt, legacyData);
  await writeFile(join(legacyRoot, "legacy-resource"), "preserve");

  const results = await cleanupAll(run.ownerModule, environment);
  assert.equal(results.length, 2);
  const legacy = results.find((result) => result.runId === "integration.00000000")!;
  assert.equal(legacy.cleanup, "failed");
  assert.match(legacy.error!, /original owner/);
  assert.equal(await readFile(legacyReceipt, "utf8"), legacyData);
  assert.equal(await readFile(join(legacyRoot, "legacy-resource"), "utf8"), "preserve");
  assert.equal(results.find((result) => result.runId === basename(run.root))!.cleanup, "passed");
  await assert.rejects(access(run.root), { code: "ENOENT" });
});
