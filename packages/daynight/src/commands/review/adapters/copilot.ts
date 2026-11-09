import path from "node:path";
import { lstat, mkdir, mkdtemp, open } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { remoteIdentity } from "../config.js";
import { reviewPublicationIdentity } from "../publication.js";
import type { PublicationIdentityFormat } from "../publication.js";
import { isolatedGitEnvironment } from "./worktrees.js";
import type { PreparedWorktree } from "./worktrees.js";
import type { ReviewPaths } from "../paths.js";
import type { Store } from "../store.js";
import type { AttemptIdentity, ProcessesExcluded, ReviewState } from "../model.js";
import { validateReviewSkillDiscovery } from "../skill.js";
import type { PreparedReviewSkill } from "../skill.js";
import { spawnWindowsReviewPhase } from "../windows-phase.js";
import type { WindowsReviewPhase } from "../windows-phase.js";

export type PreviousReview = Pick<ReviewState, "id" | "revision" | "headSha" | "baseRef">;
export type CopilotProcessOutcome = {
  directProcessClosed: boolean;
  captureComplete: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  interruption: "aborted" | "timeout" | null;
  launchFailure: "command-not-found" | null;
};
export type CopilotAttemptOutcome = CopilotProcessOutcome & {
  attempt: AttemptIdentity;
  sessionId: string;
  sessionMode: "create" | "resume";
  stdoutLogPath: string;
  stderrLogPath: string;
  completed: boolean;
  processExclusionFailure: Error | null;
  lastNonemptyLine: string | null;
  errors: Error[];
};
export type CopilotRunnerOptions = {
  skill: PreparedReviewSkill;
  paths: ReviewPaths;
  processOwner: string;
  timeoutMs: number;
  model?: string;
  reasoningEffort?: string;
  terminationGraceMs?: number;
  maxLineCharacters?: number;
  maxDiscoveryBytes?: number;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
  command?: { file: string; args?: readonly string[] };
};
export type CopilotRunOptions = {
  publisherId: string;
  publicationIdentityFormat: PublicationIdentityFormat;
  excludeProcess: (review: ReviewState, outcome: CopilotProcessOutcome) => Promise<ProcessesExcluded>;
  signal?: AbortSignal;
  previousReview?: PreviousReview;
  onProcess?: (child: ChildProcess, attempt: AttemptIdentity) => void;
  stopProcess?: (child: ChildProcess, attempt: AttemptIdentity) => Promise<void>;
};

