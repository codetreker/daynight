import path from "node:path";
import type Database from "better-sqlite3";
import { acquireMaintenanceLock } from "../../platform/instance-lock.js";
import { closeSqliteDatabase, openSqliteDatabase, readSqliteDatabase, type SqliteMigrationReporter } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../platform/sqlite-format.js";
import { reviewFormat } from "./store-format.js";
import type { ReviewPaths } from "./paths.js";
import type { PublicationIdentityFormat, ReviewPublication } from "./publication.js";

import type { RepositoryIdentity, PullRequestIdentity, RepositoryState, PullRequestObservation, RepositoryPollUpdate, PullRequestState, ReviewStatus, ReviewState, ReviewCandidate, ReviewListingSnapshot, AttemptIdentity, OperationsStopped, ProcessesExcluded } from "./model.js";

type PullRequestRow = Omit<PullRequestState, "draft" | "sessionEstablished" | "cleanupPending"> & {
  draft: number; sessionEstablished: number; cleanupPending: number;
};

const repositoryColumns = `host, github_id AS githubId, remote, local_path AS localPath,
  start_pr_no AS startPrNumber, initialized_at AS initializedAt,
  last_poll_at AS lastPollAt, last_poll_error AS lastPollError`;
const pullRequestColumns = `host, github_id AS githubId, number, state, draft,
  head_sha AS headSha, base_ref AS baseRef, base_sha AS baseSha,
  desired_revision AS desiredRevision, completed_revision AS completedRevision,
  session_id AS sessionId, session_established AS sessionEstablished,
  worktree_path AS worktreePath, cleanup_pending AS cleanupPending, cleanup_error AS cleanupError, observed_at AS observedAt`;
const reviewColumns = `host, github_id AS githubId, number, id, revision,
  head_sha AS headSha, base_ref AS baseRef, base_sha AS baseSha, status,
  attempt_count AS attemptCount, max_attempts AS maxAttempts, retry_at AS retryAt,
  process_owner AS processOwner, process_id AS processId, process_identity AS processIdentity,
  stdout_log_path AS stdoutLogPath, stderr_log_path AS stderrLogPath, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt`;
const activeStatuses = "'preparing', 'running', 'retry_wait', 'interrupted'";

const requireText = (value: string, name: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a nonempty string.`);
};
const requireInteger = (value: number, name: string, minimum = 0): void => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer of at least ${minimum}.`);
};
const requireUuid = (value: string, name: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
};
const repositoryKey = (identity: RepositoryIdentity): RepositoryIdentity => {
  requireText(identity.host, "Repository host");
  requireText(identity.githubId, "GitHub repository ID");
  return { host: identity.host.toLowerCase(), githubId: identity.githubId };
};
const pullRequestKey = (identity: PullRequestIdentity): PullRequestIdentity => {
  requireInteger(identity.number, "PR number", 1);
  return { ...repositoryKey(identity), number: identity.number };
};
const asPullRequest = (row: PullRequestRow): PullRequestState => ({
  ...row, draft: row.draft === 1, sessionEstablished: row.sessionEstablished === 1, cleanupPending: row.cleanupPending === 1,
});
const requireStopped = (proof: OperationsStopped): void => {
  if (proof.operationsStopped !== true) throw new Error("The caller must confirm that all PR operations have stopped.");
};
const requireExcluded = (proof: ProcessesExcluded): void => {
  if (proof.processesExcluded !== true) throw new Error("The caller must exclude any previous agent processes first.");
};

export type ReviewPublicationState = { phase: "prepared" | "pending" | "verified" | "legacy"; publisherId: string | null; identityFormat: PublicationIdentityFormat; outcome: "approved" | "commented" | null; remoteReviewId: string | null; threadIds: string[]; followupConsumed: boolean };
const publicationColumns = `phase, publisher_id AS publisherId, identity_format AS identityFormat, outcome, remote_review_id AS remoteReviewId, remote_thread_ids AS threadIds, followup_consumed AS followupConsumed`;
type ListingPaths = Pick<ReviewPaths, "databaseFile" | "lockFile">;

