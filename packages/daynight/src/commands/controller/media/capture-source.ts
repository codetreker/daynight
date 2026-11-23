import type Database from "better-sqlite3";
import { canonicalImageJson, imageId, parseStoredImageCaptureRequest, parseImageCaptureRequest, parseImageCaptureReceipt, parseDirectCaptureSubmission, type DirectCaptureSubmission, type ImageCaptureRequest, type ImageCaptureReceipt } from "../../../session/image-values.js";
import { parseSessionResource } from "../../../session/protocol.js";
import type { ControllerSnapshot } from "../lifecycle-store.js";
import type { TimelineStore } from "../content/timeline-store.js";
import { createHash } from "node:crypto";
import type { ImageOccurrence, MarkdownImageMetadata } from "../../../session/image-values.js";

type Transactions = { read<T>(action: () => T): T; write<T>(action: () => T): T };
type Capture = { request: ImageCaptureRequest; attemptId: string; attempts: string[]; receipt: ImageCaptureReceipt | null; submissions?: Record<string, DirectCaptureSubmission> };
export class ImageCapturePositionError extends Error {}
export class ImageCapturePendingAckError extends Error {}

/** A retry can only reuse the original durable occurrence and locator. */
export const createImageCaptureSource = (db: Database.Database, transactions: Transactions, snapshot: () => ControllerSnapshot, timeline?: () => TimelineStore) => {
  const key = (captureId: string) => `capture:${imageId(captureId)}`;
  const load = (captureId: string): Capture => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key(captureId)) as { value: string } | undefined;
    if (!row) throw new Error("Image capture has no registered original request.");
    const capture = JSON.parse(row.value) as Capture;
    parseStoredImageCaptureRequest(capture.request); imageId(capture.attemptId);
    if (!capture.attempts.includes(capture.attemptId)) throw new Error("Image capture attempt identity is corrupt.");
    return capture;
  };
  const save = (capture: Capture) => {
    const value = JSON.stringify(capture);
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key(capture.request.captureId), value);
  };
  const assertSource = (request: ImageCaptureRequest, classify = false) => {
    const row = db.prepare("SELECT occurrence,native_source,acknowledged FROM image_occurrences WHERE image_id=?").get(request.occurrence.imageId) as { occurrence: string; native_source: string | null; acknowledged: number } | undefined;
    if (!row) throw classify ? new ImageCapturePositionError("Image capture original occurrence is unavailable.") : new Error("Image capture requires its original acknowledged occurrence.");
    if (canonicalImageJson(JSON.parse(row.occurrence)) !== canonicalImageJson(request.occurrence) || canonicalImageJson(row.native_source === null ? null : JSON.parse(row.native_source)) !== canonicalImageJson(request.nativeSource)) throw classify ? new ImageCapturePositionError("Image capture original occurrence changed.") : new Error("Image capture requires its original acknowledged occurrence.");
    if (row.acknowledged !== 1) throw classify ? new ImageCapturePendingAckError("Image capture occurrence is not acknowledged.") : new Error("Image capture requires its original acknowledged occurrence.");
    const native = request.nativeSource, current = snapshot();
    if (native && native.nativeSessionId !== current.nativeSessionId || request.locator.kind === "native" && request.locator.nativeSessionId !== current.nativeSessionId) throw classify ? new ImageCapturePositionError("Image capture native target_changed.") : new Error("Image capture native target_changed.");
  };
  const assertPosition = (occurrence: ImageOccurrence, partIndex: number | null): string => {
    const entry = timeline?.().get(occurrence.entryId);
    if (!entry) throw new ImageCapturePositionError("Image capture original position is unavailable.");
    const markdown = (part: MarkdownImageMetadata, text: string): boolean => {
      if (part.partId !== occurrence.partId || createHash("sha256").update(text).digest("hex") !== part.textSha256) return false;
      return part.revision === occurrence.sourceRevision && part.textSha256 === occurrence.sourceTextSha256 && !!part.bindings?.some(binding => binding.imageId === occurrence.imageId)
        || part.retainedImages.some(binding => binding.imageId === occurrence.imageId && binding.sourceRevision === occurrence.sourceRevision && binding.sourceTextSha256 === occurrence.sourceTextSha256);
    };
    let found = false;
    if (occurrence.container === "reasoning" && entry.kind === "reasoning" && entry.markdown) found = markdown(entry.markdown, entry.text);
    else {
      const parts = occurrence.container === "content" && (entry.kind === "user_message" || entry.kind === "assistant_message") ? entry.content
        : occurrence.container === "tool_output" && entry.kind === "tool_call" && entry.callId === occurrence.callId ? entry.output : [];
      if (occurrence.partId === null) {
        const part = partIndex === null ? undefined : parts[partIndex];
        found = !!part && (part.type === "image" || part.type === "image_unavailable") && part.imageId === occurrence.imageId;
      } else found = parts.some(part => part.type === "markdown" && markdown(part, part.text));
    }
    if (!found) throw new ImageCapturePositionError("Image capture original position changed.");
    return entry.revision;
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
    getImageCaptureSubmission: (captureId: string, attemptId: string): DirectCaptureSubmission | null => transactions.read(() => load(captureId).submissions?.[attemptId] ?? null),
    imageCaptureProof: (captureId: string, attemptId: string): { sourceSeq: string } => transactions.read(() => {
      const capture = load(captureId);
      if (capture.attemptId !== attemptId) throw new Error("Image capture attempt conflict.");
      assertSource(capture.request, true);
      const row = db.prepare("SELECT source_sequence,acknowledged,part_index FROM image_occurrences WHERE image_id=?").get(capture.request.occurrence.imageId) as { source_sequence: string; acknowledged: number; part_index: number | null } | undefined;
      if (!row || BigInt(row.source_sequence) <= 0n) throw new Error("Image capture source sequence is corrupt.");
      const revision = assertPosition(capture.request.occurrence, row.part_index);
      const published = db.prepare("SELECT revision,source_sequence,position_visible FROM timeline_source_revisions WHERE entry_id=?").get(capture.request.occurrence.entryId) as { revision: string; source_sequence: string; position_visible: number } | undefined;
      if (!published || published.revision !== revision || published.position_visible !== 1) throw new ImageCapturePositionError("Image capture timeline revision has no original source event.");
      if (BigInt(published.source_sequence) <= 0n) throw new Error("Image capture timeline source sequence is corrupt.");
      const ack = db.prepare("SELECT CAST(last_acknowledged AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string };
      const sourceSeq = BigInt(row.source_sequence) > BigInt(published.source_sequence) ? row.source_sequence : published.source_sequence;
      if (row.acknowledged !== 1 || BigInt(sourceSeq) > BigInt(ack.sequence)) throw new ImageCapturePendingAckError("Image capture position is not acknowledged.");
      return { sourceSeq };
    }),
    freezeImageCaptureSubmission: (input: DirectCaptureSubmission, settleRetryFailure = false): DirectCaptureSubmission => transactions.write(() => {
      const submission = parseDirectCaptureSubmission(input), capture = load(submission.request.captureId);
      if (settleRetryFailure) {
        if (submission.outcome.kind !== "failed" || submission.attemptId === capture.request.attemptId || capture.attemptId !== submission.attemptId) throw new Error("Only the original retry can settle a missing position.");
      } else assertImageCaptureAttempt(submission.request.captureId, submission.attemptId);
      if (canonicalImageJson(submission.request) !== canonicalImageJson(capture.request)) throw new Error("Image capture submission changed its original request.");
      const previous = capture.submissions?.[submission.attemptId];
      if (previous && canonicalImageJson(previous) !== canonicalImageJson(submission) && !(settleRetryFailure && previous.outcome.kind === "validated")) throw new Error("Image capture submission changed its frozen outcome.");
      if (!previous || settleRetryFailure && previous.outcome.kind === "validated") { capture.submissions = { ...capture.submissions, [submission.attemptId]: submission }; save(capture); return submission; }
      return previous;
    }),
    assertImageCaptureAttempt,
    retryImageCaptureRequest: (captureId: string, attemptId: string, settleMissingPosition = false): ImageCaptureRequest => transactions.write(() => {
      imageId(attemptId); const capture = load(captureId); if (!settleMissingPosition) assertSource(capture.request);
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
