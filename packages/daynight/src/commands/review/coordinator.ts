import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ReviewConfiguration, RepositoryConfiguration } from "./config.js";
import type { CopilotAttemptOutcome, CopilotProcessOutcome, CopilotRunOptions, createCopilotRunner } from "./adapters/copilot.js";
import { GitCommandError } from "./adapters/worktrees.js";
import type { LocalRepository, createGitManager } from "./adapters/worktrees.js";
import { GitHubApiError } from "./adapters/github.js";
import { findReviewPublication, findLegacyReviewPublication, hasOpenReviewConversations, hasPendingReviewPublication, findLegacyReviewPublisher } from "./publication.js";
import { pollRepository } from "./polling.js";
import type { GitHubClient } from "./adapters/github.js";
import type { Store } from "./store.js";
import type { AttemptIdentity, OperationsStopped, ProcessesExcluded, PullRequestIdentity, PullRequestState, ReviewCandidate, ReviewState, PullRequestReviewSnapshot } from "./model.js";
import { remoteIdentity } from "./config.js";
import type { AssignedPullRequest, AssignmentSource, PromptCapture } from "./assignment.js";
import { OwnedCommandCleanupError, hasUnconfirmedOwnedCommandCleanup } from "../worker/owned-command.js";

export type CoordinatorEvent = {
  level: "info" | "error";
  phase: string;
  message: string;
  repository?: string;
  number?: number;
  reviewId?: string;
  revision?: number;
  attempt?: number;
  retryAt?: number;
  error?: unknown;
};
export type CoordinatorProcesses = {
  onProcess: (child: ChildProcess, attempt: AttemptIdentity) => void;
  stop: (child: ChildProcess, attempt: AttemptIdentity) => Promise<void>;
  exclude: (review: ReviewState, outcome?: CopilotProcessOutcome) => Promise<ProcessesExcluded>;
  recover: (review?: ReviewState) => Promise<ProcessesExcluded & OperationsStopped>;
};
export type CoordinatorOptions = {
  configuration: ReviewConfiguration;
  store: Store;
  client: GitHubClient;
  git: ReturnType<typeof createGitManager>;
  runner: Pick<ReturnType<typeof createCopilotRunner>, "run">;
  processes: CoordinatorProcesses;
  signal: AbortSignal;
  log: (event: CoordinatorEvent) => void;
  now?: () => number;
  assignment?: { source: AssignmentSource; repositoryDirectory: string };
};

type RepositoryWork = { configuration: RepositoryConfiguration; local: LocalRepository | null; polling: boolean; nextPollAt: number; blocked: boolean; expectedId?: string; pendingConfiguration?: RepositoryConfiguration };
type Reservation = { kind: "review" | "cleanup" | "verification"; controller: AbortController; reviewId?: string };
type CheckAdmission = { target: string; checking: boolean; ready: boolean; nextCheckAt: number; reported: boolean };
const key = (identity: PullRequestIdentity): string => JSON.stringify([identity.host, identity.githubId, identity.number]);
const target = (pr: PullRequestState): string => JSON.stringify([pr.desiredRevision, pr.headSha, pr.baseRef]);
const repositoryKey = (identity: { host: string; githubId: string }): string => JSON.stringify([identity.host, identity.githubId]);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isCurrent = (review: ReviewState, pr: PullRequestState): boolean => pr.state === "open" && !pr.draft && !pr.cleanupPending &&
  review.revision === pr.desiredRevision && review.headSha === pr.headSha && review.baseRef === pr.baseRef;
const uncertainGit = (error: unknown): boolean => {
  if (error instanceof GitCommandError && !error.completed) return true;
  if (error instanceof AggregateError && error.errors.some(uncertainGit)) return true;
  return error instanceof Error && error.cause !== undefined && uncertainGit(error.cause);
};
const stopped = { operationsStopped: true } as const;
const excluded = { processesExcluded: true } as const;
const retryDelay = (configuration: ReviewConfiguration, attempts: number): number => Math.min(600_000, configuration.retryDelayMs * 2 ** Math.min(30, Math.max(0, attempts - 1)));
const ownedCleanupOnly = (error: unknown): boolean => error instanceof OwnedCommandCleanupError ||
  error instanceof AggregateError && error.errors.length > 0 && error.errors.every(ownedCleanupOnly) &&
    (error.cause === undefined || ownedCleanupOnly(error.cause));