export const readReviewListingSnapshot = (
  paths: ListingPaths,
  options: { onMigration?: SqliteMigrationReporter } = {},
): ReviewListingSnapshot | null => {
  if (!path.isAbsolute(paths.databaseFile) || !path.isAbsolute(paths.lockFile)) throw new Error("The SQLite database and instance-lock paths must be absolute.");
  return readSqliteDatabase<ReviewListingSnapshot | null>({
    file: paths.databaseFile, format: reviewFormat, onMissing: () => null,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }),
    acquireMaintenance: () => acquireMaintenanceLock({
      lockFile: paths.lockFile, ownershipGateFile: `${paths.lockFile}.sqlite`, gateFileMustExist: false,
    }),
  }, (db: Database.Database): ReviewListingSnapshot => {
    const repositories = db.prepare(`SELECT ${repositoryColumns} FROM repositories ORDER BY host, github_id`).all() as RepositoryState[];
    const pullRequests = (db.prepare(`SELECT ${pullRequestColumns} FROM pull_requests WHERE state = 'open' ORDER BY host, github_id, number`)
      .all() as PullRequestRow[]).map(asPullRequest);
    const reviews = db.prepare(`SELECT ${reviewColumns} FROM reviews r
      WHERE EXISTS(SELECT 1 FROM pull_requests p WHERE p.host = r.host AND p.github_id = r.github_id AND p.number = r.number AND p.state = 'open'
        AND ((r.revision = p.desired_revision AND r.head_sha = p.head_sha AND r.base_ref = p.base_ref) OR r.status IN (${activeStatuses})))
      ORDER BY host, github_id, number, created_at, id`).all() as ReviewState[];
    return { repositories, pullRequests, reviews };
  });
};

