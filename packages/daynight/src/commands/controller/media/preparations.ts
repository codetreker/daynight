import { createImageCaptureSource } from "./capture-source.js";
import { captureSourceReservations } from "./capture-reservations.js";
export type { CaptureSourceLease } from "./capture-reservations.js";
import { openNativeMediaSpool, type NativeMediaSpool } from "./native-spool.js";
import { controllerMetadataBudget, CONTROLLER_METADATA_BYTES, CONTROLLER_SETTLEMENT_BYTES } from "./metadata-budget.js";
import { ImageReleaseStorageError, isImageReleaseStorageFailure } from "./release-error.js";
import { openMediaBudgetLedger } from "./budget-ledger.js";
import { controllerMediaDiskBytes } from "./disk-budget.js";
import type Database from "better-sqlite3";
import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, linkSync, mkdirSync, openSync, readSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { IMAGE_LIMITS, canonicalImageJson, imageDecimal, imageId, parseImageCaptureReceipt, parseImageReadRequest, parseImageUploadSpec, parseValidatedImage, type ImageReadChunk, type ImageUploadSpec, type LocalImagePreparation, type PreparedImageChunk, type ImageCaptureRequest, type DisplayMime, type SessionInput, type ValidatedImage, parseNativeImageSource } from "../../../session/image-values.js";
import { parseSessionResource, sessionBinding, type SessionResource } from "../../../session/protocol.js";
import type { ControllerLaunchTicket } from "../launch-ticket.js";
import type { ControllerSnapshot } from "../lifecycle-store.js";
import type { ResourceFiles, ControlledResourceLease } from "../content/resource-files.js";
import { writeDurableJson } from "../../../platform/durable-json.js";
import type { NativeInput, NativeImagePart } from "../providers/types.js";
import { bundledImageDecoder, type ImageDecoder } from "./image-decoder.js";

