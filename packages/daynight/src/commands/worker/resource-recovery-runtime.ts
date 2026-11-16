import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { createOperation, type Operation } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import { loadServerConfiguration } from "../../config/server.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { readConfigurationSource } from "../../config/files.js";
import { runRepositoryGit } from "../../repository/git.js";
import { assertCurrentSqlite, type SqliteFormat } from "../../platform/sqlite-format.js";
import { readLaunchTicket, controllerExecutionDirectory } from "../controller/launch-ticket.js";
import { uploadStoppedControllerArchive } from "../controller/archive-upload.js";
import { parseSessionArchiveStatus } from "../../session/archive.js";
import { openWebExecutionStore } from "./backends/web-store.js";
import { webExecutionStoreFormat } from "./backends/web-store-format.js";
import { createWebStopObserver } from "./backends/web-stop.js";
import { resolveWorkerPaths } from "./paths.js";
import { tryAcquireWorkerInstanceLock } from "./instance-lock.js";
import { openWorkerStore } from "./store.js";
import { workerStoreFormat } from "./store-format.js";
import { readHerdrLifecycleRecords } from "./herdr/lifecycle-store.js";
import { createWorkerRemote } from "./remote.js";
import { createWorkerGitManager } from "./worktrees.js";
import type { WorktreeBinding } from "./types.js";
import { recoverCompletedWebResource, type ResourceRecoveryRequest } from "./resource-recovery.js";

const ordinaryFile = async (file: string): Promise<void> => {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Resource recovery requires the original ordinary evidence file.");
};
const currentEvidence = (file: string, format: SqliteFormat): void => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { db.transaction(() => assertCurrentSqlite(db, format)).deferred(); }
  finally { db.close(); }
};

