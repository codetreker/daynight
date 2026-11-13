import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ControllerLaunchTicket } from "../launch-ticket.js";
import type { ControllerOperation, ControllerOutboxEvent, ControllerSnapshot } from "../lifecycle-store.js";
import type { SessionContent } from "../content/session-content.js";
import type { SourceTimelineEntry } from "../../../session/controller-protocol.js";
import { canonicalImageJson, imageId, parseImageCaptureRequest, parseDirectCaptureSubmission, parseImageError, parseImagePart, parseInputObservation, parseLocalImagePreparation, parseNativeImageSource, parseValidatedImage, type ImageOccurrence, type InputObservation, type NativeImageSource } from "../../../session/image-values.js";
import { parseTimelineEntry, type MessagePart, type TimelineEntry } from "../../../session/protocol.js";
import { runSqliteImmediate, sqliteTransactionOutcome } from "../../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../../platform/sqlite-format.js";
import { controllerJournalFormat } from "../journal-format.js";
import { isOutboxFailure } from "../outbox-diagnostic.js";
import { withOutboxTransactionOutcome } from "../outbox-store.js";
import { nativeEntryId } from "../native-identity.js";
import type { controllerMetadataBudget } from "./metadata-budget.js";
import { restoreCanonicalInputIntent } from "./input-intent.js";
import type { CommittedImageProjectionSlot, NativeImageProjectionState, NativeInputPublicationIdentity, NativeInputPublicationQuery, NativeInputPublicationReceipt, NativeInputPublicationRequest, NativeInputPublicationResult, NativePublicationEntry } from "./native-publication-types.js";

type Context = {
  db: Database.Database;
  ticket: ControllerLaunchTicket;
  content: SessionContent;
  assertUsable(): void;
  quarantine(cause: unknown): void;
  read<T>(action: () => T): T;
  getSnapshot(): ControllerSnapshot;
  getOperation(operationId: string): ControllerOperation | null;
  associateInputMessage(operationId: string, nativeSessionId: string, entryId: string): string;
  projectTimeline(entry: SourceTimelineEntry): ControllerOutboxEvent | null;
  publishTimelineSnapshot(entry: TimelineEntry): ControllerOutboxEvent;
  registerImageOccurrence(occurrence: ImageOccurrence, source: NativeImageSource | null): { occurrence: ImageOccurrence; sourceSequence: string; acknowledged: boolean };
  metadataBudget: Pick<ReturnType<typeof controllerMetadataBudget>, "assert">;
};

type Saved = { receipt: NativeInputPublicationReceipt; slots: readonly CommittedImageProjectionSlot[] };
class PublicationConflict extends Error {}
function conflict(message: string): never { throw new PublicationConflict(message); }
const same = (left: unknown, right: unknown): boolean => canonicalImageJson(left) === canonicalImageJson(right);
const observationOf = (identity: NativeInputPublicationIdentity): InputObservation => {
  const { entryId, ...observation } = identity;
  imageId(entryId);
  return parseInputObservation(observation);
};
const imagePart = (part: MessagePart | undefined): part is NativeImageProjectionState["part"] => part?.type === "image" || part?.type === "image_unavailable";
const parseCaptureState = (value: unknown): NativeImageProjectionState => {
  const state = value as NativeImageProjectionState;
  if (!state || typeof state !== "object" || Object.keys(state).filter(key => key !== "resumeReserved" && key !== "submissionRefusal").sort().join(",") !== "attemptId,index,part,phase,request,submission,waitingForSource" || !Number.isSafeInteger(state.index) || state.index < 0 || typeof state.waitingForSource !== "boolean" || !["new", "preparing", "submit", "query", "settled"].includes(state.phase) || state.waitingForSource && state.phase !== "new" || state.resumeReserved !== undefined && (!["source", "submission"].includes(state.resumeReserved) || state.phase !== "query") || state.submissionRefusal !== undefined && state.phase !== "query") throw new Error("Native publication capture state is corrupt.");
  const request = parseImageCaptureRequest(state.request), part = parseImagePart(state.part), submission = state.submission === null ? null : parseDirectCaptureSubmission(state.submission);
  imageId(state.attemptId);
  if (state.submissionRefusal !== undefined) parseImageError(state.submissionRefusal);
  if (part.imageId !== request.occurrence.imageId || (state.phase === "submit" || state.resumeReserved === "submission") && !submission || state.resumeReserved === "source" && submission || submission && (!same(submission.request, request) || submission.attemptId !== state.attemptId)) throw new Error("Native publication capture progress is inconsistent.");
  return { ...state, request, part, submission };
};
const errorValue = (cause: unknown, unknown: boolean) => ({
  code: unknown ? "publication_unknown" as const : cause instanceof PublicationConflict ? "publication_conflict" as const : "publication_unavailable" as const,
  message: cause instanceof Error ? cause.message : "Native image publication did not complete.",
});

