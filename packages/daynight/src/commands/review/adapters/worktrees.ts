import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { RepositoryConfiguration } from "../config.js";
import { remoteIdentity } from "../config.js";
import { ancestorIdentities, resolvePhysicalDirectory } from "../../../platform/filesystem.js";
import { executeCommand, prepareGitHubAuthentication, sanitizedProcessError } from "./github.js";
import type { CommandExecutor, GitHubClient, GitHubRepository } from "./github.js";
import type { Store } from "../store.js";
import type { OperationsStopped, ProcessesExcluded, PullRequestIdentity, PullRequestState, RepositoryState, ReviewState } from "../model.js";

export type LocalRepository = {
  configuration: RepositoryConfiguration;
  repository: GitHubRepository;
  root: string;
  commonDirectory: string;
  rootIdentity: string;
  commonIdentity: string;
};
export type PreparedWorktree = {
  kind: "prepared";
  path: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  gitEnvironment: Record<string, string | undefined>;
};
export class GitCommandError extends Error {
  readonly completed: boolean;
  constructor(message: string, cause: unknown, completed: boolean) {
    super(message, { cause });
    this.name = "GitCommandError";
    this.completed = completed;
  }
}
type WorktreeEntry = { path: string; locked: string | null };
type OwnedWorktree = { target: string; exists: boolean; entry: WorktreeEntry | null; administrativeDirectory: string | null };
const localGitEnvironment = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
]);
/** Child overrides: undefined entries erase inherited selectors before prepared settings apply. */
export const isolatedGitEnvironment = (
  inherited: Readonly<Record<string, string | undefined>>,
  prepared: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  const environment: Record<string, string | undefined> = {};
  for (const name of Object.keys(inherited)) {
    const upper = name.toUpperCase();
    if (localGitEnvironment.has(upper) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper) || upper.startsWith("GIT_TRACE") || upper === "GIT_CURL_VERBOSE") {
      environment[name] = undefined;
    }
  }
  return Object.assign(environment, prepared);
};
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const requireSha = (sha: string): string => {
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(sha)) throw new Error("Git returned an invalid commit object ID.");
  return sha;
};
const requireUuid = (value: string): void => {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) throw new Error("A review must have a UUID.");
};
const existingDirectory = async (target: string) => {
  const directory = await resolvePhysicalDirectory(target);
  if (directory.missingComponents.length !== 0) throw new Error(`Filesystem directory ${target} is missing.`);
  return directory;
};
const sameDirectory = async (first: string, second: string): Promise<boolean> =>
  (await existingDirectory(first)).ancestorIdentity === (await existingDirectory(second)).ancestorIdentity;
