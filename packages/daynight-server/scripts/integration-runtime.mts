import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFile, readdir, readlink, mkdir, writeFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const delay = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

export type ProcessIdentity = { pid: number; startTicks: string; executable: string };
type CIContext = { runId?: string; job?: string; attempt?: string };
type Ownership = {
  version: 1;
  id: string;
  moduleRoot: string;
  root: string;
  owner: ProcessIdentity;
  context: CIContext;
  phase: string;
  cleanupPhase: "resources" | "directory";
  localPostgres: boolean;
  postgresPlanned: boolean;
  cleanupBinarySha256?: string;
  authBinary?: string;
  postgres?: { id: string; name: string; label: string };
};
type Resources = {
  databaseUrl: string;
  schema: string;
  storageRoot: string;
  gatewayRoot?: string;
  gatewayCallback?: string;
  server?: ProcessIdentity;
  gateway?: ProcessIdentity;
};
export type Result = {
  runId: string;
  phase: string;
  commandExitCode: number | null;
  testExitCode: number | null;
  exitCode: number | null;
  cleanupPhase: "resources" | "directory" | "complete";
  cleanup: "passed" | "failed";
  status: "passed" | "failed" | "interrupted";
  error?: string;
};

const missing = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");

export const readProcessIdentity = async (pid: number, expectedStartTicks?: string): Promise<ProcessIdentity | null> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned process ID");
  const exitObservationDeadline = Date.now() + 100;
  for (;;) {
    let data: string;
    try { data = await readFile(`/proc/${pid}/stat`, "utf8"); }
    catch (error) { if (missing(error)) return null; throw error; }
    const fields = data.slice(data.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[0] === "Z" || fields[0] === "X") return null;
    if (!/^[0-9]+$/.test(fields[19])) throw new Error("Invalid owned process start receipt");
    if (expectedStartTicks !== undefined && fields[19] !== expectedStartTicks) return null;
    try { return { pid, startTicks: fields[19], executable: await readlink(`/proc/${pid}/exe`) }; }
    catch (error) {
      if (!missing(error)) throw error;
      // Exit can remove the executable link before stat exposes the terminal state.
      // Keep observing that state instead of treating a missing link as proof.
      if (Date.now() >= exitObservationDeadline) throw new Error("Live integration process executable is unavailable", { cause: error });
      await delay(1);
    }
  }
};

const sameProcess = async (expected: ProcessIdentity) => {
  const actual = await readProcessIdentity(expected.pid, expected.startTicks);
  if (actual === null || actual.startTicks !== expected.startTicks) return false;
  if (actual.executable !== expected.executable) throw new Error("Owned integration process changed its executable");
  return true;
};