/** Owns one foreground scheduling lifetime; dependencies retain command and process ownership. */
export const runCoordinator = async (options: CoordinatorOptions): Promise<{ safeToReleaseLock: boolean }> => {
  const { configuration, store, client, git, runner, processes, log } = options;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const now = options.now === undefined ? Date.now : options.now;
  const repositories: RepositoryWork[] = configuration.repositories.map((item) => ({ configuration: item, local: null, polling: false, nextPollAt: 0, blocked: false }));
  const localRepositories = new Map<string, RepositoryWork>();
  const reservations = new Map<string, Reservation>();
  const blocked = new Set<string>();
  const cleanupRetryAt = new Map<string, number>();
  const verificationRetryAt = new Map<string, number>();
  const waiting = new Map<string, ReviewCandidate>();
  const checkAdmissions = new Map<string, CheckAdmission>();
  const promptAdmissions = new Map<string, { target: string; projectId: string; checking: boolean; capture?: PromptCapture; nextCheckAt: number }>();
  const pending = new Set<Promise<void>>();
  let workers = 0;
  let safeToReleaseLock = true;
  let permanentUncertainty = false;
  const ownedCleanupFailures: unknown[] = [];
  let wake: (() => void) | undefined;
  const notify = (): void => { wake?.(); };
  const selectedAssignment = (pr: PullRequestIdentity): AssignedPullRequest | undefined => {
    const observation = options.assignment?.source.snapshot();
    if (observation?.kind !== "enabled") return undefined;
    return observation.pullRequests.filter(item => item.repositoryId === pr.githubId && item.number === pr.number &&
      remoteIdentity(item.repositoryUrl, "Assigned repository").host === pr.host).sort((a, b) => a.projectId.localeCompare(b.projectId))[0];
  };
  const currentCapture = (pr: PullRequestIdentity, projectId: string, capture: PromptCapture): boolean =>
    selectedAssignment(pr)?.projectId === projectId && capture.isCurrent();
  const synchronizeAssignments = (): void => {
    const assignment = options.assignment;
    if (assignment === undefined) return;
    const observation = assignment.source.snapshot();
    if (observation.kind !== "unavailable") {
      for (const [prKey, reservation] of reservations) if (reservation.kind === "review" && reservation.reviewId !== undefined) {
        const review = store.getReview(reservation.reviewId);
        if (review !== null && selectedAssignment(review) === undefined) reservation.controller.abort(new Error("Reviewer assignment was withdrawn."));
      }
    }
    if (observation.kind === "enabled") for (const item of observation.pullRequests) {
      const identity = remoteIdentity(item.repositoryUrl, "Assigned repository");
      const existing = repositories.find(repository => repository.expectedId === item.repositoryId && repository.configuration.host === identity.host);
      if (existing === undefined) repositories.push({ configuration: { ...identity, remote: item.repositoryUrl, path: path.join(assignment.repositoryDirectory, item.repositoryId) }, expectedId: item.repositoryId, local: null, polling: false, nextPollAt: 0, blocked: false });
      else if (existing.configuration.coordinate !== identity.coordinate) existing.pendingConfiguration = { ...identity, remote: item.repositoryUrl, path: existing.configuration.path };
    }
    for (const repository of repositories) if (!repository.polling) repository.nextPollAt = 0;
    notify();
  };
  if (options.assignment !== undefined) {
    for (const stored of store.listRepositories()) {
      const identity = remoteIdentity(stored.remote, "Retained repository");
      repositories.push({ configuration: { ...identity, remote: stored.remote, path: stored.localPath }, expectedId: stored.githubId, local: null, polling: false, nextPollAt: 0, blocked: false });
    }
    synchronizeAssignments();
  }
  const unsubscribe = options.assignment?.source.subscribe(synchronizeAssignments);
  const context = (review: ReviewState): Pick<CoordinatorEvent, "repository" | "number" | "reviewId" | "revision" | "attempt"> => {
    const repository = store.getRepository(review);
    return { repository: repository === null ? `${review.host}/${review.githubId}` : repository.remote, number: review.number,
      reviewId: review.id, revision: review.revision, attempt: review.attemptCount };
  };
  const report = (review: ReviewState, phase: string, text: string, error?: unknown, retryAt?: number): void => {
    log({ ...context(review), phase, message: text, level: error === undefined ? "info" : "error",
      ...(error === undefined ? {} : { error }), ...(retryAt === undefined ? {} : { retryAt }) });
  };
  const interrupt = (review: ReviewState, error: unknown): void => {
    blocked.add(key(review));
    safeToReleaseLock = false;
    if (ownedCleanupOnly(error)) ownedCleanupFailures.push(error);
    else permanentUncertainty = true;
    const current = store.getReview(review.id)!;
    if (current.status === "preparing" || current.status === "running" || current.status === "interrupted") store.markInterrupted(current.id, message(error), now());
    report(current, "interrupted", "The PR is blocked until its previous operations and processes are explicitly excluded.", error);
  };
  const track = (operation: () => Promise<void>, release: () => void): void => {
    const task = operation().catch((error: unknown) => {
      safeToReleaseLock = false;
      permanentUncertainty = true;
      log({ level: "error", phase: "coordinator", message: "An operation failed while recording its final state; retained state requires inspection.", error });
    }).finally(() => { release(); pending.delete(task); notify(); });
    pending.add(task);
  };
  const checksRetryAt = (error?: unknown): number => Math.max(now() + configuration.pollIntervalMs,
    error instanceof GitHubApiError && error.retryAt !== null ? error.retryAt : 0);
  const settlePriorApproval = (pr: PullRequestState, snapshot: PullRequestReviewSnapshot): boolean => {
    if (snapshot.state !== "open" || snapshot.draft || snapshot.headSha !== pr.headSha || snapshot.baseRef !== pr.baseRef) return false;
    const approved = store.listReviews(pr).some((review) => {
      if (review.headSha !== pr.headSha || review.baseRef !== pr.baseRef) return false;
      const publication = store.getReviewPublication(review.id);
      if (publication?.outcome === "approved") {
        const remote = snapshot.reviews.find((item) => item.id === publication.remoteReviewId && item.authorId === publication.publisherId);
        return remote !== undefined && publication.publisherId !== null &&
          findReviewPublication(review, { ...snapshot, reviews: [remote] }, publication.publisherId, publication.identityFormat)?.outcome === "approved";
      }
      if (publication?.phase !== "legacy") return false;
      const historical = findLegacyReviewPublication(review, snapshot);
      if (historical === null) return false;
      store.adoptHistoricalApproval(review.id, historical);
      return true;
    });
    return approved && store.settleApprovedTarget(pr, pr.headSha, pr.baseRef, stopped, now());
  };
  const publicationContext = (review: ReviewState | null, snapshot: PullRequestReviewSnapshot) => {
    let captured = review === null ? null : store.getReviewPublication(review.id);
    if (review !== null && captured?.identityFormat === "legacy" && captured.publisherId === null) {
      const historicalActor = findLegacyReviewPublisher(review, snapshot);
      if (historicalActor !== null) {
        store.adoptLegacyReviewPublisher(review.id, historicalActor);
        captured = store.getReviewPublication(review.id);
      }
    }
    const publisherId = captured === null || captured.publisherId === null ? snapshot.viewerId : captured.publisherId;
    const identityFormat = captured === null ? "line" as const : captured.identityFormat;
    const hasResult = review !== null && findReviewPublication(review, snapshot, publisherId, identityFormat) !== null;
    const sameRoundRecovery = hasResult || (review !== null && snapshot.viewerId === publisherId &&
      hasPendingReviewPublication(review, snapshot, publisherId, identityFormat));
    return { captured, publisherId, identityFormat, hasResult, sameRoundRecovery };
  };
  const checkCandidate = async (repository: RepositoryWork, pr: PullRequestState, admission: CheckAdmission): Promise<void> => {
    const prKey = key(pr);
    try {
      const [checks, snapshot] = await Promise.all([
        client.getPullRequestChecks(repository.local!.repository, pr.number, signal),
        client.getPullRequestReviewSnapshot(repository.local!.repository, pr.number, signal),
      ]);
      const candidate = waiting.get(prKey);
      if (signal.aborted || checkAdmissions.get(prKey) !== admission || candidate === undefined || target(candidate.pullRequest) !== admission.target) return;
      if (settlePriorApproval(pr, snapshot)) return;
      const { publisherId, hasResult, sameRoundRecovery } = publicationContext(candidate.review, snapshot);
      const actorReady = publisherId === snapshot.viewerId || hasResult;
      if (!actorReady && !admission.reported) log({ level: "error", phase: "publisher", repository: repository.configuration.coordinate,
        number: pr.number, revision: pr.desiredRevision, message: "The authenticated account differs from this round's captured publisher; review admission is waiting without consuming an agent attempt." });
      const ready = actorReady && checks.ready && checks.headSha === pr.headSha && checks.baseRef === pr.baseRef &&
        snapshot.state === "open" && !snapshot.draft && snapshot.headSha === pr.headSha && snapshot.baseRef === pr.baseRef &&
        (sameRoundRecovery || !hasOpenReviewConversations(snapshot));
      if (!admission.reported || admission.ready !== ready) log({ level: "info", phase: "ci", repository: repository.configuration.coordinate,
        number: pr.number, revision: pr.desiredRevision, message: ready ? "All CI checks passed for the waiting PR target." : "The PR is waiting for all CI checks to finish and pass." });
      admission.ready = ready;
      admission.reported = true;
      admission.nextCheckAt = checksRetryAt();
    } catch (error) {
      if (signal.aborted || checkAdmissions.get(prKey) !== admission) return;
      admission.ready = false;
      admission.nextCheckAt = checksRetryAt(error);
      log({ level: "error", phase: "ci", repository: repository.configuration.coordinate, number: pr.number, revision: pr.desiredRevision,
        message: "CI checks could not be read; review admission remains closed.", error, retryAt: admission.nextCheckAt });
    }
  };
  const cancelIneligible = (): void => {
    for (const [prKey, reservation] of reservations) {
      if (reservation.kind !== "review" || reservation.reviewId === undefined) continue;
      const review = store.getReview(reservation.reviewId)!;
      const pr = store.getPullRequest(review)!;
      if (pr.state !== "open" || pr.draft) reservation.controller.abort(new Error(`PR ${pr.number} is ${pr.state !== "open" ? pr.state : "Draft"}.`));
      if (blocked.has(prKey)) reservation.controller.abort(new Error("The PR has unresolved operations."));
    }
    for (const review of store.listActiveReviews()) {
      if (review.status !== "retry_wait" || reservations.has(key(review)) || blocked.has(key(review))) continue;
      if (!isCurrent(review, store.getPullRequest(review)!)) {
        store.supersedeReview(review.id, stopped, now());
        report(review, "superseded", "The waiting review was replaced by the latest observed PR state.");
      }
    }
  };

  for (const pr of store.listCleanupCandidates()) {
    try { await processes.recover(); }
    catch (error) {
      const retainedRepository = store.getRepository(pr)!;
      blocked.add(key(pr));
      safeToReleaseLock = false;
      permanentUncertainty = true;
      log({ level: "error", phase: "recovery", repository: retainedRepository.remote, number: pr.number,
        message: "The PR's cleanup and worktree reuse are blocked until its previous operations and processes are explicitly excluded.", error });
    }
  }

  // Persist uncertainty before requesting the runtime's explicit startup recovery proof.
  for (const review of store.listActiveReviews()) {
    if (review.status === "retry_wait") continue;
    if (options.assignment === undefined && store.getReviewPublication(review.id)?.phase === "pending") continue;
    const publication = store.getReviewPublication(review.id);
    const interrupted = options.assignment !== undefined && (review.status === "running" || publication?.phase === "pending" || review.status === "interrupted" && review.attemptCount > 0 && publication?.publisherId != null)
      ? store.retainPossiblePublication(review.id, "A previous coordinator stopped before this attempt was resolved.", now())
      : store.markInterrupted(review.id, "A previous coordinator stopped before this operation was resolved.", now());
    try {
      const proof = await processes.recover(interrupted);
      const recoveredAt = now();
      const recovered = options.assignment !== undefined && store.getReviewPublication(interrupted.id)?.phase === "pending"
        ? store.recoverPossiblePublication(interrupted.id, proof, recoveredAt)
        : store.resolveInterrupted(interrupted.id, proof, recoveredAt, recoveredAt);
      report(recovered, "recovery", "Previous processes and operations were excluded; the persisted target may be reconciled.");
    } catch (error) { interrupt(interrupted, error); }
  }

  const poll = async (repository: RepositoryWork): Promise<void> => {
    try {
      const reserved = (): boolean => [...reservations.keys()].some(prKey => {
        const [host, githubId] = JSON.parse(prKey) as [string, string, number];
        return host === repository.configuration.host && githubId === repository.expectedId;
      });
      if (repository.pendingConfiguration !== undefined && !reserved()) {
        repository.configuration = repository.pendingConfiguration; delete repository.pendingConfiguration; repository.local = null;
      }
      if (options.assignment !== undefined && repository.expectedId !== undefined && !reserved()) {
        const registration = store.getRepository({ host: repository.configuration.host, githubId: repository.expectedId });
        const observation = options.assignment.source.snapshot();
        const assigned = observation.kind === "enabled" && observation.pullRequests.some(item => item.repositoryId === repository.expectedId && remoteIdentity(item.repositoryUrl, "Assigned repository").host === repository.configuration.host);
        if (registration !== null && !assigned) {
          const current = await client.resolveRepositoryById({ host: registration.host, githubId: registration.githubId }, signal);
          if (current.host !== registration.host || current.githubId !== registration.githubId) throw new Error("GitHub returned a different retained repository identity.");
          const remote = `https://${current.host}/${current.owner}/${current.name}.git`;
          const identity = remoteIdentity(remote, "Retained GitHub repository");
          if (identity.coordinate !== repository.configuration.coordinate) {
            const next = { ...identity, remote, path: repository.configuration.path };
            if (reserved()) repository.pendingConfiguration = next;
            else { repository.configuration = next; repository.local = null; }
          }
        }
      }
      if (repository.local === null) {
        const registration = repository.expectedId === undefined ? undefined : store.getRepository({ host: repository.configuration.host, githubId: repository.expectedId });
        repository.local = await git.ensureRepository(repository.configuration, signal, repository.expectedId, registration);
        const existing = localRepositories.get(repositoryKey(repository.local.repository));
        if (existing !== undefined && existing !== repository) {
          repository.blocked = true;
          throw new Error(`Configured repository ${repository.configuration.coordinate} resolves to the same GitHub repository as ${existing.configuration.coordinate}.`);
        }
        localRepositories.set(repositoryKey(repository.local.repository), repository);
        log({ level: "info", phase: "repository", repository: repository.configuration.coordinate, message: "The dedicated review clone is ready." });
      }
      const previous = store.getRepository(repository.local.repository);
      const pollingClient: GitHubClient = { ...client, resolveRepository: async (input, abortSignal) => {
        const resolved = await client.resolveRepository(input, abortSignal);
        if (repositoryKey(resolved) !== repositoryKey(repository.local!.repository)) {
          repository.blocked = true;
          throw new Error(`Configured repository ${repository.configuration.coordinate} changed its stable GitHub identity after clone validation.`);
        }
        return resolved;
      } };
      if (options.assignment === undefined) {
        const observed = await pollRepository(store, repository.configuration, pollingClient, { now, signal });
        if (previous === null || previous.startPrNumber === null) log({ level: "info", phase: "initialize", repository: repository.configuration.coordinate,
          message: `Permanently excluding PR numbers through ${observed.startPrNumber}.` });
      } else {
        const local = repository.local;
        const registered = store.registerRepository({ ...local.repository, remote: repository.configuration.remote, localPath: repository.configuration.path });
        if (registered.startPrNumber === null) store.initializeRepository(local.repository, 0, now());
        const observation = options.assignment.source.snapshot();
        const candidates = observation.kind === "enabled" ? observation.pullRequests.filter(item => item.repositoryId === local.repository.githubId && remoteIdentity(item.repositoryUrl, "Assigned repository").host === local.repository.host).map(item => item.number) : [];
        const tracked = store.listPullRequests(local.repository).map(pr => pr.number);
        for (const number of new Set([...candidates, ...tracked])) {
          const pr = await client.getPullRequest(local.repository, number, signal);
          if (tracked.includes(number) || selectedAssignment({ ...local.repository, number }) !== undefined) store.observePullRequest(local.repository, pr, now());
        }
        store.recordPollSuccess(local.repository, now());
      }
      for (const pr of store.listPullRequests(repository.local.repository)) {
        if (pr.state !== "open" || pr.draft) continue;
        const completed = store.listReviews(pr).findLast((review) => review.status === "completed" && isCurrent(review, pr));
        if (completed === undefined) continue;
        const publication = store.getReviewPublication(completed.id);
        if (publication === null || publication.followupConsumed || publication.outcome === "approved") continue;
        const snapshot = await client.getPullRequestReviewSnapshot(repository.local.repository, pr.number, signal);
        if (snapshot.state !== "open" || snapshot.draft || snapshot.headSha !== pr.headSha || snapshot.baseRef !== pr.baseRef) continue;
        store.reconcileCompletedPublication(completed.id,
          publication.phase === "legacy" ? findLegacyReviewPublication(completed, snapshot) : null,
          !hasOpenReviewConversations(snapshot), now());
      }
      cancelIneligible();
      repository.nextPollAt = now() + configuration.pollIntervalMs;
    } catch (error) {
      if (uncertainGit(error)) { repository.blocked = true; safeToReleaseLock = false; permanentUncertainty = true; }
      const retryAt = Math.max(now() + configuration.pollIntervalMs, error instanceof GitHubApiError && error.retryAt !== null ? error.retryAt : 0);
      repository.nextPollAt = retryAt;
      if (!signal.aborted || uncertainGit(error)) log({ level: "error", phase: "poll", repository: repository.configuration.coordinate,
        message: repository.blocked ? "Repository preparation is blocked and requires intervention." : "Repository polling failed; the previous complete observation remains in effect.", error, retryAt });
    }
  };
  const verifyPublication = async (repository: RepositoryWork, review: ReviewState): Promise<void> => {
    let snapshot: PullRequestReviewSnapshot;
    let publication: ReturnType<typeof findReviewPublication>;
    try {
      snapshot = await client.getPullRequestReviewSnapshot(repository.local!.repository, review.number, signal);
      const captured = store.getReviewPublication(review.id)!;
      const publisherId = captured.publisherId!;
      publication = findReviewPublication(review, snapshot, publisherId, captured.identityFormat);
      if (publication === null && snapshot.viewerId !== publisherId) throw new Error("The authenticated account changed before the captured publisher's review publication could be confirmed.");
    } catch (error) {
      const retryAt = checksRetryAt(error);
      verificationRetryAt.set(review.id, retryAt);
      store.recordPublicationError(review.id, message(error), now());
      report(review, "publication", "Remote publication verification failed; retrying this read without another agent attempt.", error, retryAt);
      return;
    }
    verificationRetryAt.delete(review.id);
    if (publication === null) {
      const time = now();
      const input = { error: "The completed agent did not publish an authenticated approval or resolvable review conversation for the captured review identity.", retryAt: time + retryDelay(configuration, review.attemptCount) };
      const ended = options.assignment === undefined ? (store.rejectPublicationVerification(review.id), store.retryReview({ reviewId: review.id, attempt: review.attemptCount }, excluded, input, time))
        : store.rejectAndRetryPublication({ reviewId: review.id, attempt: review.attemptCount }, excluded, input, time);
      report(ended, ended.status, "The completion marker had no valid remote publication; the captured round remains incomplete.");
      return;
    }
    const completed = store.confirmReviewPublication({ reviewId: review.id, attempt: review.attemptCount }, publication, excluded, now());
    store.reconcileCompletedPublication(completed.id, null, !hasOpenReviewConversations(snapshot), now());
    report(completed, "completed", "The exact completion marker and authenticated remote review publication were confirmed after all managed processes stopped.");
  };
  const endAttempt = async (review: ReviewState, outcome: CopilotAttemptOutcome | undefined, error: unknown, aborted: boolean): Promise<void> => {
    if (options.assignment !== undefined) {
      const interrupted = store.retainPossiblePublication(review.id, "The attempt may have published; the original result must be checked.", now());
      let proof: ProcessesExcluded & OperationsStopped;
      try { proof = { ...await processes.exclude(interrupted, outcome), ...stopped }; }
      catch (exclusionError) { interrupt(interrupted, exclusionError); return; }
      const recovered = store.recoverPossiblePublication(review.id, proof, now());
      const repository = localRepositories.get(repositoryKey(review));
      if (repository !== undefined) await verifyPublication(repository, recovered);
      return;
    }
    let proof: ProcessesExcluded;
    try { proof = await processes.exclude(review, outcome); } catch (exclusionError) { interrupt(review, new AggregateError(error === undefined ? [exclusionError] : [error, exclusionError], "Agent processes could not be excluded.")); return; }
    const time = now();
    if (outcome?.completed === true && !aborted) {
      store.beginPublicationVerification(outcome.attempt, proof, time);
      const repository = localRepositories.get(repositoryKey(review))!;
      await verifyPublication(repository, store.getReview(review.id)!);
      return;
    }
    const reason = error === undefined ? new Error(`Copilot review did not complete: exit=${outcome?.exitCode}, signal=${outcome?.signal}, interruption=${outcome?.interruption}; ${outcome?.errors.map(message).join("; ")}`) : error;
    const retryAt = time + retryDelay(configuration, review.attemptCount);
    let ended: ReviewState;
    if (aborted) {
      store.markInterrupted(review.id, message(reason), time);
      ended = store.resolveInterrupted(review.id, { ...proof, ...stopped }, retryAt, time);
    } else ended = store.retryReview({ reviewId: review.id, attempt: review.attemptCount }, proof, { error: message(reason), retryAt }, time);
    report(ended, ended.status, ended.status === "failed" ? "The captured revision exhausted its attempt budget and remains suppressed." : "The incomplete attempt was retained for reconciliation or superseded by the latest target.", reason,
      ended.retryAt === null ? undefined : ended.retryAt);
  };
  const reviewPullRequest = async (repository: RepositoryWork, review: ReviewState, reservation: Reservation, prompt?: { projectId: string; capture: PromptCapture }): Promise<void> => {
    try {
      const local = repository.local!;
      const worktree = await git.prepareWorktree(store, local, review.id, excluded, reservation.controller.signal);
      if (worktree.kind === "changed") {
        store.supersedeReview(review.id, stopped, now());
        report(review, "superseded", "The PR target changed while its worktree was being prepared.");
        return;
      }
      reservation.controller.signal.throwIfAborted();
      const observation = await client.getPullRequest(local.repository, review.number, reservation.controller.signal);
      const pr = store.observePullRequest(local.repository, observation, now())!;
      cancelIneligible();
      if (!isCurrent(store.getReview(review.id)!, pr)) {
        store.supersedeReview(review.id, stopped, now());
        report(review, "superseded", "The captured target is no longer ready immediately before agent launch.");
        return;
      }
      let checks: Awaited<ReturnType<GitHubClient["getPullRequestChecks"]>>;
      try { checks = await client.getPullRequestChecks(local.repository, review.number, reservation.controller.signal); }
      catch (error) {
        reservation.controller.signal.throwIfAborted();
        const time = now();
        const deferred = store.deferPreparation(review.id, stopped, { error: message(error), retryAt: checksRetryAt(error) }, time);
        report(deferred, "ci", "CI checks could not be revalidated before agent launch; no agent attempt was consumed.", error,
          deferred.retryAt === null ? undefined : deferred.retryAt);
        return;
      }
      reservation.controller.signal.throwIfAborted();
      if (!isCurrent(store.getReview(review.id)!, store.getPullRequest(review)!)) {
        store.supersedeReview(review.id, stopped, now());
        report(review, "superseded", "The PR target changed while its CI checks were being revalidated.");
        return;
      }
      if (!checks.ready || checks.headSha !== review.headSha || checks.baseRef !== review.baseRef) {
        const time = now();
        const deferred = store.deferPreparation(review.id, stopped, { error: "The captured PR target no longer has passing CI checks.", retryAt: checksRetryAt() }, time);
        report(deferred, "ci", "The PR is waiting for passing CI checks before agent launch; no agent attempt was consumed.", undefined,
          deferred.retryAt === null ? undefined : deferred.retryAt);
        return;
      }
      const snapshot = await client.getPullRequestReviewSnapshot(local.repository, review.number, reservation.controller.signal);
      if (settlePriorApproval(store.getPullRequest(review)!, snapshot)) return;
      const { captured, publisherId, identityFormat, hasResult, sameRoundRecovery } = publicationContext(review, snapshot);
      if (snapshot.viewerId !== publisherId && !hasResult) {
        const time = now();
        const deferred = store.deferPreparation(review.id, stopped, { error: "The authenticated account differs from this round's captured publisher and no submitted result can be confirmed read-only.", retryAt: checksRetryAt() }, time);
        report(deferred, "publisher", "Waiting for the captured publishing account without consuming an agent attempt.");
        return;
      }
      if (snapshot.state !== "open" || snapshot.draft || snapshot.headSha !== review.headSha || snapshot.baseRef !== review.baseRef ||
        (!sameRoundRecovery && hasOpenReviewConversations(snapshot))) {
        const time = now();
        store.deferPreparation(review.id, stopped, { error: "The PR is waiting for its eligible target and resolved review conversations.", retryAt: checksRetryAt() }, time);
        return;
      }
      if (captured === null || captured.publisherId === null) store.captureReviewPublisher(review.id, publisherId);
      const previous = store.listReviews(review).filter((item) => item.id !== review.id && item.status !== "completed").at(-1);
      const input: CopilotRunOptions = { publisherId, publicationIdentityFormat: identityFormat, signal: reservation.controller.signal, onProcess: processes.onProcess, stopProcess: processes.stop, excludeProcess: processes.exclude,
        ...(prompt === undefined ? {} : { promptValues: prompt.capture.values, assertAdmission: () => { if (!currentCapture(review, prompt.projectId, prompt.capture)) throw new Error("The reviewer assignment or prompt authorization changed before launch."); } }),
        ...(previous === undefined ? {} : { previousReview: previous }) };
      report(review, "launch", "Launching the PR's persisted Copilot session.");
      const outcome = await runner.run(store, review.id, worktree, input);
      const current = store.getReview(review.id)!;
      if (outcome.processExclusionFailure !== null) {
        if (!outcome.captureComplete) permanentUncertainty = true;
        interrupt(current, outcome.processExclusionFailure); return;
      }
      await endAttempt(current, outcome, undefined, reservation.controller.signal.aborted);
    } catch (error) {
      const current = store.getReview(review.id)!;
      if (uncertainGit(error)) { interrupt(current, error); return; }
      if (current.status === "running") { await endAttempt(current, undefined, error, reservation.controller.signal.aborted); return; }
      if (current.status !== "preparing") throw error;
      const time = now();
      const retryAt = time + retryDelay(configuration, current.attemptCount);
      const deferred = store.deferPreparation(current.id, stopped, { error: message(error), retryAt }, time);
      report(deferred, "preparation", "Worktree or agent preparation stopped; no additional agent attempt was consumed.", error, deferred.retryAt === null ? undefined : deferred.retryAt);
    }
  };
  const cleanup = async (repository: RepositoryWork, pr: PullRequestState, reservation: Reservation): Promise<void> => {
    try {
      const outcome = await git.cleanupWorktree(store, repository.local!, pr, { ...excluded, ...stopped }, reservation.controller.signal);
      cleanupRetryAt.delete(key(pr));
      log({ level: "info", phase: "cleanup", repository: repository.configuration.coordinate, number: pr.number,
        message: outcome.kind === "cleaned" ? "The closed PR's worktree was removed." : "The PR reopened; its worktree is retained for the next review." });
    } catch (error) {
      if (uncertainGit(error)) { blocked.add(key(pr)); safeToReleaseLock = false; permanentUncertainty = true; }
      const retryAt = now() + configuration.retryDelayMs;
      cleanupRetryAt.set(key(pr), retryAt);
      log({ level: "error", phase: "cleanup", repository: repository.configuration.coordinate, number: pr.number,
        message: blocked.has(key(pr)) ? "Cleanup has an uncertain Git outcome and is blocked." : "Worktree cleanup failed and remains pending.", error, retryAt });
    }
  };
  const abort = (): void => { for (const reservation of reservations.values()) reservation.controller.abort(signal.reason); notify(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const time = now();
      cancelIneligible();
      for (const repository of repositories) {
        if (signal.aborted) break;
        if (repository.polling || repository.blocked || repository.nextPollAt > time) continue;
        repository.polling = true;
        track(() => poll(repository), () => { repository.polling = false; });
      }
      for (const pr of store.listCleanupCandidates()) {
        if (signal.aborted) break;
        const prKey = key(pr);
        const repository = localRepositories.get(repositoryKey(pr));
        if (repository === undefined || repository.blocked || reservations.has(prKey) || blocked.has(prKey) || (cleanupRetryAt.get(prKey) ?? 0) > time) continue;
        const reservation: Reservation = { kind: "cleanup", controller: new AbortController() };
        reservations.set(prKey, reservation);
        track(() => cleanup(repository, pr, reservation), () => { reservations.delete(prKey); });
      }
      for (const review of store.listActiveReviews()) {
        if (review.status !== "running" || store.getReviewPublication(review.id)?.phase !== "pending") continue;
        const prKey = key(review);
        const repository = localRepositories.get(repositoryKey(review));
        if (repository === undefined || repository.blocked || reservations.has(prKey) || blocked.has(prKey) || (verificationRetryAt.get(review.id) ?? 0) > time) continue;
        const reservation: Reservation = { kind: "verification", controller: new AbortController(), reviewId: review.id };
        reservations.set(prKey, reservation);
        track(() => verifyPublication(repository, review), () => { reservations.delete(prKey); });
      }
      const eligible = new Set<string>();
      for (const candidate of store.listCandidates(time)) {
        const pr = candidate.pullRequest;
        const prKey = key(pr);
        const repository = localRepositories.get(repositoryKey(pr));
        if (repository === undefined || repository.blocked || reservations.has(prKey) || blocked.has(prKey) || options.assignment !== undefined && selectedAssignment(pr) === undefined) continue;
        eligible.add(prKey);
        // Updating a waiting target keeps its queue position; successors rejoin after admission.
        waiting.set(prKey, candidate);
      }
      for (const prKey of waiting.keys()) if (!eligible.has(prKey)) {
        waiting.delete(prKey);
        checkAdmissions.delete(prKey);
        promptAdmissions.delete(prKey);
      }
      for (const [prKey, candidate] of waiting) {
        if (signal.aborted || workers >= configuration.maxConcurrentWorker) break;
        const pr = candidate.pullRequest;
        const repository = localRepositories.get(repositoryKey(pr))!;
        let admission = checkAdmissions.get(prKey);
        if (admission === undefined || admission.target !== target(pr)) {
          admission = { target: target(pr), checking: false, ready: false, nextCheckAt: 0, reported: false };
          checkAdmissions.set(prKey, admission);
        }
        if (!admission.checking && admission.nextCheckAt <= time) {
          const checking = admission;
          checking.checking = true;
          checking.ready = false;
          track(() => checkCandidate(repository, pr, checking), () => { checking.checking = false; });
        }
        if (admission.checking || !admission.ready) continue;
        let captured: { projectId: string; capture: PromptCapture } | undefined;
        if (options.assignment !== undefined) {
          const assigned = selectedAssignment(pr);
          if (assigned === undefined) continue;
          let prompt = promptAdmissions.get(prKey);
          if (prompt === undefined || prompt.target !== target(pr) || prompt.projectId !== assigned.projectId) {
            prompt = { target: target(pr), projectId: assigned.projectId, checking: false, nextCheckAt: 0 };
            promptAdmissions.set(prKey, prompt);
          }
          if (prompt.capture !== undefined && !currentCapture(pr, assigned.projectId, prompt.capture)) { delete prompt.capture; prompt.nextCheckAt = time + configuration.pollIntervalMs; }
          if (prompt.capture === undefined && !prompt.checking && prompt.nextCheckAt <= time) {
            const pendingPrompt = prompt;
            pendingPrompt.checking = true;
            track(async () => {
              try {
                const result = await options.assignment!.source.capturePrompt(assigned.projectId, signal);
                if (promptAdmissions.get(prKey) === pendingPrompt && currentCapture(pr, assigned.projectId, result)) pendingPrompt.capture = result;
              } catch (error) {
                if (!signal.aborted) log({ level: "error", phase: "prompt", repository: repository.configuration.coordinate, number: pr.number, message: "Reviewer prompt is unavailable; admission remains closed.", error });
              } finally { pendingPrompt.nextCheckAt = now() + configuration.pollIntervalMs; }
            }, () => { pendingPrompt.checking = false; });
          }
          if (prompt.checking || prompt.capture === undefined || !currentCapture(pr, assigned.projectId, prompt.capture)) continue;
          captured = { projectId: assigned.projectId, capture: prompt.capture };
        }
        waiting.delete(prKey);
        checkAdmissions.delete(prKey);
        promptAdmissions.delete(prKey);
        const review = store.reserveReview(pr, { reviewId: randomUUID(), sessionId: randomUUID(), maxAttempts: configuration.maxAttempts }, time);
        if (review === null) continue;
        const reservation: Reservation = { kind: "review", controller: new AbortController(), reviewId: review.id };
        reservations.set(prKey, reservation);
        workers++;
        report(review, "reserved", "Reserved this PR across worktree preparation and agent execution.");
        track(() => reviewPullRequest(repository, review, reservation, captured), () => { reservations.delete(prKey); workers--; });
      }
      const deadlines = [...verificationRetryAt.values()].filter((deadline) => deadline > now());
      deadlines.push(...repositories.filter((repository) => !repository.polling && !repository.blocked).map((repository) => repository.nextPollAt));
      if (workers < configuration.maxConcurrentWorker) for (const review of store.listActiveReviews()) {
        if (review.status === "retry_wait" && review.retryAt !== null && review.retryAt > now() && !blocked.has(key(review))) deadlines.push(review.retryAt);
      }
      if (workers < configuration.maxConcurrentWorker) for (const admission of checkAdmissions.values()) {
        if (!admission.checking && !admission.ready) deadlines.push(admission.nextCheckAt);
      }
      if (workers < configuration.maxConcurrentWorker) for (const prompt of promptAdmissions.values()) if (!prompt.checking && prompt.capture === undefined) deadlines.push(prompt.nextCheckAt);
      for (const [prKey, deadline] of cleanupRetryAt) if (!blocked.has(prKey) && deadline > now()) deadlines.push(deadline);
      const delay = deadlines.length === 0 ? 2_147_483_647 : Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - now()));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, delay);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        if (signal.aborted) wake();
      });
      // Completed polls can wake only microtasks when their next deadline is already due.
      await setImmediate();
    }
  } finally {
    lifetime.abort(new Error("The coordinator is stopping."));
    abort();
    signal.removeEventListener("abort", abort);
    unsubscribe?.();
    await Promise.all(pending);
  }
  // The coordinator has joined all work. A Worker may later retire the exact
  // native boundaries that caused interruption, without replaying this round.
  return { get safeToReleaseLock() {
    return safeToReleaseLock || !permanentUncertainty && ownedCleanupFailures.length > 0 &&
      ownedCleanupFailures.every(error => !hasUnconfirmedOwnedCommandCleanup(error));
  } };
};
