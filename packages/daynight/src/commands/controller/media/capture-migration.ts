import type Database from "better-sqlite3";
import { canonicalImageJson, imageId, parseDirectCaptureSubmission, parseImageCaptureRequest, parseImagePart, parseValidatedImage, type DirectCaptureSubmission, type ImageCaptureRequest, type ImageError, type ImagePart, type ImageUnavailablePart, type ValidatedImage } from "../../../session/image-values.js";
import type { NativeImageProjectionState } from "./native-publication-types.js";
import type { MarkdownCaptureRecord } from "../markdown/coordinator.js";

type LegacyNativeState = {
  request: ImageCaptureRequest; index: number; waitingForSource: boolean;
  phase: "new" | "query" | "reserved" | "commit" | "failure" | "settled";
  unknownAction: "register" | "commit" | "failure" | null;
  part: ImagePart | ImageUnavailablePart; validated: ValidatedImage | null;
};
type CaptureOwner = { request: ImageCaptureRequest; attemptId: string };
type LegacyMarkdownRecord = MarkdownCaptureRecord & {
  observeOnly?: boolean;
  retryControl?: { attemptId: string; after: number } & ({ action: "failure"; error: ImageError } | { action: "commit"; validated: ValidatedImage });
};

/** Upgrade retained capture facts in the journal transaction, without source IO. */
export const migrateDirectCaptureState = (db: Database.Database, sql: string, assertWrite: (bytes: number) => void): undefined => {
  const owner = (request: ImageCaptureRequest): CaptureOwner => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`capture:${request.captureId}`) as { value: string } | undefined;
    if (!row) return { request, attemptId: request.attemptId };
    const capture = JSON.parse(row.value) as CaptureOwner;
    const original = parseImageCaptureRequest(capture.request);
    imageId(capture.attemptId);
    if (canonicalImageJson({ ...request, attemptId: original.attemptId }) !== canonicalImageJson(original)) throw new Error("Legacy capture owner conflicts with its original request.");
    return { request: original, attemptId: capture.attemptId };
  };
  const sealed = (captureId: string, attemptId: string): ValidatedImage | null => {
    const row = db.prepare("SELECT validated FROM image_captures WHERE capture_id=?").get(`${captureId}:${attemptId}`) as { validated: string } | undefined;
    return row ? parseValidatedImage(JSON.parse(row.validated)) : null;
  };
  const submission = (capture: CaptureOwner, outcome: DirectCaptureSubmission["outcome"]): DirectCaptureSubmission => parseDirectCaptureSubmission({ ...capture, outcome });
  const native = (value: unknown): NativeImageProjectionState => {
    const old = value as LegacyNativeState, request = parseImageCaptureRequest(old.request), capture = owner(request), part = parseImagePart(old.part);
    if (!["new", "query", "reserved", "commit", "failure", "settled"].includes(old.phase) || !Number.isSafeInteger(old.index) || old.index < 0 || typeof old.waitingForSource !== "boolean" || old.waitingForSource && old.phase !== "new") throw new Error("Legacy native capture state is invalid.");
    let frozen: DirectCaptureSubmission | null = null;
    if (capture.attemptId === request.attemptId && old.phase !== "new" && old.phase !== "settled") {
      if (old.phase === "failure" || old.unknownAction === "failure") {
        if (part.type !== "image_unavailable") throw new Error("Legacy native failure has no original error.");
        frozen = submission(capture, { kind: "failed", error: part.error });
      } else if (request.locator.kind === "resource") frozen = submission(capture, { kind: "resource" });
      else {
        const validated = old.validated === null ? sealed(request.captureId, request.attemptId) : parseValidatedImage(old.validated);
        if (validated) frozen = submission(capture, { kind: "validated", validated });
      }
    }
    const phase: NativeImageProjectionState["phase"] = old.phase === "settled" ? "settled"
      : capture.attemptId !== request.attemptId || old.phase === "query" ? "query"
        : frozen ? "submit" : old.phase === "new" ? "new" : "preparing";
    const resumeReserved = phase === "query" && capture.attemptId === request.attemptId
      ? frozen ? "submission" as const : old.unknownAction === "register" ? "source" as const : undefined
      : undefined;
    return { request: capture.request, attemptId: capture.attemptId, index: old.index, waitingForSource: old.waitingForSource, phase, part, submission: frozen, ...(resumeReserved ? { resumeReserved } : {}) };
  };
  const update = (key: string, value: unknown): void => {
    const encoded = JSON.stringify(value); assertWrite(Buffer.byteLength(encoded) + 16384);
    db.prepare("UPDATE image_runtime_state SET value=? WHERE key=?").run(encoded, key);
  };
  const rows = db.prepare("SELECT key,value FROM image_runtime_state WHERE key GLOB 'native_provider:image-slot:*' OR key GLOB 'markdown:source:*' ORDER BY key").all() as { key: string; value: string }[];
  for (const row of rows) {
    if (row.key.startsWith("native_provider:")) { update(row.key, native(JSON.parse(row.value))); continue; }
    const old = JSON.parse(row.value) as LegacyMarkdownRecord;
    const { retryControl, observeOnly, ...record } = old;
    if (!record.request || record.phase === "settled") { update(row.key, record); continue; }
    const request = parseImageCaptureRequest(record.request), capture = owner(request);
    let outcome: DirectCaptureSubmission["outcome"] | null = null;
    if (capture.attemptId === request.attemptId) {
      if (retryControl?.action === "failure") outcome = { kind: "failed", error: retryControl.error };
      else if (retryControl?.action === "commit") outcome = { kind: "validated", validated: retryControl.validated };
      else if (record.error && record.phase !== "waiting") outcome = { kind: "failed", error: record.error };
      else if (record.phase === "unknown" && request.locator.kind === "resource") outcome = { kind: "resource" };
      else if (record.phase === "validated" || record.phase === "unknown" && observeOnly) {
        const validated = sealed(request.captureId, request.attemptId);
        if (validated && record.sourceAdmission?.attemptId === request.attemptId && canonicalImageJson(record.sourceAdmission.validated) === canonicalImageJson(validated)) outcome = { kind: "validated", validated };
      }
    }
    if (outcome) {
      record.submission = submission({ request: capture.request, attemptId: request.attemptId }, outcome);
      record.dispatchPending = !!retryControl || record.phase === "validated";
      if (!record.dispatchPending) record.resumeReserved = "submission";
      record.phase = "unknown";
      if (retryControl) record.cooldownUntil = Math.max(record.cooldownUntil, retryControl.after);
    } else if (record.phase === "unknown" || record.awaitingRetry || capture.attemptId !== request.attemptId) {
      if (!record.started && !record.awaitingRetry && !observeOnly && capture.attemptId === request.attemptId) record.resumeReserved = "source";
      record.awaitingRetry = true; record.phase = "unknown";
    }
    update(row.key, record);
  }
  const publications = db.prepare("SELECT operation_id,value FROM native_input_publications").all() as { operation_id: string; value: string }[];
  for (const row of publications) {
    const value = JSON.parse(row.value) as { slots: { state: unknown }[] };
    value.slots = value.slots.map(slot => ({ ...slot, state: native(slot.state) }));
    const encoded = JSON.stringify(value); assertWrite(Buffer.byteLength(encoded) + 16384);
    db.prepare("UPDATE native_input_publications SET value=? WHERE operation_id=?").run(encoded, row.operation_id);
  }
  db.exec(sql);
};