export const terminateOwnedProcess = async (expected: ProcessIdentity, gracefulMs = 5_000, forcedMs = 3_000) => {
  if (!await sameProcess(expected)) return;
  const signal = (kind: NodeJS.Signals) => {
    try { process.kill(expected.pid, kind); }
    catch (error) { if (!missing(error)) throw error; }
  };
  const wait = async (budget: number) => {
    const deadline = Date.now() + budget;
    while (await sameProcess(expected)) {
      if (Date.now() >= deadline) return false;
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    return true;
  };
  signal("SIGTERM");
  if (await wait(gracefulMs)) return;
  if (await sameProcess(expected)) signal("SIGKILL");
  if (!await wait(forcedMs)) throw new Error("Owned integration process termination is unconfirmed");
};

const validateRoot = (ownerModule: string, root: string) => {
  const absolute = resolve(root);
  if (dirname(absolute) !== join(resolve(ownerModule), ".tmp") || !/^integration\.[A-Za-z0-9]{8}$/.test(basename(absolute))) {
    throw new Error("Integration run directory is outside its owner");
  }
  return absolute;
};

const atomicJSON = async (path: string, value: unknown) => {
  await writeFile(path + ".writing", JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(path + ".writing", path);
};

const ownerPath = (ownerModule: string, root: string) => join(resolve(ownerModule), ".tmp/integration-owners", basename(validateRoot(ownerModule, root)) + ".json");

const writeOwnership = async (ownership: Ownership) => {
  const path = ownerPath(ownership.moduleRoot, ownership.root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicJSON(path, ownership);
};

export const initializeRun = async (ownerModule: string, root: string, ownerPid: number, environment: NodeJS.ProcessEnv = process.env) => {
  root = validateRoot(ownerModule, root);
  const owner = await readProcessIdentity(ownerPid);
  if (owner === null) throw new Error("Integration runner process is absent");
  const ownership: Ownership = {
    version: 1, id: basename(root), moduleRoot: resolve(ownerModule), root, owner, phase: "preparation", cleanupPhase: "resources", localPostgres: !environment.DAYNIGHT_TEST_DATABASE_URL, postgresPlanned: false,
    context: { runId: environment.GITHUB_RUN_ID, job: environment.GITHUB_JOB, attempt: environment.GITHUB_RUN_ATTEMPT },
  };
  await writeOwnership(ownership);
  await mkdir(join(resolve(ownerModule), ".tmp/integration-results", ownership.id), { recursive: true });
  return ownership;
};

const readOwnership = async (ownerModule: string, root: string): Promise<Ownership> => {
  root = validateRoot(ownerModule, root);
  const ownership = JSON.parse(await readFile(ownerPath(ownerModule, root), "utf8")) as Ownership;
  if (ownership.version !== 1 || ownership.root !== root || ownership.moduleRoot !== resolve(ownerModule) || ownership.id !== basename(root) || !["resources", "directory"].includes(ownership.cleanupPhase)) {
    throw new Error("Invalid integration run ownership receipt");
  }
  return ownership;
};

export const setPhase = async (ownerModule: string, root: string, phase: string) => {
  if (!["preparation", "build", "runtime", "authentication", "test"].includes(phase)) throw new Error("Invalid integration run phase");
  const ownership = await readOwnership(ownerModule, root);
  ownership.phase = phase;
  await writeOwnership(ownership);
};

export const recordPostgres = async (ownerModule: string, root: string, id: string, name: string) => {
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Invalid integration PostgreSQL identity");
  const ownership = await readOwnership(ownerModule, root);
  if (name !== "daynight-api-" + ownership.id) throw new Error("Invalid integration PostgreSQL name");
  ownership.postgres = { id, name, label: ownership.id };
  await writeOwnership(ownership);
};

export const planPostgres = async (ownerModule: string, root: string) => {
  const ownership = await readOwnership(ownerModule, root);
  if (!ownership.localPostgres) throw new Error("Integration run uses an externally owned PostgreSQL environment");
  ownership.postgresPlanned = true;
  await writeOwnership(ownership);
};

export const recordAuth = async (ownerModule: string, root: string, binary: string) => {
  const ownership = await readOwnership(ownerModule, root);
  ownership.authBinary = resolve(binary);
  await writeOwnership(ownership);
};

export const recordCleanupBinary = async (ownerModule: string, root: string) => {
  const ownership = await readOwnership(ownerModule, root);
  ownership.cleanupBinarySha256 = createHash("sha256").update(await readFile(join(root, "cleanup"))).digest("hex");
  await writeOwnership(ownership);
};

export const writeBuildReceipt = async (ownerModule: string, root: string, sourceSha: string, sourceFingerprint: string, race: boolean) => {
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !/^[0-9a-f]{64}$/.test(sourceFingerprint)) throw new Error("Invalid integration source receipt");
  const ownership = await readOwnership(ownerModule, root);
  const binary = join(root, "server");
  const receipt = {
    sourceSha, sourceFingerprint,
    binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
    goVersion: execFileSync("go", ["env", "GOVERSION"]).toString().trim(), race,
  };
  await atomicJSON(binary + ".json", receipt);
  await atomicJSON(join(ownerModule, ".tmp/integration-results", ownership.id, "build.json"), receipt);
};

const ownedDirectory = (path: string, parent: string) => {
  const absolute = resolve(path);
  if (!absolute.startsWith(resolve(parent) + "/")) throw new Error("Integration resource directory is outside its owner");
  return absolute;
};

const readResources = async (root: string): Promise<Resources | null> => {
  try { return JSON.parse(await readFile(join(root, "resources.json"), "utf8")) as Resources; }
  catch (error) { if (missing(error)) return null; throw error; }
};

const currentUserProcess = async (pid: string) => {
  try { return (await stat(`/proc/${pid}`)).uid === process.getuid!(); }
  catch (error) { if (missing(error)) return false; throw error; }
};

const discoveryEnvironment = async (pid: string): Promise<string | null> => {
  try { return (await readFile(`/proc/${pid}/environ`)).toString(); }
  catch (error) {
    if (missing(error)) return null;
    // Protected processes without a readable run marker are outside discovery;
    // declared PID receipts still require complete identity readback.
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) return null;
    throw error;
  }
};

const reconcileGateway = async (ownership: Ownership, resources: Resources) => {
  if ((resources.gateway !== undefined || resources.gatewayCallback !== undefined) && resources.gatewayRoot === undefined) throw new Error("Integration gateway directory receipt is absent");
  if (resources.gateway !== undefined) {
    if (resources.gateway.executable !== ownership.authBinary) throw new Error("Integration gateway executable differs from its owner");
    await terminateOwnedProcess(resources.gateway);
  } else if (resources.gatewayCallback !== undefined) {
    if (ownership.authBinary === undefined) throw new Error("Integration gateway binary receipt is absent");
    for (const name of await readdir("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      if (!await currentUserProcess(name)) continue;
      const data = await discoveryEnvironment(name);
      if (data === null) continue;
      const environment = Object.fromEntries(data.split("\0").filter(Boolean).map((entry) => {
        const split = entry.indexOf("="); return [entry.slice(0, split), entry.slice(split + 1)];
      }));
      if (environment.DAYNIGHT_FIXTURE_CALLBACK_URL !== resources.gatewayCallback) continue;
      const directory = ownedDirectory(dirname(environment.DAYNIGHT_FIXTURE_DATABASE_PATH), join(ownership.moduleRoot, ".tmp/auth-fixtures"));
      if (directory !== resolve(resources.gatewayRoot!)) continue;
      const identity = await readProcessIdentity(Number(name));
      if (identity === null) continue;
      if (identity.executable !== ownership.authBinary) throw new Error("Discovered integration gateway has a different executable");
      await terminateOwnedProcess(identity);
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (resources.gatewayRoot !== undefined) {
    await rm(ownedDirectory(resources.gatewayRoot, join(ownership.moduleRoot, ".tmp/auth-fixtures")), { recursive: true, force: true });
  }
};

const removePostgres = async (ownership: Ownership) => {
  if (!ownership.postgresPlanned) return;
  const output = await exec("docker", ["ps", "-a", "--filter", `label=daynight.api-integration=${ownership.id}`, "--format", "{{.ID}}"], { timeout: 15_000 });
  const ids = output.stdout.trim() === "" ? [] : output.stdout.trim().split("\n");
  if (ownership.postgres !== undefined && !ids.some((id) => ownership.postgres!.id.startsWith(id))) {
    const current = await exec("docker", ["ps", "-a", "--format", "{{.ID}}"], { timeout: 15_000 });
    if (current.stdout.split("\n").some((id) => id !== "" && ownership.postgres!.id.startsWith(id))) throw new Error("Integration PostgreSQL lost its ownership label");
  }
  for (const id of ids) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Invalid integration PostgreSQL discovery result");
    const result = await exec("docker", ["inspect", "--format", "{{.Name}}", id], { timeout: 15_000 });
    if (result.stdout.trim() !== "/daynight-api-" + ownership.id) throw new Error("Integration PostgreSQL name differs from its owner");
    await exec("docker", ["rm", "--force", "--volumes", id], { timeout: 15_000 });
  }
  const remaining = await exec("docker", ["ps", "-a", "--filter", `label=daynight.api-integration=${ownership.id}`, "--format", "{{.ID}}"], { timeout: 15_000 });
  if (remaining.stdout.trim() !== "") throw new Error("Integration PostgreSQL remains after cleanup");
};

const terminateRunChildren = async (ownership: Ownership) => {
  const ancestors = new Set<number>();
  let pid = process.pid;
  while (pid > 0 && !ancestors.has(pid)) {
    ancestors.add(pid);
    const data = await readFile(`/proc/${pid}/stat`, "utf8");
    pid = Number(data.slice(data.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
  }
  const logger = join(ownership.moduleRoot, ".tmp/integration-results", ownership.id, "run.log");
  for (let pass = 0; pass < 4; pass++) {
    const children: ProcessIdentity[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^[0-9]+$/.test(name) || ancestors.has(Number(name)) || !await currentUserProcess(name)) continue;
      const data = await discoveryEnvironment(name);
      if (data === null) continue;
      const marker = data.split("\0").find((entry) => entry.startsWith("DAYNIGHT_INTEGRATION_RUN_ROOT="));
      if (marker !== "DAYNIGHT_INTEGRATION_RUN_ROOT=" + ownership.root) continue;
      const identity = await readProcessIdentity(Number(name));
      if (identity === null) continue;
      if (basename(identity.executable) === "tee") {
        let arguments_: string[];
        try { arguments_ = (await readFile(`/proc/${name}/cmdline`)).toString().split("\0"); }
        catch (error) { if (missing(error)) continue; throw error; }
        if (arguments_.includes(logger)) continue;
      }
      children.push(identity);
    }
    if (children.length === 0) return;
    const order = (identity: ProcessIdentity) => identity.executable === join(ownership.root, "server") ? 1 : identity.executable === ownership.authBinary ? 2 : 0;
    children.sort((a, b) => order(a) - order(b));
    for (const identity of children) await terminateOwnedProcess(identity);
  }
  throw new Error("Integration child-process drain did not converge");
};

export const cleanupRun = async (ownerModule: string, root: string) => {
  const ownership = await readOwnership(ownerModule, root);
  await terminateRunChildren(ownership);
  if (ownership.cleanupPhase === "directory") return;
  const resources = await readResources(root);
  if (resources !== null) {
    if (resources.server !== undefined) {
      if (resources.server.executable !== join(root, "server")) throw new Error("Integration Server executable differs from its owner");
      await terminateOwnedProcess(resources.server);
    }
    await reconcileGateway(ownership, resources);
    if (resources.schema !== "") {
      if (ownership.cleanupBinarySha256 === undefined) throw new Error("Integration schema cleanup executable receipt is absent");
      const hash = createHash("sha256").update(await readFile(join(root, "cleanup"))).digest("hex");
      if (hash !== ownership.cleanupBinarySha256) throw new Error("Integration schema cleanup executable differs from its receipt");
      await exec(join(root, "cleanup"), [join(root, "resources.json")], { timeout: 15_000 });
    }
    if (resolve(resources.storageRoot) !== join(root, "storage")) throw new Error("Integration storage root differs from its owner");
    await rm(resources.storageRoot, { recursive: true, force: true });
  }
  await removePostgres(ownership);
};

export const finalizeRun = async (ownerModule: string, root: string, commandExitCode: number | null, prior?: Result): Promise<Result> => {
  if (commandExitCode !== null && (!Number.isSafeInteger(commandExitCode) || commandExitCode < 0 || commandExitCode > 255)) throw new Error("Invalid integration command outcome");
  const ownership = await readOwnership(ownerModule, root);
  const result: Result = {
    runId: ownership.id, phase: ownership.phase, commandExitCode,
    testExitCode: ownership.phase === "test" ? commandExitCode : null,
    exitCode: prior === undefined ? commandExitCode : prior.exitCode,
    cleanupPhase: ownership.cleanupPhase,
    cleanup: "passed", status: prior === undefined ? commandExitCode === null ? "interrupted" : commandExitCode === 0 ? "passed" : "failed" : prior.status,
  };
  if (prior?.error !== undefined) result.error = prior.error;
  const output = join(ownerModule, ".tmp/integration-results", ownership.id);
  await mkdir(output, { recursive: true });
  try {
    await cleanupRun(ownerModule, root);
    ownership.cleanupPhase = "directory";
    await writeOwnership(ownership);
    result.cleanupPhase = "directory";
    await atomicJSON(join(output, "result.json"), { ...result, cleanup: "failed", status: result.status === "passed" ? "interrupted" : result.status, exitCode: result.status === "passed" ? null : result.exitCode });
    await rm(root, { recursive: true, force: true });
    await rm(ownerPath(ownerModule, root));
    result.cleanupPhase = "complete";
  }
  catch (error) {
    result.cleanup = "failed";
    result.status = "failed";
    if (prior === undefined && commandExitCode === 0) result.exitCode = 1;
    result.error = error instanceof Error ? error.message : String(error);
  }
  await atomicJSON(join(output, "result.json"), result);
  return result;
};

export const cleanupAll = async (ownerModule: string, environment: NodeJS.ProcessEnv = process.env) => {
  const registry = join(ownerModule, ".tmp/integration-owners");
  const results: Result[] = [];
  let entries;
  try { entries = await readdir(registry, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return results; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^integration\.[A-Za-z0-9]{8}\.json$/.test(entry.name)) continue;
    const root = join(ownerModule, ".tmp", entry.name.slice(0, -5));
    const ownership = await readOwnership(ownerModule, root);
    if (environment.GITHUB_RUN_ID !== undefined) {
      if (ownership.context.runId !== environment.GITHUB_RUN_ID || ownership.context.job !== environment.GITHUB_JOB || ownership.context.attempt !== environment.GITHUB_RUN_ATTEMPT) continue;
    } else if (await sameProcess(ownership.owner)) {
      continue;
    }
    const path = join(ownerModule, ".tmp/integration-results", ownership.id, "result.json");
    let prior: Result | undefined;
    try { prior = JSON.parse(await readFile(path, "utf8")) as Result; }
    catch (error) { if (!missing(error)) throw error; }
    results.push(await finalizeRun(ownerModule, root, prior === undefined ? null : prior.commandExitCode, prior));
  }
  return results;
};

const cli = async (arguments_: string[]) => {
  const [command, root, ...values] = arguments_;
  switch (command) {
    case "initialize": await initializeRun(moduleRoot, root, Number(values[0])); return;
    case "phase": await setPhase(moduleRoot, root, values[0]); return;
    case "postgres": await recordPostgres(moduleRoot, root, values[0], values[1]); return;
    case "postgres-planned": await planPostgres(moduleRoot, root); return;
    case "auth": await recordAuth(moduleRoot, root, values[0]); return;
    case "cleanup-binary": await recordCleanupBinary(moduleRoot, root); return;
    case "receipt": {
      if (!["true", "false"].includes(values[2])) throw new Error("Invalid integration race receipt");
      await writeBuildReceipt(moduleRoot, root, values[0], values[1], values[2] === "true"); return;
    }
    case "finish": {
      const result = await finalizeRun(moduleRoot, root, Number(values[0]));
      process.stdout.write(JSON.stringify(result) + "\n");
      if (result.cleanup === "failed") process.exitCode = result.exitCode === null ? 1 : result.exitCode;
      return;
    }
    case "cleanup-all": {
      const results = await cleanupAll(moduleRoot);
      process.stdout.write(JSON.stringify(results) + "\n");
      if (results.some((result) => result.cleanup === "failed")) process.exitCode = 1;
      return;
    }
    default: throw new Error("Invalid integration runtime command");
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cli(process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
