import type Database from "better-sqlite3";
import { canonicalImageJson, imageId, parseImageCaptureRequest, parseImageCaptureReceipt, parseDirectCaptureSubmission, type DirectCaptureSubmission, type ImageCaptureRequest, type ImageCaptureReceipt } from "../../../session/image-values.js";
import { parseSessionResource } from "../../../session/protocol.js";
import type { ControllerSnapshot } from "../lifecycle-store.js";
import type { controllerMetadataBudget } from "./metadata-budget.js";

type Transactions = { read<T>(action: () => T): T; write<T>(action: () => T): T };
type Capture = { request: ImageCaptureRequest; attemptId: string; attempts: string[]; receipt: ImageCaptureReceipt | null; submissions?: Record<string, DirectCaptureSubmission> };

/** A retry can only reuse the original durable occurrence and locator. */
export const createImageCaptureSource = (db: Database.Database, transactions: Transactions, snapshot: () => ControllerSnapshot, budget: ReturnType<typeof controllerMetadataBudget>) => {
  const key = (captureId: string) => `capture:${imageId(captureId)}`;
  const load = (captureId: string): Capture => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key(captureId)) as { value: string } | undefined;
    if (!row) throw new Error("Image capture has no registered original request.");
    const capture = JSON.parse(row.value) as Capture;
    parseImageCaptureRequest(capture.request); imageId(capture.attemptId);
    if (!capture.attempts.includes(capture.attemptId)) throw new Error("Image capture attempt identity is corrupt.");
    return capture;
  };
  const save = (capture: Capture) => {
    const value = JSON.stringify(capture); budget.assert(Buffer.byteLength(value) + 16384, true);
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key(capture.request.captureId), value);
  };
  const assertSource = (request: ImageCaptureRequest) => {
    const row = db.prepare("SELECT occurrence,native_source,acknowledged FROM image_occurrences WHERE image_id=?").get(request.occurrence.imageId) as { occurrence: string; native_source: string | null; acknowledged: number } | undefined;
    if (!row || row.acknowledged !== 1 || canonicalImageJson(JSON.parse(row.occurrence)) !== canonicalImageJson(request.occurrence) || canonicalImageJson(row.native_source === null ? null : JSON.parse(row.native_source)) !== canonicalImageJson(request.nativeSource)) throw new Error("Image capture requires its original acknowledged occurrence.");
    const native = request.nativeSource, current = snapshot();
    if (native && native.nativeSessionId !== current.nativeSessionId || request.locator.kind === "native" && request.locator.nativeSessionId !== current.nativeSessionId) throw new Error("Image capture native target_changed.");
  };
  const assertImageCaptureAttempt = (captureId: string, attemptId: string, imageId?: string): ImageCaptureRequest => transactions.read(() => {
    const capture = load(captureId);
    if (capture.attemptId !== attemptId || imageId !== undefined && capture.request.occurrence.imageId !== imageId) throw new Error("Image capture attempt conflict.");
    assertSource(capture.request);
    return { ...capture.request, attemptId };
  });
  const validateReceipt = (input: ImageCaptureReceipt, reconcileAttempt: boolean, expectedAttempt?: string) => {
    const receipt = parseImageCaptureReceipt(input, parseSessionResource), capture = load(receipt.captureId);
    if (expectedAttempt !== undefined && capture.attemptId !== expectedAttempt) throw new Error("Image capture attempt changed during receipt reconciliation.");
    if (canonicalImageJson(receipt.occurrence) !== canonicalImageJson(capture.request.occurrence)) throw new Error("Image capture receipt occurrence conflict.");
    if (receipt.attemptId !== capture.attemptId && (!reconcileAttempt || capture.attempts.includes(receipt.attemptId) || capture.receipt && BigInt(receipt.revision) <= BigInt(capture.receipt.revision))) throw new Error("Image capture receipt attempt conflict.");
    if (capture.receipt && (BigInt(receipt.revision) < BigInt(capture.receipt.revision) || receipt.revision === capture.receipt.revision && canonicalImageJson(receipt) !== canonicalImageJson(capture.receipt))) throw new Error("Image capture receipt revision conflict.");
    return { receipt, capture };
  };
  return {
    registerImageCaptureRequest: (input: ImageCaptureRequest): ImageCaptureRequest => transactions.write(() => {
      const request = parseImageCaptureRequest(input); assertSource(request);
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key(request.captureId)) as { value: string } | undefined;
      if (row) {
        const capture = load(request.captureId);
        if (canonicalImageJson(capture.request) !== canonicalImageJson(request)) throw new Error("Image capture original request conflict.");
        return capture.request;
      }
      save({ request, attemptId: request.attemptId, attempts: [request.attemptId], receipt: null }); return request;
    }),
    getImageCaptureRequest: (captureId: string): ImageCaptureRequest => transactions.read(() => load(captureId).request),
    getImageCaptureAttempt: (captureId: string): string => transactions.read(() => load(captureId).attemptId),
    freezeImageCaptureSubmission: (input: DirectCaptureSubmission): DirectCaptureSubmission => transactions.write(() => {
      const submission = parseDirectCaptureSubmission(input), capture = load(submission.request.captureId);
      assertImageCaptureAttempt(submission.request.captureId, submission.attemptId);
      if (canonicalImageJson(submission.request) !== canonicalImageJson(capture.request)) throw new Error("Image capture submission changed its original request.");
      const previous = capture.submissions?.[submission.attemptId];
      if (previous && canonicalImageJson(previous) !== canonicalImageJson(submission)) throw new Error("Image capture submission changed its frozen outcome.");
      if (!previous) { capture.submissions = { ...capture.submissions, [submission.attemptId]: submission }; save(capture); }
      return previous ?? submission;
    }),
    assertImageCaptureAttempt,
    retryImageCaptureRequest: (captureId: string, attemptId: string): ImageCaptureRequest => transactions.write(() => {
      imageId(attemptId); const capture = load(captureId); assertSource(capture.request);
      if (!["local", "external"].includes(capture.request.locator.kind)) throw new Error("Image capture source does not support retry.");
      if (capture.attemptId === attemptId) return { ...capture.request, attemptId };
      if (capture.attempts.includes(attemptId)) throw new Error("Image capture attempt conflict.");
      // Receipt revisions belong to the capture, including across source attempts.
      capture.attemptId = attemptId; capture.attempts.push(attemptId); save(capture);
      return { ...capture.request, attemptId };
    }),
    validateImageCaptureReceipt: (input: ImageCaptureReceipt, reconcileAttempt = false, expectedAttempt?: string): void => transactions.read(() => { validateReceipt(input, reconcileAttempt, expectedAttempt); }),
    observeImageCaptureReceipt: (input: ImageCaptureReceipt, reconcileAttempt = false, expectedAttempt?: string): ImageCaptureReceipt => transactions.write(() => {
      const { receipt, capture } = validateReceipt(input, reconcileAttempt, expectedAttempt);
      if (receipt.attemptId !== capture.attemptId) {
        // A service query can observe a retry whose request never reached this
        // connection. It cannot revive a previous attempt or roll back revision.
        capture.attemptId = receipt.attemptId; capture.attempts.push(receipt.attemptId);
      }
      capture.receipt = receipt; save(capture); return receipt;
    }),
  };
};