export const openStore = (databaseFile: string, options: { busyTimeoutMs?: number; onMigration?: SqliteMigrationReporter } = {}) => {
  if (!path.isAbsolute(databaseFile)) throw new Error("The SQLite database path must be absolute.");
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs;
  requireInteger(busyTimeoutMs, "SQLite busy timeout", 1);
  if (busyTimeoutMs > 60000) throw new Error("SQLite busy timeout must not exceed 60000 milliseconds.");
  const db = openSqliteDatabase({
    file: databaseFile, format: reviewFormat, allowEmpty: true, timeoutMs: busyTimeoutMs,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }),
  });
  const atomic = <T>(operation: () => T): T => {
    let formatFailure: unknown;
    const transaction = db.transaction(() => {
      try { assertCurrentSqlite(db, reviewFormat); }
      catch (error) { formatFailure = error; throw error; }
      return operation();
    });
    try { return transaction.immediate(); }
    catch (error) {
      if (formatFailure !== undefined && error !== formatFailure) throw new AggregateError([formatFailure, error], "Review format assertion and transaction rollback failed.");
      throw error;
    }
  };
  const getRepository = (identity: RepositoryIdentity): RepositoryState | null => {
    const key = repositoryKey(identity);
    return db.prepare(`SELECT ${repositoryColumns} FROM repositories WHERE host = @host AND github_id = @githubId`).get(key) as RepositoryState | undefined ?? null;
  };
  const needRepository = (identity: RepositoryIdentity): RepositoryState => {
    const repository = getRepository(identity);
    if (repository === null) throw new Error("Repository is not registered.");
    return repository;
  };
  const getPullRequest = (identity: PullRequestIdentity): PullRequestState | null => {
    const row = db.prepare(`SELECT ${pullRequestColumns} FROM pull_requests WHERE host = @host AND github_id = @githubId AND number = @number`).get(pullRequestKey(identity)) as PullRequestRow | undefined;
    return row === undefined ? null : asPullRequest(row);
  };
  const needPullRequest = (identity: PullRequestIdentity): PullRequestState => {
    const pullRequest = getPullRequest(identity);
    if (pullRequest === null) throw new Error("PR is not tracked.");
    return pullRequest;
  };
  const getReview = (reviewId: string): ReviewState | null => {
    return db.prepare(`SELECT ${reviewColumns} FROM reviews WHERE id = ?`).get(reviewId) as ReviewState | undefined ?? null;
  };
  const needReview = (reviewId: string): ReviewState => {
    const review = getReview(reviewId);
    if (review === null) throw new Error("Review does not exist.");
    return review;
  };
  const activeReview = (identity: PullRequestIdentity): ReviewState | null => {
    return db.prepare(`SELECT ${reviewColumns} FROM reviews WHERE host = @host AND github_id = @githubId AND number = @number AND status IN (${activeStatuses})`).get(pullRequestKey(identity)) as ReviewState | undefined ?? null;
  };
  const isCurrentTarget = (review: ReviewState, pullRequest: PullRequestState): boolean =>
    pullRequest.state === "open" && !pullRequest.draft && !pullRequest.cleanupPending &&
    review.revision === pullRequest.desiredRevision && review.headSha === pullRequest.headSha && review.baseRef === pullRequest.baseRef;
  const attemptReview = (identity: AttemptIdentity): ReviewState => {
    const review = needReview(identity.reviewId);
    if (review.status !== "running" || review.attemptCount !== identity.attempt) throw new Error("The review attempt is not the current running attempt.");
    return review;
  };
  const setStatus = (review: ReviewState, status: ReviewStatus, now: number, error: string | null, retryAt: number | null = null): ReviewState => {
    db.prepare("UPDATE reviews SET status = @status, retry_at = @retryAt, last_error = @error, updated_at = @now WHERE id = @id")
      .run({ id: review.id, status, retryAt, error, now });
    return needReview(review.id);
  };

  const getReviewPublication = (reviewId: string): ReviewPublicationState | null => {
    const row = db.prepare(`SELECT ${publicationColumns} FROM review_publications WHERE review_id = ?`).get(reviewId) as
      Omit<ReviewPublicationState, "threadIds" | "followupConsumed"> & { threadIds: string; followupConsumed: number } | undefined;
    return row === undefined ? null : { ...row, threadIds: JSON.parse(row.threadIds) as string[], followupConsumed: row.followupConsumed === 1 };
  };
  const store = {
    getReviewPublication,
    adoptHistoricalApproval: (reviewId: string, publication: ReviewPublication): void => atomic(() => {
      if (getReviewPublication(reviewId)?.phase !== "legacy" || needReview(reviewId).status !== "completed" || publication.outcome !== "approved") throw new Error("Only a legacy completed review may adopt a historical approval.");
      db.prepare("UPDATE review_publications SET phase = 'verified', publisher_id = @publisherId, outcome = 'approved', remote_review_id = @remoteReviewId, remote_thread_ids = '[]' WHERE review_id = @id")
        .run({ id: reviewId, publisherId: publication.publisherId, remoteReviewId: publication.remoteReviewId });
    }),
    adoptLegacyReviewPublisher: (reviewId: string, publisherId: string): void => atomic(() => {
      requireText(publisherId, "Legacy review publisher ID");
      const review = needReview(reviewId);
      const publication = getReviewPublication(reviewId);
      if ((review.status !== "preparing" && review.status !== "retry_wait") || publication?.phase !== "prepared" || publication.identityFormat !== "legacy") throw new Error("Only an unfinished migrated review may adopt its publisher.");
      if (publication.publisherId !== null && publication.publisherId !== publisherId) throw new Error("The migrated review's publisher is already bound to another actor.");
      db.prepare("UPDATE review_publications SET publisher_id = ? WHERE review_id = ?").run(publisherId, reviewId);
    }),
    captureReviewPublisher: (reviewId: string, publisherId: string): void => atomic(() => {
      requireText(publisherId, "Review publisher ID");
      const review = needReview(reviewId);
      if (review.status !== "preparing") throw new Error("Only a preparing review may capture its publisher.");
      const publication = getReviewPublication(reviewId);
      if (publication !== null && publication.publisherId !== null && publication.publisherId !== publisherId) throw new Error("The authenticated account differs from this round's captured review publisher.");
      db.prepare("INSERT INTO review_publications(review_id, phase, publisher_id) VALUES(?, 'prepared', ?) ON CONFLICT(review_id) DO UPDATE SET publisher_id = excluded.publisher_id").run(reviewId, publisherId);
    }),
    settleApprovedTarget: (identity: PullRequestIdentity, headSha: string, baseRef: string, proof: OperationsStopped, now: number): boolean => atomic(() => {
      requireStopped(proof);
      const pr = needPullRequest(identity);
      if (pr.headSha !== headSha || pr.baseRef !== baseRef || pr.state !== "open" || pr.draft || pr.cleanupPending) return false;
      const active = activeReview(pr);
      if (active !== null && (active.status === "running" || active.status === "interrupted")) return false;
      if (active !== null) setStatus(active, "superseded", now, null);
      db.prepare("UPDATE pull_requests SET completed_revision = desired_revision WHERE host = @host AND github_id = @githubId AND number = @number").run(pullRequestKey(pr));
      return true;
    }),
    beginPublicationVerification: (identity: AttemptIdentity, proof: ProcessesExcluded, now: number): void => atomic(() => {
      requireExcluded(proof);
      requireInteger(now, "Verification time");
      const review = attemptReview(identity);
      const publication = getReviewPublication(review.id);
      if (publication?.phase !== "prepared" || publication.publisherId === null) throw new Error("The review publisher must be captured before publication verification.");
      db.prepare("UPDATE review_publications SET phase = 'pending' WHERE review_id = ?").run(review.id);
      db.prepare("UPDATE reviews SET process_id = NULL, process_identity = NULL, updated_at = ? WHERE id = ?").run(now, review.id);
    }),
    rejectPublicationVerification: (reviewId: string): void => atomic(() => {
      if (getReviewPublication(reviewId)?.phase !== "pending") throw new Error("Publication verification is not pending.");
      db.prepare("UPDATE review_publications SET phase = 'prepared' WHERE review_id = ?").run(reviewId);
    }),
    recordPublicationError: (reviewId: string, error: string, now: number): void => atomic(() => {
      if (getReviewPublication(reviewId)?.phase !== "pending") throw new Error("Only pending publication verification can record a read error.");
      requireText(error, "Publication verification error");
      db.prepare("UPDATE reviews SET last_error = ?, updated_at = ? WHERE id = ?").run(error, now, reviewId);
    }),
    confirmReviewPublication: (identity: AttemptIdentity, publication: ReviewPublication, proof: ProcessesExcluded, now: number): ReviewState => atomic(() => {
      requireExcluded(proof);
      const review = attemptReview(identity);
      const captured = getReviewPublication(review.id);
      if (captured?.phase !== "pending" || captured.publisherId !== publication.publisherId) throw new Error("The publication does not match this round's captured publisher and verification phase.");
      if (publication.outcome === "commented" && publication.threadIds.length === 0) throw new Error("A completed COMMENT requires a resolvable conversation.");
      db.prepare(`INSERT INTO review_publications(review_id, phase, publisher_id, outcome, remote_review_id, remote_thread_ids)
        VALUES(@id, 'verified', @publisherId, @outcome, @remoteReviewId, @threadIds)
        ON CONFLICT(review_id) DO UPDATE SET phase = 'verified', publisher_id = excluded.publisher_id, outcome = excluded.outcome, remote_review_id = excluded.remote_review_id, remote_thread_ids = excluded.remote_thread_ids`)
        .run({ id: review.id, ...publication, threadIds: JSON.stringify(publication.threadIds) });
      return store.completeReview(identity, proof, now);
    }),
    reconcileCompletedPublication: (reviewId: string, publication: ReviewPublication | null, allThreadsResolved: boolean, now: number): PullRequestState => atomic(() => {
      const review = needReview(reviewId);
      const pr = needPullRequest(review);
      const state = getReviewPublication(review.id);
      if (review.status !== "completed" || state === null || state.followupConsumed || !isCurrentTarget(review, pr)) return pr;
      if (state.phase === "legacy") {
        if (publication !== null) {
          db.prepare("UPDATE review_publications SET phase = 'verified', publisher_id = @publisherId, outcome = @outcome, remote_review_id = @remoteReviewId, remote_thread_ids = @threadIds WHERE review_id = @id")
            .run({ id: review.id, ...publication, threadIds: JSON.stringify(publication.threadIds) });
          if (publication.outcome === "approved") return pr;
        } else {
          // Legacy completion did not prove a resolvable result; one successor adopts the new protocol.
          db.prepare("UPDATE review_publications SET followup_consumed = 1 WHERE review_id = ?").run(review.id);
          db.prepare("UPDATE pull_requests SET desired_revision = desired_revision + 1, observed_at = @now WHERE host = @host AND github_id = @githubId AND number = @number").run({ ...pullRequestKey(pr), now });
          return needPullRequest(pr);
        }
      }
      const current = getReviewPublication(review.id)!;
      if (current.outcome !== "commented" || !allThreadsResolved) return pr;
      db.prepare("UPDATE review_publications SET followup_consumed = 1 WHERE review_id = ?").run(review.id);
      db.prepare("UPDATE pull_requests SET desired_revision = desired_revision + 1, observed_at = @now WHERE host = @host AND github_id = @githubId AND number = @number").run({ ...pullRequestKey(pr), now });
      return needPullRequest(pr);
    }),
    close: (): void => { closeSqliteDatabase(db, { file: databaseFile, format: reviewFormat }); },
    getRepository,
    getPullRequest,
    getReview,
    listRepositories: (): RepositoryState[] => db.prepare(`SELECT ${repositoryColumns} FROM repositories ORDER BY host, github_id`).all() as RepositoryState[],
    listPullRequests: (identity: RepositoryIdentity): PullRequestState[] =>
      (db.prepare(`SELECT ${pullRequestColumns} FROM pull_requests WHERE host = @host AND github_id = @githubId ORDER BY number`).all(repositoryKey(identity)) as PullRequestRow[]).map(asPullRequest),
    listActiveReviews: (): ReviewState[] =>
      db.prepare(`SELECT ${reviewColumns} FROM reviews WHERE status IN (${activeStatuses}) ORDER BY created_at, id`).all() as ReviewState[],
    listCleanupCandidates: (): PullRequestState[] =>
      (db.prepare(`SELECT ${pullRequestColumns} FROM pull_requests p WHERE cleanup_pending = 1
        AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.host = p.host AND r.github_id = p.github_id AND r.number = p.number AND r.status IN (${activeStatuses}))
        ORDER BY observed_at, host, github_id, number`).all() as PullRequestRow[]).map(asPullRequest),
    listReviews: (identity: PullRequestIdentity): ReviewState[] =>
      db.prepare(`SELECT ${reviewColumns} FROM reviews WHERE host = @host AND github_id = @githubId AND number = @number ORDER BY created_at, id`).all(pullRequestKey(identity)) as ReviewState[],
    registerRepository: (input: RepositoryIdentity & { remote: string; localPath: string }): RepositoryState => atomic(() => {
      const key = repositoryKey(input);
      requireText(input.remote, "Repository remote");
      requireText(input.localPath, "Repository local path");
      const existing = getRepository(key);
      if (existing !== null && existing.localPath !== input.localPath) {
        const worktree = db.prepare("SELECT 1 FROM pull_requests WHERE host = @host AND github_id = @githubId AND worktree_path IS NOT NULL LIMIT 1").get(key);
        if (worktree !== undefined) throw new Error("A repository with registered worktrees cannot change its local path.");
      }
      db.prepare(`INSERT INTO repositories(host, github_id, remote, local_path) VALUES(@host, @githubId, @remote, @localPath)
        ON CONFLICT(host, github_id) DO UPDATE SET remote = excluded.remote, local_path = excluded.local_path`).run({ ...key, remote: input.remote, localPath: input.localPath });
      return needRepository(key);
    }),
    initializeRepository: (identity: RepositoryIdentity, startPrNumber: number, now: number): RepositoryState => atomic(() => {
      const key = repositoryKey(identity);
      requireInteger(startPrNumber, "Start PR number");
      requireInteger(now, "Initialization time");
      needRepository(key);
      db.prepare("UPDATE repositories SET start_pr_no = @startPrNumber, initialized_at = @now WHERE host = @host AND github_id = @githubId AND start_pr_no IS NULL")
        .run({ ...key, startPrNumber, now });
      return needRepository(key);
    }),
    recordPollSuccess: (identity: RepositoryIdentity, now: number): RepositoryState => atomic(() => {
      const key = repositoryKey(identity);
      requireInteger(now, "Poll time");
      needRepository(key);
      db.prepare("UPDATE repositories SET last_poll_at = @now, last_poll_error = NULL WHERE host = @host AND github_id = @githubId").run({ ...key, now });
      return needRepository(key);
    }),
    recordPollError: (identity: RepositoryIdentity, error: string): RepositoryState => atomic(() => {
      const key = repositoryKey(identity);
      requireText(error, "Poll error");
      needRepository(key);
      db.prepare("UPDATE repositories SET last_poll_error = @error WHERE host = @host AND github_id = @githubId").run({ ...key, error });
      return needRepository(key);
    }),
    observePullRequest: (identity: RepositoryIdentity, observation: PullRequestObservation, now: number): PullRequestState | null => atomic(() => {
      const key = pullRequestKey({ ...identity, number: observation.number });
      requireInteger(now, "Observation time");
      if (!["open", "closed", "merged"].includes(observation.state) || typeof observation.draft !== "boolean") throw new Error("Invalid PR state or Draft flag.");
      requireText(observation.headSha, "PR head SHA");
      requireText(observation.baseRef, "PR base branch");
      requireText(observation.baseSha, "PR base SHA");
      const repository = needRepository(key);
      if (repository.startPrNumber === null) throw new Error("Repository initialization has not completed.");
      if (observation.number <= repository.startPrNumber) return null;
      const previous = getPullRequest(key);
      const triggered = previous === null || previous.headSha !== observation.headSha || previous.baseRef !== observation.baseRef ||
        (previous.draft && !observation.draft) || (previous.state !== "open" && observation.state === "open");
      const desiredRevision = previous === null ? 1 : previous.desiredRevision + Number(triggered);
      requireInteger(desiredRevision, "Desired revision", 1);
      // Observations cannot prove that an earlier cleanup operation has stopped.
      const cleanupPending = previous !== null && (previous.cleanupPending || (observation.state !== "open" && previous.worktreePath !== null));
      const parameters = { ...key, state: observation.state, draft: Number(observation.draft), headSha: observation.headSha,
        baseRef: observation.baseRef, baseSha: observation.baseSha, desiredRevision, cleanupPending: Number(cleanupPending),
        cleanupError: previous === null ? null : previous.cleanupError, now };
      if (previous === null) {
        db.prepare(`INSERT INTO pull_requests(host, github_id, number, state, draft, head_sha, base_ref, base_sha, desired_revision, cleanup_pending, observed_at)
          VALUES(@host, @githubId, @number, @state, @draft, @headSha, @baseRef, @baseSha, @desiredRevision, @cleanupPending, @now)`).run(parameters);
      } else {
        db.prepare(`UPDATE pull_requests SET state = @state, draft = @draft, head_sha = @headSha, base_ref = @baseRef, base_sha = @baseSha,
          desired_revision = @desiredRevision, cleanup_pending = @cleanupPending, cleanup_error = @cleanupError, observed_at = @now
          WHERE host = @host AND github_id = @githubId AND number = @number`).run(parameters);
      }
      return needPullRequest(key);
    }),
    listCandidates: (now: number): ReviewCandidate[] => {
      requireInteger(now, "Selection time");
      const rows = db.prepare(`SELECT ${pullRequestColumns} FROM pull_requests p WHERE state = 'open' AND draft = 0 AND cleanup_pending = 0
        AND desired_revision > completed_revision
        AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.host = p.host AND r.github_id = p.github_id AND r.number = p.number AND r.revision = p.desired_revision AND r.status = 'failed')
        AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.host = p.host AND r.github_id = p.github_id AND r.number = p.number AND r.status IN ('preparing', 'running', 'interrupted'))
        AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.host = p.host AND r.github_id = p.github_id AND r.number = p.number AND r.status = 'retry_wait' AND r.revision = p.desired_revision AND r.retry_at > @now)
        ORDER BY observed_at, host, github_id, number`).all({ now }) as PullRequestRow[];
      return rows.map((row) => { const pullRequest = asPullRequest(row); return { pullRequest, review: activeReview(pullRequest) }; });
    },
    reserveReview: (identity: PullRequestIdentity, input: { reviewId: string; sessionId: string; maxAttempts: number }, now: number): ReviewState | null => atomic(() => {
      const pullRequest = needPullRequest(identity);
      requireInteger(now, "Reservation time");
      requireInteger(input.maxAttempts, "Maximum attempts", 1);
      requireUuid(input.reviewId, "Review ID");
      requireUuid(input.sessionId, "Session ID");
      if (pullRequest.state !== "open" || pullRequest.draft || pullRequest.cleanupPending || pullRequest.desiredRevision <= pullRequest.completedRevision) return null;
      let active = activeReview(pullRequest);
      if (active !== null && active.status === "retry_wait" && !isCurrentTarget(active, pullRequest)) {
        setStatus(active, "superseded", now, active.lastError);
        active = null;
      }
      if (active !== null) {
        if (active.status !== "retry_wait" || active.retryAt === null || active.retryAt > now) return null;
        if (active.attemptCount >= active.maxAttempts) { setStatus(active, "failed", now, active.lastError); return null; }
        return setStatus(active, "preparing", now, active.lastError);
      }
      const failed = db.prepare("SELECT 1 FROM reviews WHERE host = @host AND github_id = @githubId AND number = @number AND revision = @revision AND status = 'failed' LIMIT 1")
        .get({ ...pullRequestKey(pullRequest), revision: pullRequest.desiredRevision });
      if (failed !== undefined) return null;
      if (pullRequest.sessionId === null) {
        db.prepare("UPDATE pull_requests SET session_id = @sessionId WHERE host = @host AND github_id = @githubId AND number = @number")
          .run({ ...pullRequestKey(pullRequest), sessionId: input.sessionId });
      }
      db.prepare(`INSERT INTO reviews(id, host, github_id, number, revision, head_sha, base_ref, status, max_attempts, created_at, updated_at)
        VALUES(@id, @host, @githubId, @number, @revision, @headSha, @baseRef, 'preparing', @maxAttempts, @now, @now)`)
        .run({ ...pullRequestKey(pullRequest), id: input.reviewId, revision: pullRequest.desiredRevision, headSha: pullRequest.headSha,
          baseRef: pullRequest.baseRef, maxAttempts: input.maxAttempts, now });
      return needReview(input.reviewId);
    }),
    pinReviewBase: (reviewId: string, baseSha: string, now: number): ReviewState => atomic(() => {
      requireText(baseSha, "Pinned base SHA");
      requireInteger(now, "Pin time");
      const review = needReview(reviewId);
      if (review.status !== "preparing") throw new Error("Only a preparing review may pin its base SHA.");
      if (review.baseSha !== null && review.baseSha !== baseSha) throw new Error("A review's pinned base SHA is immutable.");
      db.prepare("UPDATE reviews SET base_sha = @baseSha, updated_at = @now WHERE id = @id").run({ id: reviewId, baseSha, now });
      return needReview(reviewId);
    }),
    startAttempt: (reviewId: string, input: { processOwner: string; stdoutLogPath: string; stderrLogPath: string }, now: number): ReviewState => atomic(() => {
      requireInteger(now, "Launch time");
      requireText(input.processOwner, "Process owner");
      requireText(input.stdoutLogPath, "Stdout log path");
      requireText(input.stderrLogPath, "Stderr log path");
      const review = needReview(reviewId);
      const pullRequest = needPullRequest(review);
      if (review.status !== "preparing" || !isCurrentTarget(review, pullRequest)) throw new Error("The captured review target is no longer ready to run.");
      if (review.baseSha === null || pullRequest.worktreePath === null || pullRequest.sessionId === null) throw new Error("The review's base, worktree, and session must be persisted before launch.");
      if (review.attemptCount >= review.maxAttempts) throw new Error("The review attempt budget is exhausted.");
      // Launch intent consumes the budget before spawn; a crash in that gap cannot grant another attempt.
      db.prepare(`UPDATE reviews SET status = 'running', attempt_count = attempt_count + 1, retry_at = NULL,
        process_owner = @processOwner, process_id = NULL, process_identity = NULL, stdout_log_path = @stdoutLogPath,
        stderr_log_path = @stderrLogPath, updated_at = @now WHERE id = @id`).run({ id: reviewId, ...input, now });
      return needReview(reviewId);
    }),
    recordProcess: (identity: AttemptIdentity, input: { pid: number; identity: string }): ReviewState => atomic(() => {
      requireInteger(input.pid, "Process ID", 1);
      requireText(input.identity, "Process identity");
      const review = attemptReview(identity);
      if (review.processId !== null && (review.processId !== input.pid || review.processIdentity !== input.identity)) throw new Error("The running attempt already has a different process identity.");
      db.prepare("UPDATE reviews SET process_id = @pid, process_identity = @identity WHERE id = @id").run({ id: review.id, ...input });
      return needReview(review.id);
    }),
    clearProcess: (identity: AttemptIdentity, expected: { processId: number | null; processIdentity: string | null }, proof: ProcessesExcluded): ReviewState => atomic(() => {
      requireExcluded(proof);
      const review = attemptReview(identity);
      if (review.processId !== expected.processId || review.processIdentity !== expected.processIdentity) throw new Error("The running attempt's process identity changed before exclusion was recorded.");
      db.prepare("UPDATE reviews SET process_id = NULL, process_identity = NULL WHERE id = @id").run({ id: review.id });
      return needReview(review.id);
    }),
    markSessionEstablished: (identity: PullRequestIdentity): PullRequestState => atomic(() => {
      const pullRequest = needPullRequest(identity);
      if (pullRequest.sessionId === null) throw new Error("The PR has no persisted session ID.");
      db.prepare("UPDATE pull_requests SET session_established = 1 WHERE host = @host AND github_id = @githubId AND number = @number").run(pullRequestKey(pullRequest));
      return needPullRequest(pullRequest);
    }),
    completeReview: (identity: AttemptIdentity, proof: ProcessesExcluded, now: number): ReviewState => atomic(() => {
      requireExcluded(proof);
      requireInteger(now, "Completion time");
      const review = attemptReview(identity);
      const completed = setStatus(review, "completed", now, null);
      db.prepare("UPDATE pull_requests SET completed_revision = MAX(completed_revision, @revision) WHERE host = @host AND github_id = @githubId AND number = @number")
        .run({ ...pullRequestKey(review), revision: review.revision });
      return completed;
    }),
    retryReview: (identity: AttemptIdentity, proof: ProcessesExcluded, input: { error: string; retryAt: number }, now: number): ReviewState => atomic(() => {
      requireExcluded(proof);
      requireInteger(now, "Attempt end time");
      requireInteger(input.retryAt, "Retry time");
      if (input.retryAt < now) throw new Error("Retry time cannot precede the attempt end time.");
      requireText(input.error, "Attempt error");
      const review = attemptReview(identity);
      if (!isCurrentTarget(review, needPullRequest(review))) return setStatus(review, "superseded", now, input.error);
      if (review.attemptCount >= review.maxAttempts) return setStatus(review, "failed", now, input.error);
      return setStatus(review, "retry_wait", now, input.error, input.retryAt);
    }),
    deferPreparation: (reviewId: string, proof: OperationsStopped, input: { error: string; retryAt: number }, now: number): ReviewState => atomic(() => {
      requireStopped(proof);
      requireInteger(now, "Preparation end time");
      requireInteger(input.retryAt, "Retry time");
      if (input.retryAt < now) throw new Error("Retry time cannot precede preparation end time.");
      requireText(input.error, "Preparation error");
      const review = needReview(reviewId);
      if (review.status !== "preparing") throw new Error("Only preparation can be deferred without consuming an agent attempt.");
      if (!isCurrentTarget(review, needPullRequest(review))) return setStatus(review, "superseded", now, input.error);
      return setStatus(review, "retry_wait", now, input.error, input.retryAt);
    }),
    markInterrupted: (reviewId: string, error: string, now: number): ReviewState => atomic(() => {
      requireInteger(now, "Interruption time");
      requireText(error, "Interruption error");
      const review = needReview(reviewId);
      if (review.status !== "preparing" && review.status !== "running" && review.status !== "interrupted") throw new Error("Only unresolved preparation or execution can be interrupted.");
      return setStatus(review, "interrupted", now, error);
    }),
    resolveInterrupted: (reviewId: string, proof: ProcessesExcluded & OperationsStopped, retryAt: number, now: number): ReviewState => atomic(() => {
      requireExcluded(proof);
      requireStopped(proof);
      requireInteger(now, "Recovery time");
      requireInteger(retryAt, "Retry time");
      if (retryAt < now) throw new Error("Retry time cannot precede recovery time.");
      const review = needReview(reviewId);
      if (review.status !== "interrupted") throw new Error("Review is not interrupted.");
      if (!isCurrentTarget(review, needPullRequest(review))) return setStatus(review, "superseded", now, review.lastError);
      if (review.attemptCount >= review.maxAttempts) return setStatus(review, "failed", now, review.lastError);
      return setStatus(review, "retry_wait", now, review.lastError, retryAt);
    }),
    supersedeReview: (reviewId: string, proof: OperationsStopped, now: number): ReviewState => atomic(() => {
      requireStopped(proof);
      requireInteger(now, "Supersession time");
      const review = needReview(reviewId);
      if (review.status !== "preparing" && review.status !== "retry_wait") throw new Error("Running or interrupted execution cannot be superseded before it is resolved.");
      if (isCurrentTarget(review, needPullRequest(review))) throw new Error("A current review target cannot be superseded.");
      return setStatus(review, "superseded", now, review.lastError);
    }),
    registerWorktree: (identity: PullRequestIdentity, worktreePath: string): PullRequestState => atomic(() => {
      requireText(worktreePath, "Worktree path");
      const pullRequest = needPullRequest(identity);
      if (pullRequest.state !== "open" || pullRequest.cleanupPending) throw new Error("Cannot register a worktree for a closed PR.");
      if (pullRequest.worktreePath !== null && pullRequest.worktreePath !== worktreePath) throw new Error("The PR already owns a different worktree.");
      const active = activeReview(pullRequest);
      if (active !== null && (active.status === "running" || active.status === "interrupted")) throw new Error("Cannot change worktree registration while execution is unresolved.");
      db.prepare("UPDATE pull_requests SET worktree_path = @worktreePath WHERE host = @host AND github_id = @githubId AND number = @number")
        .run({ ...pullRequestKey(pullRequest), worktreePath });
      return needPullRequest(pullRequest);
    }),
    recordCleanupError: (identity: PullRequestIdentity, worktreePath: string, error: string): PullRequestState => atomic(() => {
      requireText(error, "Cleanup error");
      const pullRequest = needPullRequest(identity);
      if (!pullRequest.cleanupPending || pullRequest.worktreePath !== worktreePath) throw new Error("The pending worktree does not match cleanup.");
      db.prepare("UPDATE pull_requests SET cleanup_error = @error WHERE host = @host AND github_id = @githubId AND number = @number")
        .run({ ...pullRequestKey(pullRequest), error });
      return needPullRequest(pullRequest);
    }),
    cancelCleanup: (identity: PullRequestIdentity, worktreePath: string, proof: OperationsStopped & ProcessesExcluded): PullRequestState => atomic(() => {
      requireStopped(proof);
      requireExcluded(proof);
      const pullRequest = needPullRequest(identity);
      if (pullRequest.state !== "open") throw new Error("Only a reopened PR can cancel pending worktree cleanup.");
      if (!pullRequest.cleanupPending || pullRequest.worktreePath !== worktreePath) throw new Error("The pending worktree does not match cleanup.");
      if (activeReview(pullRequest) !== null) throw new Error("An active review blocks worktree cleanup cancellation.");
      db.prepare("UPDATE pull_requests SET cleanup_pending = 0, cleanup_error = NULL WHERE host = @host AND github_id = @githubId AND number = @number").run(pullRequestKey(pullRequest));
      return needPullRequest(pullRequest);
    }),
    completeCleanup: (identity: PullRequestIdentity, worktreePath: string, proof: OperationsStopped & ProcessesExcluded): PullRequestState => atomic(() => {
      requireStopped(proof);
      requireExcluded(proof);
      const pullRequest = needPullRequest(identity);
      if (pullRequest.state === "open") throw new Error("A reopened PR must retain its worktree.");
      if (!pullRequest.cleanupPending || pullRequest.worktreePath !== worktreePath) throw new Error("The pending worktree does not match cleanup.");
      if (activeReview(pullRequest) !== null) throw new Error("An active review blocks worktree cleanup.");
      db.prepare("UPDATE pull_requests SET worktree_path = NULL, cleanup_pending = 0, cleanup_error = NULL WHERE host = @host AND github_id = @githubId AND number = @number").run(pullRequestKey(pullRequest));
      return needPullRequest(pullRequest);
    }),
  };
  const applyRepositoryPoll = (
    identity: RepositoryIdentity,
    update: RepositoryPollUpdate,
    now: number,
  ): RepositoryState => atomic(() => {
    if (update.kind === "initialize") {
      store.initializeRepository(identity, update.startPrNumber, now);
    } else if (update.kind === "snapshot") {
      if (needRepository(identity).startPrNumber === null) {
        throw new Error("Repository initialization has not completed.");
      }
      const observedNumbers = new Set<number>();
      for (const observation of update.observations) {
        if (observedNumbers.has(observation.number)) {
          throw new Error(`A repository snapshot contains duplicate PR ${observation.number}.`);
        }
        observedNumbers.add(observation.number);
        store.observePullRequest(identity, observation, now);
      }
    } else {
      throw new Error("Unsupported repository poll update.");
    }
    return store.recordPollSuccess(identity, now);
  });
  return { ...store, applyRepositoryPoll };
};

export type Store = ReturnType<typeof openStore>;