const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));
const positiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`${name} must be a positive integer no greater than 2147483647.`);
};
const sessionExists = async (directory: string): Promise<boolean> => {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Copilot session history ${directory} must be a directory.`);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const reviewPrompt = (review: ReviewState, worktree: PreparedWorktree, repository: { owner: string; name: string }, skill: PreparedReviewSkill, publisherId: string, publicationIdentityFormat: PublicationIdentityFormat, previous?: PreviousReview): string => `You are the Copilot code review agent for daynight.
Before reviewing, explicitly invoke /daynight-review and load the CURRENT immutable skill snapshot from ${JSON.stringify(skill.entrypoint)} (digest ${skill.digest}). Load this exact current path even when resumed conversation history already contains an older skill with the same name. Complete the native skill invocation before beginning the review.
Use the native subagents required by the loaded skill. Complete its delegation and synthesis before fresh publication, including submission of a pending draft; confirming a valid matching submitted result still completes immediately without delegation.
Daynight skill bundle: ${JSON.stringify({ name: skill.name, digest: skill.digest, entrypoint: skill.entrypoint })}
Review this immutable target:
${JSON.stringify({ host: review.host, repositoryId: review.githubId, repository: `${repository.owner}/${repository.name}`, pullRequest: review.number,
  reviewId: review.id, revision: review.revision, headSha: review.headSha, baseBranch: review.baseRef, baseSha: worktree.baseSha, mergeBaseSha: worktree.mergeBaseSha })}
The worktree is already prepared. Its Git environment exposes the original commit objects and a complete checkout.
${previous === undefined ? "" : `A previous unfinished review may have published results: ${JSON.stringify(previous)}. Reconcile its existing effects; do not publish a review for its obsolete target merely to confirm it.\n`}This attempt may follow an interrupted or incomplete attempt of this same review. Before reviewing or publishing, inspect the PR's existing reviews and native review threads for the stable identity below, bound to this target commit and the captured publishing actor below. Confirm a matching existing APPROVED review immediately without re-evaluating later title or description edits, changing that approval, or publishing again. Confirm a matching existing COMMENTED review only when it owns at least one real resolvable native review thread; its unresolved threads do not block this same-round confirmation. Do not duplicate reviews, comments or replies. If a matching PENDING review exists, revalidate its unsent findings and reuse its ID and threads when still justified. If an owned draft is obsolete or its findings no longer apply, re-GET that exact numeric review ID and verify its author, exact stable identity, commit and PENDING state immediately before deleting only that draft with DELETE reviews/{review_id}; then publish the correct current result. Never delete a submitted APPROVED or COMMENTED review, and never submit findings for an obsolete target. If no valid matching result exists, complete a fresh review using the current title and description.
Stable review identity: ${reviewPublicationIdentity(review)}
Captured publishing actor node ID: ${JSON.stringify(publisherId)}
Existing publication identity format: ${JSON.stringify(publicationIdentityFormat)}
${publicationIdentityFormat === "legacy" ? "This migrated unfinished round permits legacy matching only to recover an already existing publication: the exact supplied stable identity token may be embedded in its historical prefix or prose. Require token boundaries so a longer identity cannot match, and retain the captured actor and commit checks. This recovery permission does not change the required format of new publication bodies." : "Recognize an existing publication only when the supplied stable identity is its own exact body line or an entire HTML-comment line; a token embedded in other prose is insufficient."}
Before creating, submitting or deleting a review or thread, query the authenticated GitHub viewer node ID and require it to equal this captured publisher ID. If it differs, report the account mismatch and do not publish under another identity. Read-only confirmation of the captured publisher's existing valid result remains valid.
Publish the review yourself using gh api. Immediately before publication or retry confirmation re-read the PR and require it to be Open, non-Draft, with head SHA ${review.headSha} and base branch ${JSON.stringify(review.baseRef)}. Before starting a new publication also re-evaluate the skill's PR-quality gates against its current title and description and require no unresolved submitted native review conversations. Positively identified PENDING draft threads are not submitted conversations. A matching pending review's own threads do not block finishing that publication. If it is stale, closed, Draft, inaccessible, or publication fails, explain the problem and do not output the completion marker.
Use POST repos/${repository.owner}/${repository.name}/pulls/${review.number}/reviews on host ${review.host}. Explicitly set commit_id to ${review.headSha} and include the stable review identity as its own exact line in the review body, preferably inside an HTML comment. Use English and identify yourself as Copilot in published text.
A successful review must publish either APPROVE or a COMMENT review owning at least one real resolvable native review thread. Publish code defects and localized out-of-scope changes on the relevant changed lines. For a description or PR-wide scope blocker, use a native file-level thread on the principal changed file, explicitly label it as a PR-wide description/scope issue, and do not invent a code defect or line. A top-level review body alone is insufficient. For a file-level blocker, POST the review with commit_id and the stable body but OMIT event to create a pending review; retain its numeric id and node_id. Add its file thread with the GraphQL addPullRequestReviewThread mutation using pullRequestReviewId=node_id, path=the actual changed file, subjectType=FILE and body, without line or side. Then POST reviews/{numeric_id}/events with event=COMMENT and the stable body. Reuse an existing matching, still-justified pending review and its already-created threads after interruption. Do not add subject_type to the batch reviews.comments payload; that API does not support file subjects. If no truthful changed-file anchor exists, or a required thread cannot be published, explain the operational failure and do not output the completion marker. Never submit REQUEST_CHANGES. Publish APPROVE only when both PR-quality gates pass and no Critical or Major defect remains. Verify the review event, target commit, reviewing actor, stable identity and, for COMMENT, at least one owned native thread before claiming success. Do not treat an existing COMMENT as evidence of approval, and do not claim success when you cannot approve your own PR.
The repository and worktree are dedicated to this review system. Worktree creation, reset and cleanup belong to daynight; do not perform those lifecycle operations. Keep supplementary clones and temporary resources under the supplied temporary directory.
Run all tools in the foreground, await and reap them, and stop every service or other tool you started before returning. Do not leave background or detached processes running.
After the required review result has been published or confirmed, finish stdout with exactly this standalone line, with no text after it:
PR ${review.number} Review Completed
`;

class LastLine extends Transform {
  readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  readonly limit: number;
  line = "";
  overflow = false;
  lastNonempty: string | null = null;
  constructor(limit: number) { super(); this.limit = limit; }
  accept(text: string): void {
    for (const piece of text.split(/(?<=\n)/)) {
      const newline = piece.endsWith("\n");
      const content = newline ? piece.slice(0, -1) : piece;
      if (this.line.length + content.length > this.limit) this.overflow = true;
      if (!this.overflow) this.line += content;
      if (newline) {
        const value = this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line;
        if (this.overflow || value.length !== 0) this.lastNonempty = this.overflow ? null : value;
        this.line = ""; this.overflow = false;
      }
    }
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    try { this.accept(this.decoder.decode(chunk, { stream: true })); callback(null, chunk); } catch (error) { callback(asError(error)); }
  }
  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.accept(this.decoder.decode());
      if (this.overflow || this.line.length !== 0) this.lastNonempty = this.overflow ? null : this.line;
      callback();
    } catch (error) { callback(asError(error)); }
  }
}

class DiscoveryOutput extends Transform {
  readonly limit: number;
  readonly chunks: Buffer[] = [];
  length = 0;
  overflow = false;
  constructor(limit: number) { super(); this.limit = limit; }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    if (!this.overflow) {
      this.length += chunk.length;
      if (this.length > this.limit) { this.overflow = true; this.chunks.length = 0; }
      else this.chunks.push(Buffer.from(chunk));
    }
    callback(null, chunk);
  }
  text(): string {
    if (this.overflow) throw new Error(`Copilot skill discovery output exceeded ${this.limit} bytes.`);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(this.chunks));
  }
}

/** Runs one persisted attempt; the caller retains scheduling, final state transitions, and descendant-process exclusion. */
export const createCopilotRunner = (options: CopilotRunnerOptions) => {
  const now = options.now === undefined ? Date.now : options.now;
  const grace = options.terminationGraceMs === undefined ? 5_000 : options.terminationGraceMs;
  const lineLimit = options.maxLineCharacters === undefined ? 8_192 : options.maxLineCharacters;
  const discoveryLimit = options.maxDiscoveryBytes === undefined ? 1_048_576 : options.maxDiscoveryBytes;
  positiveInteger(options.timeoutMs, "Copilot timeout"); positiveInteger(grace, "Termination grace");
  positiveInteger(lineLimit, "Line character limit"); positiveInteger(discoveryLimit, "Skill discovery byte limit");
  if (options.processOwner.trim() === "") throw new Error("Copilot process owner must be nonempty.");

  const run = async (store: Store, reviewId: string, worktree: PreparedWorktree, input: CopilotRunOptions): Promise<CopilotAttemptOutcome> => {
    input.signal?.throwIfAborted();
    if (input.publisherId.trim() === "") throw new Error("The captured review publisher ID must be nonempty.");
    if (input.publicationIdentityFormat !== "line" && input.publicationIdentityFormat !== "legacy") throw new Error("The publication identity format must be line or legacy.");
    const review = store.getReview(reviewId);
    if (review === null) throw new Error("The Copilot review does not exist.");
    const pr = store.getPullRequest(review);
    const repository = store.getRepository(review);
    if (pr === null || repository === null || pr.sessionId === null || pr.worktreePath !== worktree.path || review.headSha !== worktree.headSha || review.baseSha !== worktree.baseSha) throw new Error("The prepared Copilot target does not match persisted review state.");
    const coordinate = remoteIdentity(repository.remote, "Review repository remote");
    const sessionDirectory = path.join(options.paths.copilotDirectory, "session-state", pr.sessionId);
    const existing = await sessionExists(sessionDirectory);
    if (pr.sessionEstablished && !existing) throw new Error(`Established Copilot session ${pr.sessionId} is missing its history at ${sessionDirectory}.`);
    if (existing && !pr.sessionEstablished) store.markSessionEstablished(pr);
    const mode = existing ? "resume" : "create";
    const reviewLogs = path.join(options.paths.logsDirectory, review.id);
    await Promise.all([options.paths.copilotDirectory, options.paths.cacheDirectory, options.paths.temporaryDirectory, reviewLogs].map((directory) => mkdir(directory, { recursive: true })));
    const attemptDirectory = await mkdtemp(path.join(reviewLogs, `${review.attemptCount + 1}-`));
    const stdoutLogPath = path.join(attemptDirectory, "stdout.log");
    const stderrLogPath = path.join(attemptDirectory, "stderr.log");
    const stdoutFile = await open(stdoutLogPath, "wx", 0o600);
    let stderrFile;
    try { stderrFile = await open(stderrLogPath, "wx", 0o600); } catch (error) { await stdoutFile.close(); throw error; }
    let launched: ReviewState;
    try {
      input.signal?.throwIfAborted();
      launched = store.startAttempt(review.id, { processOwner: options.processOwner, stdoutLogPath, stderrLogPath }, now());
    } catch (error) { await Promise.all([stdoutFile.close(), stderrFile.close()]); throw error; }
    const deadline = performance.now() + options.timeoutMs;
    const attempt = { reviewId: review.id, attempt: launched.attemptCount };
    const errors: Error[] = [];
    const outcome: CopilotAttemptOutcome = { attempt, sessionId: pr.sessionId, sessionMode: mode, stdoutLogPath, stderrLogPath,
      completed: false, directProcessClosed: true, captureComplete: true, exitCode: null, signal: null, lastNonemptyLine: null,
      interruption: null, launchFailure: null, processExclusionFailure: null, errors };
    const parentEnvironment = options.environment === undefined ? process.env : options.environment;
    const environment: NodeJS.ProcessEnv = { ...parentEnvironment, ...isolatedGitEnvironment(parentEnvironment, worktree.gitEnvironment),
      COPILOT_HOME: options.paths.copilotDirectory, COPILOT_CACHE_HOME: options.paths.cacheDirectory,
      TMPDIR: options.paths.temporaryDirectory, TMP: options.paths.temporaryDirectory, TEMP: options.paths.temporaryDirectory,
      NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GH_FORCE_TTY: "", PAGER: "cat", GH_PAGER: "cat" };
    delete environment.GH_DEBUG;
    for (const name of Object.keys(environment)) if (name.toUpperCase() === "COPILOT_SKILLS_DIRS") delete environment[name];
    const commandFile = options.command === undefined ? "copilot" : options.command.file;
    const prefix = [...(options.command?.args === undefined ? [] : options.command.args), "-C", worktree.path, `--plugin-dir=${options.skill.rootDirectory}`];
    const interrupted = (): boolean => {
      if (input.signal?.aborted) outcome.interruption = "aborted";
      else if (performance.now() >= deadline) outcome.interruption = "timeout";
      return outcome.interruption !== null;
    };
    const runPhase = async (phase: "skill-list" | "review", args: string[], output: Transform, files: [Awaited<ReturnType<typeof open>>, Awaited<ReturnType<typeof open>>], prompt?: string): Promise<void> => {
      outcome.directProcessClosed = false; outcome.captureComplete = false; outcome.exitCode = null; outcome.signal = null; outcome.launchFailure = null;
      let child;
      let windowsPhase: WindowsReviewPhase | undefined;
      try {
        if (process.platform === "win32") {
          windowsPhase = spawnWindowsReviewPhase({ file: commandFile, args, cwd: worktree.path, environment, deadline, graceMs: grace });
          child = windowsPhase.child;
        } else child = crossSpawn(commandFile, args, { cwd: worktree.path, env: environment, shell: false, windowsHide: true, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      }
      catch (error) { errors.push(asError(error)); await Promise.all(files.map((file) => file.close())); outcome.directProcessClosed = true; return; }
      let timeout: NodeJS.Timeout | undefined;
      let force: NodeJS.Timeout | undefined;
      let abandon: NodeJS.Timeout | undefined;
      let stopped = false;
      let resolveClose: () => void;
      const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
      const stop = (): void => {
        if (stopped || outcome.directProcessClosed || outcome.launchFailure !== null) return;
        stopped = true;
        if (windowsPhase !== undefined || input.stopProcess !== undefined && child.pid !== undefined) {
          const stopping = input.stopProcess !== undefined && child.pid !== undefined ? input.stopProcess(child, attempt) : windowsPhase!.stop();
          void stopping.catch((error: unknown) => { errors.push(asError(error)); }).finally(() => {
            if (!outcome.directProcessClosed) {
              errors.push(new Error("Copilot termination could not confirm its direct process and streams closed; retained state requires operator recovery."));
              child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy(); resolveClose();
            }
          });
          return;
        }
        child.kill("SIGTERM");
        force = setTimeout(() => {
          child.kill("SIGKILL");
          abandon = setTimeout(() => {
            errors.push(new Error("Copilot did not close its process and streams within the termination grace period; descendant processes must be excluded before reuse."));
            child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy(); resolveClose();
          }, grace);
        }, grace);
      };
      child.once("error", (error) => {
        errors.push(error);
        const failed = error as Error & { code?: unknown; syscall?: unknown; path?: unknown; spawnargs?: unknown; errno?: unknown };
        // cross-spawn reports an unresolved Windows command when its cmd.exe wrapper exits.
        // https://github.com/moxystudio/node-cross-spawn/blob/77cd97f3ca7b62c904a63a698fc4a79bf41977d0/lib/enoent.js#L6
        if (failed.code === "ENOENT" && failed.syscall === `spawn ${commandFile}` && failed.path === commandFile &&
          (child.pid === undefined || (process.platform === "win32" && failed.errno === "ENOENT" && Array.isArray(failed.spawnargs) &&
            failed.spawnargs.length === args.length && failed.spawnargs.every((argument, index) => argument === args[index])))) outcome.launchFailure = "command-not-found";
        else stop();
      });
      child.once("spawn", () => {
        try {
          store.recordProcess(attempt, { pid: child.pid!, identity: `${options.processOwner}:${review.id}:${attempt.attempt}:${phase}` });
          input.onProcess?.(child, attempt);
        } catch (error) { errors.push(asError(error)); stop(); }
      });
      const observeClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        outcome.directProcessClosed = true;
        if (windowsPhase === undefined) { outcome.exitCode = code; outcome.signal = signal; }
        else if (windowsPhase.result !== undefined) {
          const receipt = windowsPhase.result;
          outcome.exitCode = receipt.code; outcome.signal = receipt.signal;
          if (receipt.failure !== null) {
            errors.push(new Error(receipt.failure.message));
            if (receipt.failure.missing) outcome.launchFailure = "command-not-found";
          }
        } else if (!stopped) errors.push(new Error("Windows review guardian closed without the target command's result."));
        resolveClose();
      };
      if (windowsPhase === undefined) child.once("close", observeClose);
      else void windowsPhase.closed.then(() => observeClose(child.exitCode, child.signalCode));
      const abort = (): void => { outcome.interruption = "aborted"; stop(); };
      input.signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => { outcome.interruption = "timeout"; stop(); }, Math.max(0, deadline - performance.now()));
      const capture = async (operation: Promise<void>, promptInput = false): Promise<boolean> => {
        try { await operation; return true; } catch (error) {
          errors.push(asError(error));
          // A wrapper can close its input before cross-spawn reports that the command was not found.
          // The process close or configured timeout still bounds a failed prompt delivery.
          if (!promptInput) stop();
          return false;
        }
      };
      const outputs = [capture(pipeline(child.stdout!, output, files[0].createWriteStream())), capture(pipeline(child.stderr!, files[1].createWriteStream())),
        capture(pipeline(Readable.from(prompt === undefined ? [] : [prompt]), child.stdin!), true)];
      if (input.signal?.aborted) abort();
      if (windowsPhase !== undefined) {
        try { await windowsPhase.start(); } catch (error) { errors.push(asError(error)); stop(); }
      }
      await closed;
      if (timeout !== undefined) clearTimeout(timeout);
      if (force !== undefined) clearTimeout(force);
      if (abandon !== undefined) clearTimeout(abandon);
      input.signal?.removeEventListener("abort", abort);
      if (windowsPhase !== undefined) {
        try { await windowsPhase.stop(); }
        catch (error) { outcome.processExclusionFailure = asError(error); errors.push(outcome.processExclusionFailure); }
      }
      outcome.captureComplete = (await Promise.all(outputs)).every(Boolean);
    };
    let mainStarted = false;
    try {
      const discovery = new DiscoveryOutput(discoveryLimit);
      const discoveryStdout = await open(path.join(attemptDirectory, "skill-list.stdout.log"), "wx", 0o600);
      let discoveryStderr;
      try { discoveryStderr = await open(path.join(attemptDirectory, "skill-list.stderr.log"), "wx", 0o600); }
      catch (error) { await discoveryStdout.close(); throw error; }
      if (interrupted()) { await Promise.all([discoveryStdout.close(), discoveryStderr.close()]); return outcome; }
      await runPhase("skill-list", [...prefix, "--no-auto-update", "skill", "list", "--json"], discovery, [discoveryStdout, discoveryStderr]);
      if (outcome.processExclusionFailure !== null) return outcome;
      const current = store.getReview(review.id)!;
      try {
        const { directProcessClosed, captureComplete, exitCode, signal, interruption, launchFailure } = outcome;
        const proof = await input.excludeProcess(current, { directProcessClosed, captureComplete, exitCode, signal, interruption, launchFailure });
        store.clearProcess(attempt, { processId: current.processId, processIdentity: current.processIdentity }, proof);
      } catch (error) { outcome.processExclusionFailure = asError(error); errors.push(outcome.processExclusionFailure); return outcome; }
      if (interrupted() || !outcome.directProcessClosed || !outcome.captureComplete || errors.length !== 0) return outcome;
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        errors.push(new Error(`Copilot skill discovery exited with code ${outcome.exitCode} and signal ${outcome.signal}.`)); return outcome;
      }
      try { await validateReviewSkillDiscovery(discovery.text(), options.skill); }
      catch (error) { errors.push(asError(error)); return outcome; }
      if (interrupted()) return outcome;
      const parser = new LastLine(lineLimit);
      mainStarted = true;
      await runPhase("review", [...prefix, `--${mode === "resume" ? "resume" : "session-id"}=${pr.sessionId}`, "-s", "--output-format", "text", "--stream", "on", "--no-color",
        "--no-ask-user", "--no-auto-update", "--allow-all-tools", "--log-dir", attemptDirectory,
        ...(options.model === undefined ? [] : ["--model", options.model]),
        ...(options.reasoningEffort === undefined ? [] : ["--reasoning-effort", options.reasoningEffort])], parser, [stdoutFile, stderrFile], reviewPrompt(launched, worktree, coordinate, options.skill, input.publisherId, input.publicationIdentityFormat, input.previousReview));
      outcome.lastNonemptyLine = parser.lastNonempty;
      try {
        if (await sessionExists(sessionDirectory)) store.markSessionEstablished(pr);
        else errors.push(new Error(`Copilot session ${pr.sessionId} did not retain its history at ${sessionDirectory}.`));
      } catch (error) { errors.push(asError(error)); }
      outcome.completed = outcome.directProcessClosed && outcome.captureComplete && errors.length === 0 && outcome.interruption === null && outcome.exitCode === 0 && outcome.signal === null && outcome.lastNonemptyLine === `PR ${review.number} Review Completed`;
      return outcome;
    } finally { if (!mainStarted) await Promise.all([stdoutFile.close(), stderrFile.close()]); }
  };
  return { run };
};
