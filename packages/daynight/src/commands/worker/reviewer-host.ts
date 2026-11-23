import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { configurationDefaults } from "../review/config.js";
import { resolveWorkerReviewPaths } from "../review/paths.js";
import { hasRetainedWorkerReviewFailure, isConfirmedWorkerReviewFailure, runWorkerReview } from "../review/runtime.js";
export { reconcileWorkerReviewFailure as reconcileReviewerHostFailure } from "../review/runtime.js";
import { createReviewerSource } from "./reviewer-source.js";
import { OperationError } from "../../api/operation.js";
import type { WorkerEvent } from "./execution.js";

export const runReviewerHost = async (options: {
  homeDirectory: string; packageDirectory: string; serverOrigin: string; serverToken: string;
  userId: string; workerId: string; signal: AbortSignal; emit: (event: WorkerEvent) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> => {
  const paths = resolveWorkerReviewPaths(options.homeDirectory);
  const source = createReviewerSource(options);
  let runtime: Promise<void> | undefined;
  let failed = false;
  let retained = false;
  let runtimeFailure: unknown;
  const retainedFailures = new Set<unknown>();
  const start = (): void => {
    if (runtime !== undefined) return;
    const job = runWorkerReview(paths, { packageDirectory: options.packageDirectory, signal: options.signal, source: source.source,
      log: event => {
        const identity = [event.repository, event.number === undefined ? undefined : `PR ${event.number}`,
          event.reviewId === undefined ? undefined : `review=${event.reviewId}`, event.revision === undefined ? undefined : `revision=${event.revision}`,
          event.attempt === undefined ? undefined : `attempt=${event.attempt}`, event.retryAt === undefined ? undefined : `retryAt=${new Date(event.retryAt).toISOString()}`].filter(value => value !== undefined).join(" ");
        options.emit({ kind: `reviewer-${event.level}`, component: "reviewer", phase: event.phase, message: `${identity === "" ? "" : `${identity} `}${event.message}`,
          ...(event.error === undefined ? {} : { error: event.error }) });
      } });
    runtime = job.then(() => { runtimeFailure = undefined; }).catch(error => {
      const cause = error instanceof Error && isConfirmedWorkerReviewFailure(error) ? error.cause : error;
      if (options.signal.aborted && (cause === options.signal.reason || cause instanceof OperationError && cause.kind === "cancelled" && cause.cause === options.signal.reason)) return;
      runtimeFailure = error;
      if (hasRetainedWorkerReviewFailure(error)) retainedFailures.add(error);
      options.emit({ kind: "reviewer-error", component: "reviewer", phase: "runtime", message: options.signal.aborted ? "Reviewer shutdown failed." : "Reviewer runtime failed; retry is scheduled.", error });
    }).finally(() => { runtime = undefined; });
  };
  try { await access(paths.databaseFile); retained = true; } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) retained = true;
  }
  if (retained) start();
  while (!options.signal.aborted) {
    try {
      await source.poll(options.signal);
      if (failed) options.emit({ kind: "reviewer-recovered", component: "reviewer", phase: "poll", message: "Reviewer polling recovered." });
      failed = false;
      if (source.source.snapshot().kind === "enabled") retained = true;
      if (retained) start();
    } catch (error) {
      if (options.signal.aborted) break;
      failed = true;
      if (retained) start();
      options.emit({ kind: "reviewer-error", component: "reviewer", phase: "poll", message: "Reviewer polling failed; the next poll will retry.", error });
    }
    try { await (options.wait === undefined ? delay(configurationDefaults.pollIntervalMs, undefined, { signal: options.signal }) : options.wait(configurationDefaults.pollIntervalMs, options.signal)); } catch { if (!options.signal.aborted) throw new Error("Reviewer polling wait failed."); }
  }
  await runtime;
  const failures = [...retainedFailures].filter(hasRetainedWorkerReviewFailure);
  if (runtimeFailure !== undefined && !failures.includes(runtimeFailure)) failures.push(runtimeFailure);
  if (failures.length > 1) throw new AggregateError(failures, "Original Reviewer resources remain owned after shutdown.");
  if (failures.length === 1) throw failures[0];
};