const ordinaryDirectory = async (target: string): Promise<boolean> => {
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Managed worktree path ${target} must be an ordinary directory.`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};
const parseWorktrees = (output: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of output.split("\0")) {
    if (field === "") { if (current !== null) entries.push(current); current = null; continue; }
    if (field.startsWith("worktree ")) { if (current !== null) throw new Error("Git returned an incomplete worktree entry."); current = { path: field.slice(9), locked: null }; }
    else if (field === "locked" || field.startsWith("locked ")) {
      if (current === null) throw new Error("Git returned a lock outside a worktree entry.");
      current.locked = field === "locked" ? "" : field.slice(7);
    }
  }
  if (current !== null) throw new Error("Git returned incomplete worktree output.");
  return entries;
};

export const createGitManager = (options: {
  temporaryDirectory: string;
  client: GitHubClient;
  execute?: CommandExecutor;
  now?: () => number;
  timeoutMs?: number;
  maxBufferBytes?: number;
}) => {
  if (!path.isAbsolute(options.temporaryDirectory)) throw new Error("The Git temporary directory must be absolute.");
  const execute = options.execute === undefined ? executeCommand : options.execute;
  const now = options.now === undefined ? Date.now : options.now;
  const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
  const maxBufferBytes = options.maxBufferBytes === undefined ? 16 * 1024 * 1024 : options.maxBufferBytes;
  for (const [label, value] of [["Git command timeout", timeoutMs], ["Git output limit", maxBufferBytes]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${label} must be a positive supported integer.`);
  }
  let context: Promise<{ hooksDirectory: string; gitEnvironment: Record<string, string | undefined> }> | undefined;
  const gitContext = () => {
    if (context === undefined) context = (async () => {
      await mkdir(options.temporaryDirectory, { recursive: true });
      const directory = await mkdtemp(path.join(options.temporaryDirectory, "git-context-"));
      const hooksDirectory = path.join(directory, "hooks");
      const graftsFile = path.join(directory, "grafts");
      await mkdir(hooksDirectory);
      await writeFile(graftsFile, "", { flag: "wx" });
      return { hooksDirectory, gitEnvironment: {
        GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: graftsFile,
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "core.sparseCheckout", GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "core.sparseCheckoutCone", GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "index.sparse", GIT_CONFIG_VALUE_2: "false",
      } };
    })();
    return context;
  };
  const run = async (args: readonly string[], signal?: AbortSignal, host?: string): Promise<string> => {
    signal?.throwIfAborted();
    const context = await gitContext();
    const environment = isolatedGitEnvironment(process.env, context.gitEnvironment);
    environment.GIT_TERMINAL_PROMPT = "0";
    const prefix = ["-c", `core.hooksPath=${context.hooksDirectory}`, "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"];
    if (host !== undefined) {
      const authentication = await prepareGitHubAuthentication(host, execute, { timeoutMs, maxBufferBytes, ...(signal === undefined ? {} : { signal }) });
      Object.assign(environment, authentication.environment);
      prefix.push("-c", `credential.https://${host}.helper=`, "-c", `credential.https://${host}.helper=!\"gh\" auth git-credential`);
    }
    let result;
    try { result = await execute("git", [...prefix, ...args], { timeoutMs, maxBufferBytes, environment, ...(signal === undefined ? {} : { signal }) }); }
    catch (cause) { throw new GitCommandError("Git command did not complete; its effects must be reconciled before retry.", host === undefined ? cause : sanitizedProcessError(cause), false); }
    if (result.error !== null || signal?.aborted) {
      const failure = result.error;
      const completed = !signal?.aborted && failure !== null && "code" in failure && typeof failure.code === "number" &&
        !("killed" in failure && failure.killed === true) && !("signal" in failure && failure.signal !== null && failure.signal !== undefined);
      throw new GitCommandError("Git operation failed; its effects must be reconciled before retry.",
        host === undefined ? failure ?? signal?.reason : sanitizedProcessError(failure ?? signal?.reason), completed);
    }
    return result.stdout;
  };
  const git = (root: string, args: readonly string[], signal?: AbortSignal): Promise<string> => run(["-C", root, ...args], signal);
  const command = async (root: string, args: readonly string[], signal?: AbortSignal): Promise<string> => (await git(root, args, signal)).replace(/\r?\n$/, "");
  const rootAndCommon = async (root: string, signal?: AbortSignal): Promise<{ root: string; commonDirectory: string }> => {
    const requested = await existingDirectory(root);
    const top = await command(requested.ancestorPath, ["rev-parse", "--show-toplevel"], signal);
    if (!(await sameDirectory(requested.ancestorPath, top))) throw new Error(`Configured repository ${root} is not its exact Git worktree root.`);
    const common = await command(requested.ancestorPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
    return { root: requested.ancestorPath, commonDirectory: (await existingDirectory(common)).ancestorPath };
  };
  const ensureRepository = async (configuration: RepositoryConfiguration, signal?: AbortSignal, expectedId?: string, registration?: RepositoryState | null): Promise<LocalRepository> => {
    signal?.throwIfAborted();
    const repository = await options.client.resolveRepository(configuration, signal);
    if (expectedId !== undefined && repository.githubId !== expectedId) throw new Error("The assigned repository no longer has the expected GitHub identity.");
    signal?.throwIfAborted();
    const target = await resolvePhysicalDirectory(configuration.path);
    if (target.missingComponents.length !== 0) {
      await mkdir(path.dirname(configuration.path), { recursive: true });
      await mkdir(configuration.path);
      const reserved = await existingDirectory(configuration.path);
      try {
        await run(["clone", "--origin=origin", "--no-tags", `--template=${(await gitContext()).hooksDirectory}`, "--", `https://${configuration.host}/${configuration.owner}/${configuration.name}.git`, reserved.ancestorPath], signal, configuration.host);
      } catch (cause) {
        if (cause instanceof GitCommandError && cause.completed) {
          try {
            if (await ordinaryDirectory(configuration.path)) {
              const current = await existingDirectory(configuration.path);
              if (current.ancestorIdentity !== reserved.ancestorIdentity) throw new Error("The reserved clone destination changed identity.");
              if (!(await ordinaryDirectory(reserved.ancestorPath)) || (await existingDirectory(reserved.ancestorPath)).ancestorIdentity !== reserved.ancestorIdentity) {
                throw new Error("The physical clone destination changed identity.");
              }
              await rm(reserved.ancestorPath, { recursive: true });
            }
          } catch (cleanupError) {
            throw new AggregateError([cause, cleanupError], `Clone failed and its exclusive destination ${configuration.path} could not be safely removed.`);
          }
          throw new Error(`Cannot clone repository into ${configuration.path}; the failed exclusive destination was removed.`, { cause });
        }
        throw new Error(`Cannot clone repository into ${configuration.path}; the reserved destination is retained because the process outcome is uncertain.`, { cause });
      }
    }
    const directories = await rootAndCommon(configuration.path, signal);
    const origins = (await command(directories.root, ["config", "--local", "--get-all", "remote.origin.url"], signal)).split(/\r?\n/);
    if (origins.length !== 1 || origins[0] === "") throw new Error("The configured repository must have exactly one origin URL.");
    const identity = remoteIdentity(origins[0]!, "Git origin");
    if (identity.host !== configuration.host) throw new Error("The configured repository origin has a different GitHub host.");
    const recorded = registration == null ? null : remoteIdentity(registration.remote, "Registered repository remote");
    const canRename = registration != null && expectedId !== undefined && registration.host === repository.host && registration.githubId === expectedId &&
      await sameDirectory(registration.localPath, directories.root) && recorded?.coordinate === identity.coordinate && identity.coordinate !== configuration.coordinate;
    if (canRename) {
      // The durable registration binds the old origin and physical clone to this stable ID.
      // The newly resolved coordinate is authoritative even when the old name was reused.
      const rootIdentity = (await existingDirectory(directories.root)).ancestorIdentity;
      const commonIdentity = (await existingDirectory(directories.commonDirectory)).ancestorIdentity;
      try {
        await git(directories.root, ["config", "--local", "--replace-all", "remote.origin.url", configuration.remote], signal);
        const checked = await rootAndCommon(directories.root, signal);
        if ((await existingDirectory(checked.root)).ancestorIdentity !== rootIdentity || (await existingDirectory(checked.commonDirectory)).ancestorIdentity !== commonIdentity ||
          await command(checked.root, ["config", "--local", "--get-all", "remote.origin.url"], signal) !== configuration.remote) throw new Error("The repository identity or origin changed while updating its coordinate.");
      } catch (error) {
        throw new GitCommandError("The repository origin update could not be confirmed; its original ownership must be reconciled.", error, false);
      }
    } else {
      const originRepository = await options.client.resolveRepository({ ...configuration, ...identity, remote: origins[0]! }, signal);
      if (originRepository.host !== repository.host || originRepository.githubId !== repository.githubId) throw new Error("The configured repository origin identifies a different GitHub repository.");
    }
    return { configuration, repository, ...directories,
      rootIdentity: (await existingDirectory(directories.root)).ancestorIdentity,
      commonIdentity: (await existingDirectory(directories.commonDirectory)).ancestorIdentity };
  };
  const validateLocal = async (local: LocalRepository, signal?: AbortSignal): Promise<void> => {
    const directories = await rootAndCommon(local.root, signal);
    if ((await existingDirectory(directories.root)).ancestorIdentity !== local.rootIdentity ||
      (await existingDirectory(directories.commonDirectory)).ancestorIdentity !== local.commonIdentity) {
      throw new Error("The configured Git root or common directory changed identity.");
    }
  };
  const validateStoredRepository = async (store: Store, local: LocalRepository): Promise<void> => {
    const repository = store.getRepository(local.repository);
    if (repository === null || !await sameDirectory(repository.localPath, local.root)) {
      throw new Error("The local Git repository does not match its durable repository registration.");
    }
  };
  const worktreeEntries = async (local: LocalRepository, signal?: AbortSignal): Promise<WorktreeEntry[]> => parseWorktrees(await git(local.root, ["worktree", "list", "--porcelain", "-z"], signal));
  const worktreePath = (local: LocalRepository, number: number): string => path.join(local.root, ".worktrees", `pr-${number}`);
  const entryFor = async (entries: readonly WorktreeEntry[], target: string, exists: boolean): Promise<WorktreeEntry | null> => {
    for (const entry of entries) {
      if (path.resolve(entry.path) === target) return entry;
      if (exists && await ordinaryDirectory(entry.path) && await sameDirectory(entry.path, target)) return entry;
    }
    return null;
  };
  const readOrdinaryFile = async (target: string): Promise<string | null> => {
    try {
      const entry = await lstat(target);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Git metadata ${target} must be an ordinary file.`);
      return (await readFile(target, "utf8")).replace(/\r?\n$/, "");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  const fileIdentity = async (target: string): Promise<string> => {
    const entry = await lstat(target, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Git pointer ${target} must be an ordinary file.`);
    return `${entry.dev}:${entry.ino}`;
  };
  const canonicalMissingPath = async (target: string): Promise<string> => {
    const parent = await resolvePhysicalDirectory(path.dirname(target));
    return path.join(parent.ancestorPath, ...parent.missingComponents, path.basename(target));
  };
  const ownedAdministrativeDirectory = async (local: LocalRepository, target: string, sessionId: string, exists: boolean, signal?: AbortSignal): Promise<string> => {
    const pointerFile = path.join(target, ".git");
    let pointerIdentity: string | null = null;
    if (exists) {
      try { pointerIdentity = await fileIdentity(pointerFile); }
      catch (cause) { throw new Error(`Cannot validate managed Git pointer ${pointerFile}.`, { cause }); }
    }
    const family = path.join(local.commonDirectory, "worktrees");
    if (!await ordinaryDirectory(family)) throw new Error("The managed worktree has no linked administrative family.");
    const matches: string[] = [];
    for (const entry of await readdir(family, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(family, entry.name);
      if (await readOrdinaryFile(path.join(directory, "locked")) !== `daynight:${sessionId}`) continue;
      const backpointer = await readOrdinaryFile(path.join(directory, "gitdir"));
      if (backpointer === null) continue;
      const resolvedPointer = path.resolve(directory, backpointer);
      let matchesPointer: boolean;
      if (exists) {
        try { matchesPointer = await fileIdentity(resolvedPointer) === pointerIdentity; }
        catch (error) { if (isMissing(error)) continue; throw error; }
      } else matchesPointer = await canonicalMissingPath(resolvedPointer) === pointerFile;
      if (!matchesPointer) continue;
      const common = await readOrdinaryFile(path.join(directory, "commondir"));
      if (common === null || !await sameDirectory(path.resolve(directory, common), local.commonDirectory)) {
        throw new Error("The managed worktree administrative registration has a different common directory.");
      }
      matches.push((await existingDirectory(directory)).ancestorPath);
    }
    if (matches.length !== 1) throw new Error("The managed worktree administrative registration is missing or ambiguous.");
    const directory = matches[0]!;
    if (await sameDirectory(directory, local.commonDirectory)) throw new Error("The managed worktree cannot use primary Git administration.");
    if (exists) {
      const actual = await command(target, ["rev-parse", "--absolute-git-dir"], signal);
      if (!await sameDirectory(actual, directory)) throw new Error("The managed worktree Git pointer does not match its own administrative registration.");
    }
    return directory;
  };
  const ownedGit = (owned: OwnedWorktree, args: readonly string[], signal?: AbortSignal): Promise<string> => {
    if (owned.administrativeDirectory === null || !owned.exists) throw new Error("An existing bound worktree is required for Git worktree operations.");
    return run(["--git-dir", owned.administrativeDirectory, "--work-tree", owned.target, "-C", owned.target, ...args], signal);
  };
  const emptyTrackedSubmodules = async (owned: OwnedWorktree, signal?: AbortSignal): Promise<void> => {
    const target = owned.target;
    const leaf = await existingDirectory(target);
    const tracked = await ownedGit(owned, ["ls-files", "--stage", "-z"], signal);
    for (const entry of tracked.split("\0")) {
      const match = /^160000 [a-f\d]+ [0-3]\t([\s\S]+)$/.exec(entry);
      if (match === null) continue;
      const directory = path.resolve(target, match[1]!);
      if (!await ordinaryDirectory(directory)) continue;
      const physical = await existingDirectory(directory);
      if (!(await ancestorIdentities(physical.ancestorPath)).has(leaf.ancestorIdentity) || physical.ancestorIdentity === leaf.ancestorIdentity) {
        throw new Error("An initialized submodule points outside the owned worktree.");
      }
      signal?.throwIfAborted();
      await rm(directory, { recursive: true });
      await mkdir(directory);
    }
  };
  const inspectOwned = async (local: LocalRepository, pullRequest: PullRequestState, signal?: AbortSignal): Promise<OwnedWorktree> => {
    await validateLocal(local, signal);
    const target = worktreePath(local, pullRequest.number);
    if (pullRequest.worktreePath !== null && pullRequest.worktreePath !== target) throw new Error("The persisted PR worktree path does not match its fixed repository location.");
    await ordinaryDirectory(path.dirname(target));
    const exists = await ordinaryDirectory(target);
    const entries = await worktreeEntries(local, signal);
    const entry = await entryFor(entries, target, exists);
    if ((exists || entry !== null) && pullRequest.worktreePath === null) throw new Error(`Unowned existing worktree path ${target} must be preserved.`);
    if (entry === null) {
      if (exists) throw new Error(`Unregistered existing worktree path ${target} must be preserved.`);
      return { target, exists, entry, administrativeDirectory: null };
    }
    if (pullRequest.sessionId === null || entry.locked !== `daynight:${pullRequest.sessionId}`) throw new Error("The PR worktree ownership lock does not match its persisted session.");
    const administrativeDirectory = await ownedAdministrativeDirectory(local, target, pullRequest.sessionId, exists, signal);
    if (exists) {
      const directories = await rootAndCommon(target, signal);
      if (!(await sameDirectory(directories.commonDirectory, local.commonDirectory))) throw new Error("The managed worktree belongs to a different repository.");
    }
    return { target, exists, entry, administrativeDirectory };
  };
  const currentPreparation = (store: Store, local: LocalRepository, reviewId: string): { review: ReviewState; pullRequest: PullRequestState } => {
    const review = store.getReview(reviewId);
    if (review === null || review.status !== "preparing" || review.host !== local.repository.host || review.githubId !== local.repository.githubId) throw new Error("A preparing review reservation for this repository is required.");
    const pullRequest = store.getPullRequest(review);
    if (pullRequest === null || pullRequest.sessionId === null || pullRequest.state !== "open" || pullRequest.draft || pullRequest.cleanupPending || pullRequest.desiredRevision !== review.revision || pullRequest.headSha !== review.headSha || pullRequest.baseRef !== review.baseRef) throw new Error("The review target is no longer ready for worktree preparation.");
    const other = store.listActiveReviews().some((active) => active.host === review.host && active.githubId === review.githubId && active.number === review.number && active.id !== review.id);
    if (other) throw new Error("Another active review blocks worktree preparation.");
    return { review, pullRequest };
  };
  const refresh = async (store: Store, local: LocalRepository, number: number, signal?: AbortSignal): Promise<PullRequestState> => {
    const observed = await options.client.getPullRequest(local.repository, number, signal);
    if (observed.number !== number) throw new Error("GitHub returned a different PR during worktree reconciliation.");
    const current = store.observePullRequest(local.repository, observed, now());
    if (current === null) throw new Error("The PR is permanently excluded by the repository cutoff.");
    return current;
  };
  const eligible = (review: ReviewState, current: PullRequestState): boolean => current.state === "open" && !current.draft && !current.cleanupPending && review.revision === current.desiredRevision && review.headSha === current.headSha && review.baseRef === current.baseRef;
  const privateRef = (review: ReviewState, suffix: string): string => `refs/daynight/reviews/${review.id}/${suffix}`;
  const findRef = async (local: LocalRepository, ref: string, signal?: AbortSignal): Promise<string | null> => {
    const listed = await command(local.root, ["for-each-ref", "--format=%(objectname)", ref], signal);
    if (listed === "") return null;
    if (listed.includes("\n")) throw new Error("The review reference is not unique.");
    return requireSha(listed);
  };
  const pin = async (local: LocalRepository, ref: string, sha: string, signal?: AbortSignal): Promise<void> => {
    const existing = await findRef(local, ref, signal);
    if (existing !== null) { if (existing !== sha) throw new Error("An immutable review reference does not match its captured commit."); return; }
    await git(local.root, ["update-ref", ref, sha, "0".repeat(sha.length)], signal);
  };
  const prepareWorktree = async (store: Store, local: LocalRepository, reviewId: string, proof: ProcessesExcluded, signal?: AbortSignal): Promise<PreparedWorktree | { kind: "changed" }> => {
    if (proof.processesExcluded !== true) throw new Error("Previous agent processes must be excluded before worktree preparation.");
    requireUuid(reviewId);
    await validateStoredRepository(store, local);
    let { review, pullRequest } = currentPreparation(store, local, reviewId);
    const fresh = await refresh(store, local, review.number, signal);
    if (!eligible(review, fresh)) return { kind: "changed" };
    const before = await inspectOwned(local, fresh, signal);
    if (review.baseSha === null) {
      const existingHead = await findRef(local, privateRef(review, "head"), signal);
      const existingBase = await findRef(local, privateRef(review, "base"), signal);
      if (existingHead !== null && existingHead !== review.headSha) throw new Error("The immutable head reference does not match this review.");
      let baseSha = existingBase;
      if (baseSha === null) {
        await git(local.root, ["check-ref-format", `refs/heads/${review.baseRef}`], signal);
        const shallow = await command(local.root, ["rev-parse", "--is-shallow-repository"], signal);
        const headRef = `refs/daynight/incoming/${review.id}/head`;
        const baseRef = `refs/daynight/incoming/${review.id}/base`;
        await run(["-C", local.root, "fetch", "--atomic", "--no-recurse-submodules", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--refmap=", ...(shallow === "true" ? ["--unshallow"] : []), "--", `https://${local.configuration.host}/${local.configuration.owner}/${local.configuration.name}.git`, `+refs/pull/${review.number}/head:${headRef}`, `+refs/heads/${review.baseRef}:${baseRef}`], signal, local.configuration.host);
        const fetchedHead = requireSha(await command(local.root, ["rev-parse", `${headRef}^{commit}`], signal));
        baseSha = requireSha(await command(local.root, ["rev-parse", `${baseRef}^{commit}`], signal));
        const observed = await refresh(store, local, review.number, signal);
        if (!eligible(review, observed) || fetchedHead !== review.headSha) return { kind: "changed" };
      }
      ({ review, pullRequest } = currentPreparation(store, local, reviewId));
      await pin(local, privateRef(review, "head"), requireSha(review.headSha), signal);
      await pin(local, privateRef(review, "base"), baseSha, signal);
      review = store.pinReviewBase(review.id, baseSha, now());
    }
    const headSha = requireSha(review.headSha);
    const baseSha = requireSha(review.baseSha!);
    await pin(local, privateRef(review, "head"), headSha, signal);
    await pin(local, privateRef(review, "base"), baseSha, signal);
    const mergeBases = (await command(local.root, ["merge-base", "--all", headSha, baseSha], signal)).split(/\r?\n/).map(requireSha).sort();
    const previousMergeBase = await findRef(local, privateRef(review, "merge-base"), signal);
    const mergeBaseSha = previousMergeBase === null ? mergeBases[0]! : previousMergeBase;
    if (!mergeBases.includes(mergeBaseSha)) throw new Error("The pinned merge base no longer matches the captured commits.");
    await pin(local, privateRef(review, "merge-base"), mergeBaseSha, signal);
    if (!eligible(review, await refresh(store, local, review.number, signal))) return { kind: "changed" };
    ({ review, pullRequest } = currentPreparation(store, local, reviewId));
    let owned = await inspectOwned(local, pullRequest, signal);
    if (owned.target !== before.target) throw new Error("The managed worktree destination changed during preparation.");
    if (owned.entry === null) {
      if (!(await ordinaryDirectory(path.dirname(owned.target)))) await mkdir(path.dirname(owned.target));
      currentPreparation(store, local, reviewId);
      store.registerWorktree(pullRequest, owned.target);
      await git(local.root, ["worktree", "add", "--detach", "--lock", "--reason", `daynight:${pullRequest.sessionId}`, "--", owned.target, headSha], signal);
    } else if (!owned.exists) {
      currentPreparation(store, local, reviewId);
      await git(local.root, ["worktree", "remove", "--force", "--force", "--", owned.target], signal);
      currentPreparation(store, local, reviewId);
      await git(local.root, ["worktree", "add", "--detach", "--lock", "--reason", `daynight:${pullRequest.sessionId}`, "--", owned.target, headSha], signal);
    } else if (review.attemptCount === 0) {
      currentPreparation(store, local, reviewId);
      await emptyTrackedSubmodules(owned, signal);
      currentPreparation(store, local, reviewId);
      owned = await inspectOwned(local, pullRequest, signal);
      await ownedGit(owned, ["read-tree", "--empty"], signal);
      currentPreparation(store, local, reviewId);
      owned = await inspectOwned(local, pullRequest, signal);
      await ownedGit(owned, ["read-tree", "--reset", "-u", "--no-sparse-checkout", headSha], signal);
      currentPreparation(store, local, reviewId);
      owned = await inspectOwned(local, pullRequest, signal);
      await ownedGit(owned, ["checkout", "--detach", "--force", headSha], signal);
      currentPreparation(store, local, reviewId);
      owned = await inspectOwned(local, pullRequest, signal);
      currentPreparation(store, local, reviewId);
      await emptyTrackedSubmodules(owned, signal);
      currentPreparation(store, local, reviewId);
      owned = await inspectOwned(local, pullRequest, signal);
      await ownedGit(owned, ["clean", "-ffdx"], signal);
    }
    owned = await inspectOwned(local, store.getPullRequest(pullRequest)!, signal);
    const actualHead = (await ownedGit(owned, ["rev-parse", "HEAD"], signal)).replace(/\r?\n$/, "");
    const symbolicHead = (await ownedGit(owned, ["rev-parse", "--symbolic-full-name", "HEAD"], signal)).replace(/\r?\n$/, "");
    if (review.attemptCount === 0 && (actualHead !== headSha || symbolicHead !== "HEAD")) throw new Error("The prepared worktree is not detached at the captured PR head.");
    return { kind: "prepared", path: owned.target, headSha, baseSha, mergeBaseSha, gitEnvironment: { ...(await gitContext()).gitEnvironment } };
  };
  const cleanupWorktree = async (store: Store, local: LocalRepository, identity: PullRequestIdentity, proof: ProcessesExcluded & OperationsStopped, signal?: AbortSignal): Promise<{ kind: "cleaned" | "reopened" }> => {
    if (proof.operationsStopped !== true || proof.processesExcluded !== true) throw new Error("Stopped operations and excluded agent processes are required for cleanup.");
    const requireCleanup = (): PullRequestState => {
      if (identity.host !== local.repository.host || identity.githubId !== local.repository.githubId) throw new Error("Cleanup identity belongs to a different repository.");
      const pr = store.getPullRequest(identity);
      if (pr === null || !pr.cleanupPending || pr.worktreePath === null) throw new Error("The PR has no unresolved worktree cleanup.");
      if (store.listActiveReviews().some((review) => review.host === pr.host && review.githubId === pr.githubId && review.number === pr.number)) throw new Error("An active review blocks worktree cleanup.");
      return pr;
    };
    await validateStoredRepository(store, local);
    const initial = requireCleanup();
    const cancelReopened = (): boolean => {
      const current = requireCleanup();
      if (current.state !== "open") return false;
      store.cancelCleanup(identity, current.worktreePath!, proof);
      return true;
    };
    try {
      await refresh(store, local, identity.number, signal);
      if (cancelReopened()) return { kind: "reopened" };
      const pr = requireCleanup();
      const owned = await inspectOwned(local, pr, signal);
      if (cancelReopened()) return { kind: "reopened" };
      if (owned.entry !== null) await git(local.root, ["worktree", "remove", "--force", "--force", "--", owned.target], signal);
      else if (owned.exists) throw new Error("An unregistered worktree cannot be removed.");
      if (cancelReopened()) return { kind: "reopened" };
      requireCleanup();
      store.completeCleanup(identity, owned.target, proof);
      return { kind: "cleaned" };
    } catch (error) {
      try {
        const current = store.getPullRequest(identity);
        if (current !== null && current.cleanupPending && current.worktreePath === initial.worktreePath) {
          store.recordCleanupError(identity, initial.worktreePath!, error instanceof Error ? error.message : String(error));
        }
      } catch (recordingError) {
        throw new AggregateError([error, recordingError], "Worktree cleanup failed and its error could not be recorded.", { cause: error });
      }
      throw error;
    }
  };
  return { ensureRepository, prepareWorktree, cleanupWorktree };
};