/** Git itself repeats its dirty-worktree refusal; recovery never uses --force. */
export const verifyRecoveryGitContent = async (binding: WorktreeBinding, operation: Operation): Promise<void> => {
  const read = async (args: readonly string[]) => (await runRepositoryGit(binding.worktreePath, args, operation)).stdout.trim();
  // Status and even non-force worktree removal trust these index hints. Refuse
  // hidden content instead of clearing the user's flags to manufacture a check.
  for (const flag of ["-v", "-f"]) {
    const entries = (await read(["ls-files", flag, "-z"])).split("\0").filter(Boolean);
    if (entries.some(entry => /^[a-zS] /.test(entry))) throw new Error("Git index flags may hide worktree changes. Preserve and inspect those files and flags before recovery; recovery does not change index flags.");
  }
  if (await read(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]) !== "") throw new Error("The worktree contains modified, untracked or ignored files. Preserve them outside this worktree before confirming recovery.");
  const head = await read(["rev-parse", "--verify", "HEAD"]);
  if (await read(["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${binding.branch}`
    || await read(["rev-parse", "--verify", `refs/heads/${binding.branch}`]) !== head) throw new Error("The worktree HEAD is not preserved by its original named branch.");
  if (await read(["for-each-ref", "--format=%(refname)", `--contains=${head}`, "refs/remotes/"]) === "") throw new Error("The worktree HEAD has no observed remote reference. Preserve and verify its commits before recovery.");
};

export const removeRecoveryGitWorktree = async (binding: WorktreeBinding, operation: Operation): Promise<void> => {
  await verifyRecoveryGitContent(binding, operation);
  await runRepositoryGit(binding.repositoryPath, ["-c", "submodule.recurse=false", "worktree", "remove", "--", binding.worktreePath], operation);
};

export const runCompletedWebResourceRecovery = async (options: { homeDirectory: string; request: ResourceRecoveryRequest; output: (message: string) => void; signal?: AbortSignal }): Promise<void> => {
  const paths = resolveWorkerPaths(options.homeDirectory);
  const lock = await tryAcquireWorkerInstanceLock(paths);
  if (lock === null) throw new Error("Stop daynight worker run before inspecting or recovering retained resources.");
  const operation = createOperation({ ...(options.signal === undefined ? {} : { signal: options.signal }), limits: { totalMs: 300_000 } });
  let store: ReturnType<typeof openWorkerStore> | undefined, web: ReturnType<typeof openWebExecutionStore> | undefined, git: ReturnType<typeof createWorkerGitManager> | undefined;
  const failures: unknown[] = [];
  try {
    const configuration = parseConfigurationDocument(await readConfigurationSource(paths, operation.signal), paths);
    const workerId = typeof configuration.mapping.workerId === "string" ? canonicalId(configuration.mapping.workerId) : null;
    if (workerId === null) throw new Error("Restore the original configured Worker identity before recovery; a new identity cannot adopt these resources.");
    const { serverUrl, serverToken } = await loadServerConfiguration(paths, operation.signal);
    if (serverToken === undefined) throw new Error("Sign in as the original Worker owner before recovery.");
    await ordinaryFile(paths.databaseFile);
    const webFile = path.join(paths.workerDirectory, "web-executions.sqlite");
    try { await ordinaryFile(webFile); }
    catch (cause) { throw new Error("The original Web execution journal is unavailable. Restore the original Worker and Controller journals from backup; static Git markers cannot prove ownership, stop or archive preservation.", { cause }); }
    // Recovery cannot migrate or reset the records that establish its authority.
    currentEvidence(paths.databaseFile, workerStoreFormat);
    currentEvidence(webFile, webExecutionStoreFormat);
    store = openWorkerStore(paths.databaseFile);
    web = openWebExecutionStore(webFile);
    const herdrFile = path.join(paths.workerDirectory, "herdr-executions.sqlite");
    let hasHerdr = false;
    try { await ordinaryFile(herdrFile); hasHerdr = true; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (hasHerdr && readHerdrLifecycleRecords(herdrFile).some(record => record.owner.projectId === options.request.projectId && record.owner.taskId === options.request.taskId && record.claimId === options.request.claimId)) throw new Error("The original claim has conflicting Herdr and Web execution evidence; recovery is prohibited.");
    const project = store.getProject(options.request);
    if (project === null) throw new Error("Restore the original Project repository mapping before resource recovery.");
    const root = await lstat(project.localPath);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("The original repository directory is unavailable.");
    const remote = createWorkerRemote({ serverUrl, serverToken });
    git = createWorkerGitManager({ temporaryDirectory: paths.temporaryDirectory, prepareFormat: async (_project, repository) => {
      const file = path.join(repository.commonDirectory, "daynight/worktrees/format.json");
      await ordinaryFile(file);
      if (!isDeepStrictEqual(JSON.parse(await readFile(file, "utf8")), { version: 1 })) throw new Error("Resource recovery requires the current original worktree format; no migration was performed.");
    } });
    await git.prepareRepository(project, operation);
    const observer = createWebStopObserver({ homeDirectory: options.homeDirectory, store: web, now: Date.now });
    let originalDirectories: string[] | undefined;
    const verifyDirectories = async (binding: WorktreeBinding): Promise<void> => {
      const identities: string[] = [];
      for (const directory of [binding.repositoryPath, binding.commonDirectory, binding.worktreePath]) {
        const entry = await lstat(directory, { bigint: true });
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("An original recovery directory was replaced or is unavailable.");
        identities.push(`${entry.dev}:${entry.ino}`);
      }
      if (originalDirectories !== undefined && !isDeepStrictEqual(originalDirectories, identities)) throw new Error("An original recovery directory changed after verification.");
      originalDirectories = identities;
    };
    const result = await recoverCompletedWebResource({ request: options.request, signal: operation.signal, dependencies: {
      serverOrigin: serverUrl, workerId, project, currentUserId: remote.currentUserId, getRecord: web.getTask, readTask: remote.readTask, readProject: remote.project,
      inspectWorktree: async owner => {
        const scan = await git!.scanWorktrees(project, operation);
        if (!scan.enumerationComplete || scan.unknown.length > 0 || scan.quarantined.length > 0) throw new Error("Original Git resource enumeration is incomplete or conflicting.");
        const matches = scan.validated.filter(value => value.owner.projectId === owner.projectId && value.owner.taskId === owner.taskId && value.owner.claimId === owner.claimId);
        if (matches.length !== 1 || matches[0]!.owner.worktreeId !== owner.worktreeId) throw new Error("The original claim does not have one matching worktree.");
        await verifyDirectories(matches[0]!.binding);
        return matches[0]!.binding;
      },
      verifyStoppedArchive: async record => {
        const stopped = await observer(record, operation);
        if (stopped.kind !== "stopped") throw new Error("The original registered execution stop is unconfirmed; resources remain retained.");
        const execution = record.webExecution!;
        const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId);
        const journalPath = path.join(controllerExecutionDirectory(options.homeDirectory, execution.executionId), "journal.sqlite");
        const receiptPath = `${journalPath}.archive-receipt-${execution.executionGeneration}.json`;
        await ordinaryFile(receiptPath);
        const receipt = parseSessionArchiveStatus(JSON.parse(await readFile(receiptPath, "utf8")));
        if (receipt.state !== "ready" || receipt.schemaVersion !== 3) throw new Error("Recovery requires the original current-format ready archive receipt.");
        await uploadStoppedControllerArchive({ journalPath, ticket, serverToken, stateDirectory: paths.stateDirectory, signal: operation.signal,
          request: async (input, init) => {
            if (init?.method !== "GET") throw new Error("Recovery cannot publish or replace an archive; restore its original confirmed receipt.");
            return fetch(input, init);
          },
        });
      },
      verifyPreserved: async binding => verifyRecoveryGitContent(binding, operation),
      removeSafely: async (owner, binding) => {
        await verifyDirectories(binding);
        await removeRecoveryGitWorktree(binding, operation);
        if (await git!.findWorktree(project, owner, operation) !== null) throw new Error("The original worktree removal is unconfirmed; its manifest remains retained.");
      },
      retireManifest: async owner => { await git!.retireWorktreeManifest(project, owner, operation); },
    } });
    options.output(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { failures.push(error); }
  finally {
    try { operation.dispose(); } catch (error) { failures.push(error); }
    try { await git?.dispose(); } catch (error) { failures.push(error); }
    try { web?.close(); } catch (error) { failures.push(error); }
    try { store?.close(); } catch (error) { failures.push(error); }
    try { await lock.release(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Resource recovery and local cleanup failed.", { cause: failures[0] });
  }
};