// Publication results remain serializable receipts. Runtime can synchronously
// fence an accounting failure without changing the provider's receipt contract.
const outboxFailures = new WeakMap<object, unknown>();
export const nativeInputPublicationFailure = (result: NativeInputPublicationResult): unknown => outboxFailures.get(result);

/** Native association facts and their visible content share the journal commit. */
export const createNativeInputPublication = (context: Context) => {
  const { db, ticket, content: sessionContent, metadataBudget } = context;
  const load = (operationId: string): Saved | null => {
    const row = db.prepare("SELECT request_hash,value FROM native_input_publications WHERE operation_id=?").get(operationId) as { request_hash: string; value: string } | undefined;
    if (!row) return null;
    const saved = JSON.parse(row.value) as Saved;
    if (!saved.receipt || saved.receipt.requestSha256 !== row.request_hash || saved.receipt.identity.operationId !== operationId || !Array.isArray(saved.slots)) throw new Error("Native publication receipt is corrupt.");
    return saved;
  };
  const loadSlot = (slot: CommittedImageProjectionSlot): CommittedImageProjectionSlot => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`native_provider:${slot.key}`) as { value: string } | undefined;
    if (!row) throw new Error("Native publication capture state is missing.");
    const state = parseCaptureState(JSON.parse(row.value));
    if (state.request.captureId !== slot.state.request.captureId || state.request.attemptId !== slot.state.request.attemptId || !same(state.request.occurrence, slot.state.request.occurrence) || !same(state.request.nativeSource, slot.state.request.nativeSource) || state.index !== slot.state.index) throw new Error("Native publication capture identity changed.");
    if (slot.original && (state.request.locator.kind !== "resource" || state.request.locator.resourceId !== slot.original.resourceId || state.part.type === "image" && state.part.resourceId !== slot.original.resourceId)) throw new Error("Native publication original resource identity changed.");
    return { ...slot, state };
  };
  const committed = (saved: Saved, identity: NativeInputPublicationIdentity): Extract<NativeInputPublicationResult, { state: "committed" }> => {
    if (!same(saved.receipt.identity, identity)) conflict("Native publication identity conflicts with the original operation.");
    const entry = sessionContent.timeline.get(identity.entryId);
    if (!entry || entry.kind !== "user_message" || BigInt(entry.revision) < BigInt(saved.receipt.publicationRevision)) throw new Error("Native publication has no current committed entry.");
    const slots = saved.slots.map(loadSlot);
    for (const slot of slots) {
      const part = entry.content[slot.state.index];
      if (!imagePart(part) || part.imageId !== slot.state.request.occurrence.imageId) throw new Error("Native publication lost its committed image position.");
    }
    return { state: "committed", receipt: saved.receipt, view: { entry: entry as NativePublicationEntry, slots } };
  };
  const validateEvidence = (request: NativeInputPublicationRequest): void => {
    const observation = observationOf(request.identity), operation = context.getOperation(observation.operationId);
    if (ticket.provider !== observation.provider || context.getSnapshot().nativeSessionId !== observation.nativeSessionId || !operation || operation.kind !== "send_message" || !["provider_accepted", "confirmed"].includes(operation.state)) conflict("Native publication has no accepted original operation.");
    const intent = db.prepare("SELECT canonical,sha256 FROM input_intents WHERE operation_id=?").get(observation.operationId) as { canonical: string; sha256: string } | undefined;
    const receipt = db.prepare("SELECT observation FROM input_observations WHERE operation_id=?").get(observation.operationId) as { observation: string } | undefined;
    if (!intent || intent.sha256 !== observation.intentSha256 || !receipt || !same(JSON.parse(receipt.observation), observation)) conflict("Native publication lacks its original durable acceptance evidence.");
    const command = restoreCanonicalInputIntent(intent, observation.operationId);
    if (command.kind !== "send_message") conflict("Native publication intent is not an image message.");
    const originals = command.payload.content.filter(part => part.type === "image");
    if (!originals.length || originals.length > 8 || request.originals.length !== originals.length || request.seed.nativeSlots.length !== originals.length) conflict("Native publication changed the original image group.");
    if (request.seed.entry.entryId !== request.identity.entryId || request.seed.entry.kind !== "user_message") conflict("Native publication changed the original message owner.");
    parseTimelineEntry({ ...request.seed.entry, imageProjectionError: request.seed.entry.imageProjectionError ?? null, revision: "1", entrySeq: "1" });
    const indexes = new Set<number>(), mapped = new Set<number>();
    for (const [ordinal, slot] of request.seed.nativeSlots.entries()) {
      parseNativeImageSource(slot.nativeSource);
      if (!Number.isSafeInteger(slot.index) || slot.index < 0 || !imagePart(request.seed.entry.content[slot.index]) || indexes.has(slot.index) || ordinal > 0 && slot.index <= request.seed.nativeSlots[ordinal - 1]!.index || !slot.label || !slot.label.isWellFormed() || Buffer.byteLength(slot.label) > 1024) conflict("Native publication has an invalid native image position.");
      indexes.add(slot.index);
      if (slot.nativeSource.provider !== observation.provider || slot.nativeSource.nativeSessionId !== observation.nativeSessionId || slot.nativeSource.nativeMessageId !== observation.nativeMessageId) conflict("Native publication source differs from its accepted message.");
    }
    for (const [index, original] of request.originals.entries()) {
      const input = originals[index]!; imageId(original.imageId); imageId(original.resourceId); parseNativeImageSource(original.appendNativeSource);
      if (input.imageId !== original.imageId || input.resourceId !== original.resourceId || request.seed.nativeSlots[index]!.index !== original.nativeSlotIndex || !indexes.has(original.nativeSlotIndex) || mapped.has(original.nativeSlotIndex)) conflict("Native publication changed the original image identities or order.");
      mapped.add(original.nativeSlotIndex);
      if (original.appendNativeSource.provider !== observation.provider || original.appendNativeSource.nativeSessionId !== observation.nativeSessionId || original.appendNativeSource.nativeMessageId !== observation.nativeMessageId) conflict("Native publication append source differs from its accepted message.");
      const resource = sessionContent.resourceFiles.resources.get(original.resourceId)?.resource;
      if (!resource || resource.status !== "available" || resource.sha256 !== input.sha256 || resource.byteLength !== input.byteLength) conflict("Native publication original resource is unavailable or changed.");
      const metadata = parseValidatedImage({ mediaType: resource.mediaType, byteLength: resource.byteLength, sha256: resource.sha256, width: resource.width, height: resource.height, frameCount: resource.frameCount });
      const prepared = db.prepare("SELECT value FROM image_preparations WHERE upload_id=?").get(input.uploadId) as { value: string } | undefined;
      if (prepared) {
        const preparation = parseLocalImagePreparation(JSON.parse(prepared.value).receipt);
        if (preparation.imageId !== original.imageId || preparation.uploadId !== input.uploadId || !same(preparation.target, command.payload.target) || preparation.validated && !same(preparation.validated, metadata)) conflict("Native publication original resource differs from its prepared image.");
      }
    }
  };
  const slot = (identity: NativeInputPublicationIdentity, index: number, nativeSource: NativeImageSource, part: NativeImageProjectionState["part"], original?: { imageId: string; resourceId: string }, requireExisting = false): CommittedImageProjectionSlot => {
    const sourceKey = canonicalImageJson([1, nativeSource, identity.entryId, "content", null, index]);
    const expectedImageId = original?.imageId ?? nativeEntryId(identity.nativeSessionId, `image:${sourceKey}`);
    if (part.imageId !== expectedImageId) conflict("Native publication cannot replace an already published image identity.");
    const key = `image-slot:${nativeEntryId(identity.nativeSessionId, sourceKey)}`;
    const occurrence: ImageOccurrence = { imageId: expectedImageId, entryId: identity.entryId, container: "content", partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey };
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`native_provider:${key}`) as { value: string } | undefined;
    let state: NativeImageProjectionState;
    if (row) {
      state = parseCaptureState(JSON.parse(row.value));
      if (state.index !== index || state.request.captureId !== nativeEntryId(expectedImageId, "capture") || state.request.attemptId !== nativeEntryId(expectedImageId, "attempt") || !same(state.request.occurrence, occurrence) || !same(state.request.nativeSource, nativeSource) || state.part.imageId !== expectedImageId) conflict("Native publication conflicts with its existing capture identity.");
      if (original && (state.request.locator.kind !== "resource" || state.request.locator.resourceId !== original.resourceId || state.part.type === "image" && state.part.resourceId !== original.resourceId)) conflict("Native publication original locator changed.");
    } else {
      if (requireExisting) conflict("Native publication cannot establish the source of an existing original image.");
      state = { request: { captureId: nativeEntryId(expectedImageId, "capture"), attemptId: nativeEntryId(expectedImageId, "attempt"), occurrence, nativeSource, locator: original ? { kind: "resource", resourceId: original.resourceId } : { kind: "native", ...nativeSource } }, attemptId: nativeEntryId(expectedImageId, "attempt"), index, waitingForSource: false, phase: "new", part, submission: null };
      const encoded = JSON.stringify(state); metadataBudget.assert(Buffer.byteLength(encoded) + 16384, true);
      db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(`native_provider:${key}`, encoded);
    }
    return { key, label: state.part.label, ...(original ? { original } : {}), state };
  };
  return {
    publishNativeInputAssociation(input: NativeInputPublicationRequest): NativeInputPublicationResult {
      let request: NativeInputPublicationRequest, hash: string;
      try {
        const canonical = canonicalImageJson(input);
        if (Buffer.byteLength(canonical) > 1_048_576) throw new Error("Native publication metadata exceeds its bound.");
        request = JSON.parse(canonical) as NativeInputPublicationRequest;
        hash = createHash("sha256").update(canonical).digest("hex");
      } catch (cause) { return { state: "not_committed", error: errorValue(cause, false) }; }
      try {
        context.assertUsable();
        if (db.inTransaction) throw new Error("Native publication requires an independent transaction boundary.");
        return runSqliteImmediate(db, () => {
          assertCurrentSqlite(db, controllerJournalFormat); validateEvidence(request);
          const previous = load(request.identity.operationId);
          if (previous) {
            if (previous.receipt.requestSha256 !== hash) conflict("Native publication replay changed the original request.");
            return committed(previous, request.identity);
          }
          if (context.associateInputMessage(request.identity.operationId, request.identity.nativeSessionId, request.identity.entryId) !== request.identity.entryId) conflict("Native publication conflicts with its original message owner.");
          const current = sessionContent.timeline.get(request.identity.entryId);
          if (current && current.kind !== "user_message") conflict("Native publication cannot replace another entry kind.");
          const content = [...(current?.kind === "user_message" ? current.content : request.seed.entry.content)];
          const slots: CommittedImageProjectionSlot[] = [];
          const positions = request.originals.map(original => current ? content.findIndex(part => imagePart(part) && part.imageId === original.imageId) : -1);
          const reuse = positions.some(index => index !== -1);
          if (reuse && (positions.some(index => index === -1) || positions.some((index, ordinal) => ordinal > 0 && index <= positions[ordinal - 1]!))) conflict("Native publication changed the original image group or order.");
          const inPlace = reuse && request.originals.every((original, ordinal) => original.nativeSlotIndex === positions[ordinal]);
          if (reuse && !inPlace && positions.some(index => request.seed.nativeSlots.some(native => native.index === index))) conflict("Native publication mixed original and native image positions.");
          if (current) for (const native of request.seed.nativeSlots) {
            if (inPlace) continue;
            const part = content[native.index];
            if (!imagePart(part)) conflict("Native publication lost an original native image position.");
            slots.push(slot(request.identity, native.index, native.nativeSource, part));
          }
          for (const [ordinal, original] of request.originals.entries()) {
            const index = reuse ? positions[ordinal]! : current ? content.length : original.nativeSlotIndex;
            const source = current && !inPlace ? original.appendNativeSource : request.seed.nativeSlots.find(native => native.index === index)!.nativeSource;
            const part = reuse ? content[index] : { type: "image" as const, imageId: original.imageId, resourceId: original.resourceId, label: "Original uploaded image" };
            if (!imagePart(part) || part.type === "image" && part.resourceId !== original.resourceId) conflict("Native publication original resource changed at its existing position.");
            content[index] = part; slots.push(slot(request.identity, index, source, part, { imageId: original.imageId, resourceId: original.resourceId }, reuse));
          }
          // A capture receipt can reach durable state before its timeline patch.
          // Publish from that saved progress while preserving every image identity.
          for (const item of slots) content[item.state.index] = item.state.part;
          if (content.some((part, index) => imagePart(part) && !slots.some(item => item.state.index === index))) conflict("Native publication has an image without its durable source.");
          const entry = { ...(current ?? request.seed.entry), imageProjectionError: current?.imageProjectionError ?? request.seed.entry.imageProjectionError ?? null, revision: current?.revision ?? "1", content } as SourceTimelineEntry;
          const changed = context.projectTimeline(entry);
          const published = sessionContent.timeline.get(request.identity.entryId);
          if (!published || published.kind !== "user_message") throw new Error("Native publication has no staged SQL entry.");
          const event = changed ?? context.publishTimelineSnapshot(published);
          for (const item of slots) context.registerImageOccurrence(item.state.request.occurrence, item.state.request.nativeSource);
          const receipt: NativeInputPublicationReceipt = { identity: request.identity, requestSha256: hash, publicationRevision: published.revision, sourceSequence: event.sequence, originalSlots: slots.flatMap(item => item.original ? [{ ...item.original, index: item.state.index }] : []) };
          const saved: Saved = { receipt, slots }, encoded = JSON.stringify(saved); metadataBudget.assert(Buffer.byteLength(encoded) + 16384, true);
          db.prepare("INSERT INTO native_input_publications VALUES(?,?,?,?,?,?)").run(request.identity.operationId, request.identity.provider, request.identity.nativeSessionId, request.identity.nativeMessageId, hash, encoded);
          for (const original of receipt.originalSlots) db.prepare("INSERT INTO native_input_publication_images VALUES(?,?,?,?)").run(request.identity.operationId, original.imageId, original.resourceId, original.index);
          return committed(saved, request.identity);
        });
      } catch (cause) {
        const outcome = sqliteTransactionOutcome(cause), unknown = !["not-started", "rolled-back"].includes(outcome);
        if (unknown && db.open && db.inTransaction) context.quarantine(cause);
        const result: NativeInputPublicationResult = { state: unknown ? "unknown" : "not_committed", error: errorValue(cause, unknown) };
        if (isOutboxFailure(cause)) outboxFailures.set(result, withOutboxTransactionOutcome(cause, outcome));
        return result;
      }
    },
    queryNativeInputAssociation(identity: NativeInputPublicationIdentity): NativeInputPublicationQuery {
      try {
        context.assertUsable();
        if (db.inTransaction) throw new Error("Native publication query cannot observe an unresolved transaction.");
        observationOf(identity);
        return context.read(() => {
          if (identity.provider !== ticket.provider || identity.nativeSessionId !== context.getSnapshot().nativeSessionId) conflict("Native publication query belongs to another native session.");
          const saved = load(identity.operationId);
          return saved ? committed(saved, identity) : { state: "absent" };
        });
      } catch (cause) { return { state: "unknown", error: errorValue(cause, true) }; }
    },
  };
};