type Preparation = { spec: ImageUploadSpec; filename: string; receipt: LocalImagePreparation; decoding: boolean };
type Transactions = { read<T>(action: () => T): T; write<T>(action: () => T): T };
export type CaptureStageInput = { captureId: string; attemptId: string; imageId: string; inputPath: string; byteLength: string; sha256: string; declaredMediaType?: DisplayMime | null };
export type ControllerMediaBlockLease = { close(): void };
export type CaptureReadPolicyLease = { verify(): void; close(): void };
export type CaptureReadPolicy = (request: ImageCaptureRequest) => CaptureReadPolicyLease;
export type NativeInputLease = { readonly input: NativeInput; verify(): void; retain(): void; close(): void };
const syncDirectory = (directory: string) => { if (process.platform !== "win32") { const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } };
const checkedDirectory = (directory: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let part = path.parse(directory).root;
  for (const component of directory.slice(part.length).split(path.sep).filter(Boolean)) { part = path.join(part, component); if (lstatSync(part).isSymbolicLink()) throw new Error("Media directory contains an untrusted symbolic link."); }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Media directory must be private.");
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const snapshotTarget = (ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot) => ({ serverOrigin: ticket.serverOrigin, fence: { sessionId: ticket.sessionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration }, expectedNativeSessionId: snapshot.nativeSessionId });

/** Local validation never publishes a service-owned available resource receipt. */
export const openControllerMediaStore = (file: string, ticket: ControllerLaunchTicket, db: Database.Database, content: ResourceFiles, transactions: Transactions, snapshot: () => ControllerSnapshot, decoder: ImageDecoder = bundledImageDecoder(), stateDirectory = path.dirname(file)) => {
  const root = `${file}.media-staging`, nativeRoot = path.join(root, "native"), wireRoot = path.join(root, "wire");
  checkedDirectory(root); checkedDirectory(nativeRoot); checkedDirectory(wireRoot); syncDirectory(path.dirname(root));
  const ownerFile = path.join(root, "owner.json"), owner = { schemaVersion: 1, serverOrigin: ticket.serverOrigin, executionId: ticket.executionId, sessionId: ticket.sessionId, ...sessionBinding(ticket) };
  if (existsSync(ownerFile)) {
    const fd = openSync(ownerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd), bytes = Buffer.alloc(stat.size); if (!stat.isFile() || stat.size > 16384 || readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || canonicalImageJson(JSON.parse(bytes.toString("utf8"))) !== canonicalImageJson(owner)) throw new Error("Media preparation owner identity differs."); } finally { closeSync(fd); }
  } else writeDurableJson(ownerFile, owner);
  const ledger = openMediaBudgetLedger(stateDirectory, ticket.executionId);
  const metadataBudget = controllerMetadataBudget(file, db);
  const captureSource = createImageCaptureSource(db, transactions, snapshot, metadataBudget);
  let closed = false, ledgerClosed = false, decoderCount = 0;
  const inFlight = new Map<string, { controller: AbortController; promise: Promise<LocalImagePreparation> }>();
  const captureInFlight = new Map<string, { controller: AbortController; promise: Promise<ValidatedImage>; filename: string; byteLength: number }>();
  const reads = new Map<string, number>();
  const inputLeases = new Set<string>();
  const wireReservations = new Map<string, number>();
  const wireSpools = new Set<NativeMediaSpool>();
  const checkOpen = () => { if (closed) throw new Error("Controller media store is closed."); };
  const mediaBlocks = new Set<object>();
  const tryAcquireMediaBlock = (): ControllerMediaBlockLease | null => {
    checkOpen();
    if (mediaBlocks.size >= 2) return null;
    const token = {}; mediaBlocks.add(token);
    return { close() { mediaBlocks.delete(token); } };
  };
  const get = (uploadId: string): Preparation => transactions.read(() => {
    imageId(uploadId);
    const row = db.prepare("SELECT value FROM image_preparations WHERE upload_id=?").get(uploadId) as { value: string } | undefined;
    if (!row) throw new Error("Image preparation is unavailable."); return JSON.parse(row.value) as Preparation;
  });
  const put = (p: Preparation) => transactions.write(() => { metadataBudget.assert(16384, p.receipt.state !== "receiving" || p.decoding); return db.prepare("INSERT INTO image_preparations VALUES(?,?) ON CONFLICT(upload_id) DO UPDATE SET value=excluded.value").run(p.spec.uploadId, JSON.stringify(p)); });
  const assertTarget = (spec: ImageUploadSpec) => {
    const { actorUserId: _actor, ...target } = spec.target; void _actor;
    if (canonicalImageJson(target) !== canonicalImageJson(snapshotTarget(ticket, snapshot()))) throw new Error("Image preparation target_changed.");
  };
  const preparationPath = (uploadId: string): string => path.join(root, get(uploadId).filename);
  const openPreparation = (p: Preparation, writable = false) => {
    if (!/^[a-f0-9-]{36}\.part$/.test(p.filename)) throw new Error("Invalid private image preparation path.");
    const filename = path.join(root, p.filename), stat = lstatSync(filename);
    const fd = openSync(filename, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
    const current = fstatSync(fd);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== current.dev || stat.ino !== current.ino || process.platform !== "win32" && (current.mode & 0o077) !== 0) { closeSync(fd); throw new Error("Image preparation file is not a private regular file."); }
    return fd;
  };
  const refreshMediaBudget = (next: number) => transactions.read(() => {
    const rows = db.prepare("SELECT value FROM image_preparations").all() as { value: string }[];
    const reservations = new Map(rows.map(row => JSON.parse(row.value) as Preparation).filter(p => p.receipt.state !== "released").map(p => [path.join(root, p.filename), Number(p.spec.byteLength)]));
    for (const [filename, bytes] of sourceReservations.reservations()) reservations.set(filename, bytes);
    for (const capture of captureInFlight.values()) reservations.set(capture.filename, Math.max(reservations.get(capture.filename) ?? 0, capture.byteLength));
    for (const [filename, bytes] of wireReservations) reservations.set(filename, bytes);
    // Unknown files retain their actual charge after interrupted preparation or
    // capture. Native names share only private immutable original inodes.
    const mediaBytes = controllerMediaDiskBytes([root, path.join(content.root, "blobs")], reservations);
    ledger.reserve(mediaBytes + next + CONTROLLER_METADATA_BYTES + CONTROLLER_SETTLEMENT_BYTES);
    const actualBytes = controllerMediaDiskBytes([root, path.join(content.root, "blobs")], new Map());
    return Math.max(0, mediaBytes - actualBytes) + next;
  });
  const checkBudgets = (next: number) => transactions.read(() => {
    metadataBudget.assert(16384);
    const rows = db.prepare("SELECT value FROM image_preparations").all() as { value: string }[];
    if (rows.length >= 10000 || rows.reduce((sum, row) => sum + Buffer.byteLength(row.value), 0) + 16384 > 128 * 1024 * 1024) throw new Error("Image preparation metadata budget exceeded.");
    const unwrittenBytes = refreshMediaBudget(next);
    const space = statfsSync(root, { bigint: true }); if (space.bavail * space.bsize < 536_870_912n + BigInt(unwrittenBytes)) throw new Error("Controller media storage free-space budget exceeded.");
  });
  const sourceReservations = captureSourceReservations({ db, transactions, root, checkOpen, checkBudgets, acquireBlock: tryAcquireMediaBlock,
    assertAttempt: (captureId, attemptId) => { captureSource.assertImageCaptureAttempt(captureId, attemptId); },
    assertMetadata: () => { metadataBudget.assert(16384, true); }, sync: () => syncDirectory(root),
    joinStage: async (captureId, attemptId) => { await captureInFlight.get(`${captureId}:${attemptId}`)?.promise.catch(() => {}); },
    stageRetained: (captureId, attemptId) => transactions.read(() => !!db.prepare("SELECT 1 FROM image_captures WHERE capture_id=?").get(`${captureId}:${attemptId}`)),
  });
  const createSpool = (maximumBytes: number): NativeMediaSpool => {
    checkOpen();
    const filename = path.join(wireRoot, `${randomUUID()}.wire`);
    let spool: NativeMediaSpool;
    try {
      spool = openNativeMediaSpool(filename, maximumBytes, bytes => {
        checkOpen();
        const previous = wireReservations.get(filename);
        wireReservations.set(filename, bytes);
        try {
          const unwrittenBytes = refreshMediaBudget(0);
          const space = statfsSync(root, { bigint: true });
          if (space.bavail * space.bsize < 536_870_912n + BigInt(unwrittenBytes)) throw new Error("Controller media storage free-space budget exceeded.");
        } catch (error) {
          if (previous === undefined) wireReservations.delete(filename); else wireReservations.set(filename, previous);
          throw error;
        }
      }, () => { wireReservations.delete(filename); refreshMediaBudget(0); wireSpools.delete(spool); });
    } catch (error) { wireReservations.delete(filename); throw error; }
    wireSpools.add(spool); return spool;
  };
  // Only an uncommitted suffix may be discarded. Confirmed-prefix loss is corruption.
  for (const row of transactions.read(() => db.prepare("SELECT value FROM image_preparations").all() as { value: string }[])) {
    const p = JSON.parse(row.value) as Preparation;
    if (["released", "failed", "expired"].includes(p.receipt.state)) continue;
    let fd: number | undefined;
    try {
      fd = openPreparation(p, p.receipt.state !== "validated"); const stat = fstatSync(fd), offset = Number(p.receipt.acceptedOffset);
      if (stat.size < offset || p.receipt.state === "validated" && stat.size !== offset) throw new Error("Image confirmed prefix is missing.");
      const chunks = transactions.read(() => db.prepare("SELECT offset,byte_length,sha256 FROM image_chunks WHERE upload_id=? ORDER BY CAST(offset AS INTEGER)").all(p.spec.uploadId) as { offset: string; byte_length: number; sha256: string }[]);
      let verified = 0;
      for (const chunk of chunks) { const bytes = Buffer.alloc(chunk.byte_length); if (Number(chunk.offset) !== verified || readSync(fd, bytes, 0, bytes.length, verified) !== bytes.length || hash(bytes) !== chunk.sha256) throw new Error("Image confirmed prefix is corrupt."); verified += bytes.length; }
      if (verified !== offset) throw new Error("Image confirmed prefix ledger is incomplete.");
      if (stat.size > offset) { ftruncateSync(fd, offset); fsyncSync(fd); }
      if (p.decoding) { p.decoding = false; put(p); }
    } catch { p.decoding = false; p.receipt = { ...p.receipt, state: "failed", validated: null, error: { code: "storage_corrupt", message: "The confirmed image preparation is incomplete or corrupt." } }; put(p); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  // The durable marker proves these copies never reached native dispatch. Unknown
  // and native/resume references are retained across process and generation stops.
  for (const pin of transactions.read(() => db.prepare("SELECT p.pin_id,p.resource_id,p.private_path FROM image_pins p JOIN operations o ON p.operation_id=o.id WHERE p.released=0 AND p.kind='operation' AND json_extract(o.value,'$.state') IN ('accepted','rejected','expired','failed')").all() as { pin_id: string; resource_id: string; private_path: string }[])) {
    if (path.dirname(pin.private_path) !== nativeRoot || !/^[a-f0-9-]{36}\.bin$/.test(path.basename(pin.private_path))) throw new Error("Native media pin has an invalid private path.");
    if (existsSync(pin.private_path)) unlinkSync(pin.private_path); syncDirectory(nativeRoot);
    content.unpinResource(pin.resource_id, pin.pin_id);
    transactions.write(() => db.prepare("UPDATE image_pins SET released=1 WHERE pin_id=?").run(pin.pin_id));
  }
  const prepare = async (input: ImageUploadSpec): Promise<LocalImagePreparation> => {
    checkOpen(); const spec = parseImageUploadSpec(input); assertTarget(spec);
    const old = transactions.read(() => db.prepare("SELECT value FROM image_preparations WHERE upload_id=?").get(spec.uploadId) as { value: string } | undefined);
    if (old) { const p = JSON.parse(old.value) as Preparation; if (canonicalImageJson(p.spec) !== canonicalImageJson(spec)) throw new Error("Image preparation upload_conflict."); return p.receipt; }
    checkBudgets(Number(spec.byteLength));
    const filename = `${randomUUID()}.part`;
    const receipt: LocalImagePreparation = { uploadId: spec.uploadId, imageId: spec.imageId, target: spec.target, state: "receiving", acceptedOffset: "0", validated: null, error: null };
    // Record the exact private path before creating bytes. A failed create or
    // flush remains reclaimable even when the prepare response is an error.
    put({ spec, filename, receipt, decoding: false });
    const fd = openSync(path.join(root, filename), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(root);
    return receipt;
  };
  const write = async (input: { uploadId: string; offset: string; sha256: string; data: string }): Promise<LocalImagePreparation> => {
    checkOpen(); const p = get(input.uploadId); assertTarget(p.spec);
    imageDecimal(input.offset, true);
    const bytes = Buffer.from(input.data, "base64");
    if (!bytes.length || bytes.length > IMAGE_LIMITS.chunkBytes || bytes.toString("base64") !== input.data || hash(bytes) !== input.sha256) throw new Error("Image preparation chunk integrity differs.");
    const previous = transactions.read(() => db.prepare("SELECT byte_length,sha256 FROM image_chunks WHERE upload_id=? AND offset=?").get(input.uploadId, input.offset) as { byte_length: number; sha256: string } | undefined);
    if (previous) {
      if (previous.byte_length !== bytes.length || previous.sha256 !== input.sha256) throw new Error("Image preparation chunk_conflict.");
      const fd = openPreparation(p); try { const actual = Buffer.alloc(bytes.length); if (readSync(fd, actual, 0, actual.length, Number(input.offset)) !== bytes.length || !actual.equals(bytes)) throw new Error("Image preparation chunk_conflict."); } finally { closeSync(fd); }
      return p.receipt;
    }
    if (p.receipt.state !== "receiving" || p.decoding || p.receipt.acceptedOffset !== input.offset || BigInt(input.offset) + BigInt(bytes.length) > BigInt(p.spec.byteLength)) throw new Error("Image preparation chunk offset or state differs.");
    const space = statfsSync(root, { bigint: true }); if (space.bavail * space.bsize < 536_870_912n + BigInt(bytes.length)) throw new Error("Controller media storage free-space budget exceeded.");
    const fd = openPreparation(p, true);
    try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, Number(input.offset) + offset); fsyncSync(fd); } finally { closeSync(fd); }
    p.receipt = { ...p.receipt, acceptedOffset: String(BigInt(input.offset) + BigInt(bytes.length)) };
    transactions.write(() => { db.prepare("INSERT INTO image_chunks VALUES(?,?,?,?)").run(input.uploadId, input.offset, bytes.length, input.sha256); put(p); }); return p.receipt;
  };
  const complete = async (input: { uploadId: string; sha256: string; byteLength: string }): Promise<LocalImagePreparation> => {
    checkOpen(); const pending = inFlight.get(input.uploadId); if (pending) return pending.promise;
    const p = get(input.uploadId); assertTarget(p.spec);
    if (p.spec.sha256 !== input.sha256 || p.spec.byteLength !== input.byteLength) throw new Error("Image preparation complete_conflict.");
    if (p.receipt.state === "validated") return p.receipt;
    if (p.receipt.state !== "receiving" || p.receipt.acceptedOffset !== p.spec.byteLength) throw new Error("Image preparation is incomplete.");
    if (decoderCount >= 1) throw new Error("Controller image decoder capacity is unavailable.");
    const controller = new AbortController(); p.decoding = true; put(p); decoderCount++;
    const promise = (async () => {
      try {
        const validated = await decoder({ version: 1, policy: "image-validation-v1", inputPath: path.join(root, p.filename), expectedByteLength: p.spec.byteLength, expectedSha256: p.spec.sha256 }, controller.signal);
        if (validated.mediaType !== p.spec.mediaType || validated.byteLength !== p.spec.byteLength || validated.sha256 !== p.spec.sha256) throw new Error("Image validation differs from the declared original.");
        if (controller.signal.aborted) throw controller.signal.reason;
        // Windows FlushFileBuffers requires a handle opened for writing, even
        // after the file becomes read-only. Keep that handle only for sealing.
        const fd = openPreparation(p, true); try { chmodSync(path.join(root, p.filename), 0o400); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(root);
        p.decoding = false; p.receipt = { ...p.receipt, state: "validated", validated, error: null }; put(p); return p.receipt;
      } catch (error) {
        p.decoding = false; p.receipt = { ...p.receipt, state: "failed", validated: null, error: { code: String(error).includes("component_unsupported") ? "component_unsupported" : "image_decode_failed", message: "The complete image could not be validated." } }; put(p); return p.receipt;
      } finally { decoderCount--; inFlight.delete(input.uploadId); }
    })();
    inFlight.set(input.uploadId, { controller, promise }); return promise;
  };
  const release = async ({ uploadId, spec: original }: { uploadId: string; spec?: ImageUploadSpec }): Promise<LocalImagePreparation> => {
    try {
      checkOpen(); imageId(uploadId);
      const spec = original === undefined ? undefined : parseImageUploadSpec(original);
      if (spec && spec.uploadId !== uploadId) throw new Error("Image preparation upload_conflict.");
      const row = transactions.read(() => db.prepare("SELECT value FROM image_preparations WHERE upload_id=?").get(uploadId) as { value: string } | undefined);
      let p: Preparation;
      if (row) {
        p = JSON.parse(row.value) as Preparation;
        if (spec && canonicalImageJson(spec) !== canonicalImageJson(p.spec)) throw new Error("Image preparation upload_conflict.");
      } else {
        if (!spec) throw new Error("Image preparation is unavailable.");
        assertTarget(spec);
        p = { spec, filename: `${randomUUID()}.part`, decoding: false, receipt: { uploadId, imageId: spec.imageId, target: spec.target, state: "released", acceptedOffset: "0", validated: null, error: null } };
      }
      const running = inFlight.get(uploadId);
      if (running) { running.controller.abort(new Error("Image preparation was released.")); await running.promise; p = get(uploadId); }
      const used = transactions.read(() => db.prepare("SELECT i.canonical FROM input_intents i JOIN operations o ON i.operation_id=o.id WHERE json_extract(o.value,'$.state') NOT IN ('rejected','expired','failed')").all() as { canonical: string }[]).some(row => { const command = JSON.parse(row.canonical) as { payload?: { content?: { uploadId?: string }[] } }; return command.payload?.content?.some(part => part.uploadId === uploadId); });
      if (used) throw new Error("Image preparation upload_in_use.");
      if ((reads.get(uploadId) ?? 0) > 0) throw new ImageReleaseStorageError(new Error("An original preparation read is still active."));
      // A missing preparation still needs a durable tombstone so a delayed
      // replay of the original prepare cannot create new staging after release.
      if (!row) { put(p); return p.receipt; }
      if (p.receipt.state === "released") return p.receipt;
      if (existsSync(path.join(root, p.filename))) unlinkSync(path.join(root, p.filename)); syncDirectory(root);
      p.receipt = { ...p.receipt, state: "released", validated: null, error: null }; put(p); return p.receipt;
    } catch (error) {
      // Only storage/busy failures permit repeating cleanup. Identity, format
      // and safety refusals must retain their definitive result.
      if (isImageReleaseStorageFailure(error)) throw new ImageReleaseStorageError(error);
      throw error;
    }
  };
  const readPrepared = async (input: { preparationId: string; offset: string; limit: number }): Promise<PreparedImageChunk> => {
    checkOpen(); const p = get(input.preparationId); imageDecimal(input.offset, true);
    if (p.receipt.state !== "validated" || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > IMAGE_LIMITS.chunkBytes || BigInt(input.offset) > BigInt(p.spec.byteLength)) throw new Error("Image preparation is not readable.");
    const fd = openPreparation(p); reads.set(input.preparationId, (reads.get(input.preparationId) ?? 0) + 1);
    try { const count = Math.min(input.limit, Number(BigInt(p.spec.byteLength) - BigInt(input.offset))), bytes = Buffer.alloc(count); if (count && readSync(fd, bytes, 0, count, Number(input.offset)) !== count) throw new Error("Image preparation is corrupt."); return { preparationId: input.preparationId, byteLength: p.spec.byteLength, sha256: p.spec.sha256, offset: input.offset, data: bytes.toString("base64"), eof: BigInt(input.offset) + BigInt(count) === BigInt(p.spec.byteLength) }; }
    finally { closeSync(fd); reads.set(input.preparationId, reads.get(input.preparationId)! - 1); }
  };
  const read = async (input: { resourceId: string; offset: string; limit: number }): Promise<ImageReadChunk> => {
    checkOpen(); const r = parseImageReadRequest(input), lease = content.acquireResource(r.resourceId);
    try { const bytes = lease.read(r.offset, r.limit); return { resourceId: r.resourceId, byteLength: lease.resource.byteLength!, sha256: lease.resource.sha256!, offset: r.offset, data: bytes.toString("base64"), eof: BigInt(r.offset) + BigInt(bytes.length) === BigInt(lease.resource.byteLength!) }; } finally { lease.close(); }
  };
  const stageCapture = async (input: CaptureStageInput): Promise<ValidatedImage> => {
    checkOpen(); imageId(input.captureId); imageId(input.attemptId); imageId(input.imageId); imageDecimal(input.byteLength);
    captureSource.assertImageCaptureAttempt(input.captureId, input.attemptId, input.imageId);
    const captureKey = `${input.captureId}:${input.attemptId}`;
    if (!path.isAbsolute(input.inputPath) || BigInt(input.byteLength) > BigInt(IMAGE_LIMITS.imageBytes) || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Invalid image capture integrity.");
    const occurrence = transactions.read(() => db.prepare("SELECT acknowledged,native_source FROM image_occurrences WHERE image_id=?").get(input.imageId) as { acknowledged: number; native_source: string | null } | undefined);
    if (!occurrence || occurrence.acknowledged !== 1) throw new Error("Image capture requires the original durable position acknowledgement.");
    const source = occurrence.native_source === null ? null : parseNativeImageSource(JSON.parse(occurrence.native_source));
    if (source && (source.provider !== ticket.provider || source.nativeSessionId !== snapshot().nativeSessionId)) throw new Error("Image capture native target_changed.");
    const old = transactions.read(() => db.prepare("SELECT image_id,validated FROM image_captures WHERE capture_id=?").get(captureKey) as { image_id: string; validated: string } | undefined);
    if (old) { const result = JSON.parse(old.validated) as ValidatedImage; if (old.image_id !== input.imageId || result.sha256 !== input.sha256 || result.byteLength !== input.byteLength || input.declaredMediaType != null && result.mediaType !== input.declaredMediaType) throw new Error("Image capture identity conflict."); return result; }
    const pending = captureInFlight.get(captureKey); if (pending) throw new Error("Image capture is already in progress; query the original capture.");
    if (decoderCount >= 1) throw new Error("Controller image decoder capacity is unavailable.");
    const reservedStage = sourceReservations.stagePath(input.captureId, input.attemptId, input.inputPath);
    checkBudgets(reservedStage ? 0 : Number(input.byteLength));
    const filename = reservedStage ? path.basename(reservedStage) : `${randomUUID()}.part`, targetPath = path.join(root, filename), controller = new AbortController(); decoderCount++;
    const promise = (async () => {
      let retained = false;
      try {
        const source = openSync(input.inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(source);
          if (!before.isFile() || String(before.size) !== input.byteLength || process.platform !== "win32" && (before.mode & 0o077) !== 0) throw new Error("Image capture source is not a private complete file.");
          const out = openSync(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try { let offset = 0; const chunk = Buffer.alloc(IMAGE_LIMITS.chunkBytes); while (offset < before.size) { const n = readSync(source, chunk, 0, Math.min(chunk.length, before.size - offset), offset); if (!n) throw new Error("Image capture source is incomplete."); let written = 0; while (written < n) written += writeSync(out, chunk, written, n - written); offset += n; } fsyncSync(out); } finally { closeSync(out); }
          const after = fstatSync(source); if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error("Image capture source changed.");
        } finally { closeSync(source); }
        syncDirectory(root);
        const validated = await decoder({ version: 1, policy: "image-validation-v1", inputPath: targetPath, expectedByteLength: input.byteLength, expectedSha256: input.sha256 }, controller.signal);
        if (input.declaredMediaType != null && validated.mediaType !== input.declaredMediaType) throw Object.assign(new Error("Image capture format differs from the declared source type."), { code: "invalid_image" });
        if (controller.signal.aborted) throw controller.signal.reason;
        const fd = openSync(targetPath, constants.O_RDWR | constants.O_NOFOLLOW); try { chmodSync(targetPath, 0o400); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(root);
        transactions.write(() => { captureSource.assertImageCaptureAttempt(input.captureId, input.attemptId, input.imageId); metadataBudget.assert(16384, true); db.prepare("INSERT INTO image_captures VALUES(?,?,?,?)").run(captureKey, input.imageId, filename, JSON.stringify(validated)); });
        retained = true; return validated;
      } finally { if (!retained && existsSync(targetPath)) { unlinkSync(targetPath); syncDirectory(root); } decoderCount--; captureInFlight.delete(captureKey); }
    })();
    captureInFlight.set(captureKey, { controller, promise, filename: targetPath, byteLength: Number(input.byteLength) }); return promise;
  };
  const readCapture = async (input: { captureId: string; attemptId: string; sha256: string; byteLength: string; offset: string; limit: number }, acquirePolicy?: CaptureReadPolicy, deliver?: (chunk: PreparedImageChunk) => void): Promise<PreparedImageChunk> => {
    checkOpen(); imageId(input.captureId); imageId(input.attemptId); imageDecimal(input.offset, true);
    const request = captureSource.assertImageCaptureAttempt(input.captureId, input.attemptId);
    if (request.locator.kind === "local" && !acquirePolicy) throw new Error("Image local source read requires its current policy lease.");
    const captureKey = `${input.captureId}:${input.attemptId}`;
    const row = transactions.read(() => db.prepare("SELECT filename,validated FROM image_captures WHERE capture_id=?").get(captureKey) as { filename: string; validated: string } | undefined);
    if (!row || !/^[a-f0-9-]{36}\.part$/.test(row.filename)) throw new Error("Image capture is unavailable.");
    const resource = JSON.parse(row.validated) as ValidatedImage;
    if (input.sha256 !== resource.sha256 || input.byteLength !== resource.byteLength || BigInt(input.offset) > BigInt(resource.byteLength) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > IMAGE_LIMITS.chunkBytes) throw new Error("Image capture read integrity differs.");
    const policy = acquirePolicy?.(request);
    const verifyPolicy = () => {
      const verified: unknown = policy?.verify();
      if (verified !== undefined) {
        if (verified instanceof Promise) void verified.catch(() => {});
        throw new Error("Image source read policy must verify synchronously.");
      }
    };
    let fd: number | undefined;
    try {
      if (request.locator.kind === "local" && !policy) throw new Error("Image local source read requires its current policy lease.");
      verifyPolicy();
      fd = openSync(path.join(root, row.filename), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || String(stat.size) !== resource.byteLength) throw new Error("Image capture is corrupt.");
      const count = Math.min(input.limit, Number(BigInt(resource.byteLength) - BigInt(input.offset))), bytes = Buffer.alloc(count);
      if (count && readSync(fd, bytes, 0, count, Number(input.offset)) !== count) throw new Error("Image capture is corrupt.");
      const result = { preparationId: input.attemptId, byteLength: resource.byteLength, sha256: resource.sha256, offset: input.offset, data: bytes.toString("base64"), eof: BigInt(input.offset) + BigInt(count) === BigInt(resource.byteLength) };
      // Deliver while the policy lease is held. A Promise return alone leaves
      // a revocation gap before the transport's awaiting continuation.
      verifyPolicy();
      deliver?.(result);
      return result;
    } finally { if (fd !== undefined) closeSync(fd); policy?.close(); }
  };
  const adoptCaptureResource = (captureId: string, attemptId: string, input: SessionResource): void => {
    checkOpen(); imageId(captureId); imageId(attemptId);
    const resource = parseSessionResource(input);
    const row = transactions.read(() => {
      const request = captureSource.assertImageCaptureAttempt(captureId, attemptId);
      const capture = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`capture:${captureId}`) as { value: string };
      const saved = JSON.parse(capture.value) as { receipt: unknown };
      if (saved.receipt === null) throw new Error("Image capture adoption requires its durable committed receipt.");
      const receipt = parseImageCaptureReceipt(saved.receipt, parseSessionResource);
      if (receipt.state !== "committed") throw new Error("Image capture adoption requires its durable committed receipt.");
      if (receipt.captureId !== captureId || receipt.attemptId !== attemptId || canonicalImageJson(receipt.occurrence) !== canonicalImageJson(request.occurrence) || receipt.resourceId !== resource.resourceId || canonicalImageJson(receipt.resource) !== canonicalImageJson(resource)) throw new Error("Image capture committed resource identity differs.");
      const validated = db.prepare("SELECT image_id,filename,validated FROM image_captures WHERE capture_id=?").get(`${captureId}:${attemptId}`) as { image_id: string; filename: string; validated: string } | undefined;
      if (validated && validated.image_id !== request.occurrence.imageId) throw new Error("Image capture validated source identity differs.");
      return validated;
    });
    if (!row || !/^[a-f0-9-]{36}\.part$/.test(row.filename)) throw new Error("Image capture validated source is unavailable.");
    const validated = parseValidatedImage(JSON.parse(row.validated));
    const actual = { mediaType: resource.mediaType, byteLength: resource.byteLength, sha256: resource.sha256, width: resource.width, height: resource.height, frameCount: resource.frameCount };
    if (canonicalImageJson(validated) !== canonicalImageJson(actual)) throw new Error("Image capture committed resource differs from its validated identity.");
    const block = tryAcquireMediaBlock();
    if (!block) throw Object.assign(new Error("source_capacity: Controller media block capacity is unavailable."), { code: "source_capacity" });
    try {
      const previous = content.resources.get(resource.resourceId)?.resource;
      if (previous?.status === "available") {
        if (canonicalImageJson(previous) !== canonicalImageJson(resource)) throw new Error("Image capture saved resource identity differs.");
        // Saved originals are authoritative. Replays verify their bytes and never
        // repair a missing or corrupt original by reading the source again.
        const lease = content.acquireResource(resource.resourceId), digest = createHash("sha256");
        try {
          for (let offset = 0; offset < Number(resource.byteLength);) {
            const bytes = lease.read(String(offset), IMAGE_LIMITS.chunkBytes);
            if (!bytes.length) throw new Error("Image capture saved resource is corrupt.");
            digest.update(bytes); offset += bytes.length;
          }
          if (digest.digest("hex") !== resource.sha256) throw new Error("Image capture saved resource is corrupt.");
        } finally { lease.close(); }
        return;
      }
      checkBudgets(Number(resource.byteLength));
      content.importResourceFile(resource, path.join(root, row.filename));
    } finally { block.close(); }
  };
  const acquireInput = async (input: SessionInput, operationId: string): Promise<NativeInputLease> => {
    checkOpen(); imageId(operationId); const images = input.content.filter(part => part.type === "image");
    if (images.length > IMAGE_LIMITS.images || images.reduce((sum, part) => sum + BigInt(part.byteLength), 0n) > BigInt(IMAGE_LIMITS.messageBytes)) throw new Error("Native image input exceeds its message budget.");
    if (!images.length) return { input: { content: input.content.filter(part => part.type === "text") }, verify() {}, retain() {}, close() {} };
    if (!input.target) throw new Error("Native image input has no exact target.");
    const original = transactions.read(() => db.prepare("SELECT o.value,i.canonical FROM operations o JOIN input_intents i ON o.id=i.operation_id WHERE o.id=?").get(operationId) as { value: string; canonical: string } | undefined);
    if (!original || (JSON.parse(original.value) as { state: string }).state !== "accepted" || canonicalImageJson((JSON.parse(original.canonical) as { payload: SessionInput }).payload) !== canonicalImageJson(input)) throw new Error("Native image input requires its unchanged, undispatched original operation intent.");
    if (inputLeases.has(operationId)) throw new Error("Native image operation already has an input lease.");
    inputLeases.add(operationId);
    const acquired: ControlledResourceLease[] = [], native: NativeImagePart[] = [], created: string[] = [];
    const imported = new Set<string>();
    const releaseImported = () => { for (const id of imported) { try { content.releaseResource(id); } catch (error) { if (!(error instanceof Error) || !/active lease or reference|referenced by session history/.test(error.message)) throw error; } } };
    const pendingPins: { resourceId: string; reference: string; filename: string }[] = [];
    const nativeHandles: { filename: string; fd: number; sha256: string; byteLength: string }[] = [];
    const verify = () => {
      for (const handle of nativeHandles) {
        const stat = fstatSync(handle.fd), named = lstatSync(handle.filename);
        if (!stat.isFile() || !named.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino || String(stat.size) !== handle.byteLength || process.platform !== "win32" && (stat.mode & 0o222) !== 0) throw new Error("Native image lease identity or immutability changed.");
        const digest = createHash("sha256"), bytes = Buffer.alloc(IMAGE_LIMITS.chunkBytes); let offset = 0;
        while (offset < stat.size) { const n = readSync(handle.fd, bytes, 0, Math.min(bytes.length, stat.size - offset), offset); if (!n) throw new Error("Native image lease is incomplete."); digest.update(bytes.subarray(0, n)); offset += n; }
        const after = fstatSync(handle.fd);
        if (digest.digest("hex") !== handle.sha256 || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw new Error("Native image lease integrity changed.");
      }
    };
    try {
      // Validate the entire group before importing any original or acquiring a native file.
      const preparations = images.map(image => {
        const p = get(image.uploadId); assertTarget(p.spec);
        if (canonicalImageJson(input.target) !== canonicalImageJson(p.spec.target) || p.receipt.state !== "validated" || !p.receipt.validated || image.imageId !== p.spec.imageId || image.sha256 !== p.spec.sha256 || image.byteLength !== p.spec.byteLength) throw new Error("Native image preparation is unavailable or differs from its original intent.");
        return { image, p, metadata: p.receipt.validated };
      });
      checkBudgets(images.reduce((sum, image) => sum + (content.resources.get(image.resourceId)?.resource.status === "available" ? 0 : Number(image.byteLength)), 0));
      for (const { image, p, metadata } of preparations) {
        const resource: SessionResource = { resourceId: image.resourceId, status: "available", name: p.spec.name, mediaType: metadata.mediaType, byteLength: metadata.byteLength, sha256: metadata.sha256, error: null, revision: "1", width: metadata.width, height: metadata.height, frameCount: metadata.frameCount };
        parseSessionResource(resource); if (!content.resources.has(image.resourceId)) imported.add(image.resourceId); content.importResourceFile(resource, path.join(root, p.filename));
        const source = content.acquireResource(image.resourceId); acquired.push(source);
        const filename = path.join(nativeRoot, `${randomUUID()}.bin`), original = lstatSync(source.path);
        if (!original.isFile() || original.isSymbolicLink() || String(original.size) !== image.byteLength) throw new Error("Native image original identity changed.");
        // Both names remain inside the private execution. A persistent pin prevents
        // unlinking the original while native/resume readers can still need it.
        linkSync(source.path, filename); created.push(filename); chmodSync(filename, 0o400);
        const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW), linked = fstatSync(fd);
        if (linked.dev !== original.dev || linked.ino !== original.ino) { closeSync(fd); throw new Error("Native image original identity changed."); }
        nativeHandles.push({ filename, fd, sha256: image.sha256, byteLength: image.byteLength });
        // publishBytes already flushed the original bytes through its writer.
        // POSIX can also flush chmod metadata through this read-only lease;
        // Windows requires write access and does not use mode bits for admission.
        if (process.platform !== "win32") fsyncSync(fd); syncDirectory(nativeRoot);
        const reference = `operation:${operationId}:${image.imageId}`;
        pendingPins.push({ resourceId: image.resourceId, reference, filename });
        native.push({ type: "image", imageId: image.imageId, resourceId: image.resourceId, mediaType: metadata.mediaType, byteLength: image.byteLength, sha256: image.sha256, localPath: filename, validated: Object.freeze({ ...metadata }) });
      }
      verify();
      for (const pin of pendingPins) content.pinResource(pin.resourceId, pin.reference);
      transactions.write(() => { for (const pin of pendingPins) db.prepare("INSERT INTO image_pins VALUES(?,?,?,?,?,?,0) ON CONFLICT(pin_id) DO UPDATE SET private_path=excluded.private_path,released=0 WHERE image_pins.released=1").run(pin.reference, operationId, pin.resourceId, input.target!.expectedNativeSessionId, "operation", pin.filename); });
      let released = false;
      let retained = false;
      return { input: { content: [...input.content.filter(part => part.type === "text"), ...native] }, verify,
        retain() { if (released) throw new Error("Native image lease is closed."); retained = true; transactions.write(() => { for (const pin of pendingPins) db.prepare("UPDATE image_pins SET kind='native_resume' WHERE pin_id=?").run(pin.reference); }); },
        close() {
          if (released) return; released = true; inputLeases.delete(operationId); for (const handle of nativeHandles) closeSync(handle.fd); for (const lease of acquired) lease.close();
          if (!retained) {
            for (const pin of pendingPins) { content.unpinResource(pin.resourceId, pin.reference); if (existsSync(pin.filename)) unlinkSync(pin.filename); }
            syncDirectory(nativeRoot); releaseImported();
            transactions.write(() => { for (const pin of pendingPins) db.prepare("UPDATE image_pins SET released=1 WHERE pin_id=?").run(pin.reference); });
          }
        } };

    } catch (error) {
      inputLeases.delete(operationId);
      for (const handle of nativeHandles) closeSync(handle.fd);
      for (const lease of acquired) lease.close();
      for (const pin of pendingPins) content.unpinResource(pin.resourceId, pin.reference);
      for (const filename of created) if (existsSync(filename)) unlinkSync(filename); if (created.length) syncDirectory(nativeRoot);
      releaseImported(); throw error;
    }
  };
  return { prepare, write, complete, release, readPrepared, read, stageCapture, readCapture, adoptCaptureResource, acquireInput, preparationPath, createSpool,
    reserveCaptureSource: sourceReservations.reserve, releaseCaptureSource: sourceReservations.release, tryAcquireMediaBlock,
    nativeIndexDirectory: (): string => { checkOpen(); metadataBudget.assert(16384); const directory = `${file}.native-index`; checkedDirectory(directory); return directory; },
    reserveNativeIndex: (additional: number): void => { checkOpen(); metadataBudget.assert(additional); },
    captureStatus: (captureId: string, attemptId: string): ValidatedImage | null => {
      checkOpen(); imageId(attemptId); captureSource.assertImageCaptureAttempt(captureId, attemptId);
      return transactions.read(() => { const row = db.prepare("SELECT validated FROM image_captures WHERE capture_id=?").get(`${captureId}:${attemptId}`) as { validated: string } | undefined; return row ? JSON.parse(row.validated) as ValidatedImage : null; });
    },
    status: async ({ uploadId }: { uploadId: string }): Promise<LocalImagePreparation> => { checkOpen(); return get(uploadId).receipt; },
    async close(): Promise<void> {
      if (ledgerClosed) return; closed = true;
      const pending = [...inFlight.values(), ...captureInFlight.values()];
      for (const item of pending) item.controller.abort(new Error("Controller media stopped."));
      await Promise.allSettled([...pending.map(item => item.promise), sourceReservations.stop()]);
      const failures: unknown[] = [];
      for (const spool of wireSpools) try { spool.remove(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Native media readers or files remain after shutdown.");
      ledger.close(); ledgerClosed = true;
    },
  };
};
export type ControllerMediaStore = ReturnType<typeof openControllerMediaStore>;
