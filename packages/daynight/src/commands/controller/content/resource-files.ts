import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseSessionResource, parseStoredSessionResource, type SessionResource } from "../../../session/protocol.js";
import { syncDirectory, writeDurableJson } from "../../../platform/durable-json.js";
import type Database from "better-sqlite3";
import { assertControllerStoragePermit, type ControllerStoragePermit } from "../storage-lock.js";

/** Pending upload source, not a second permanent native session history. */
export type PendingResource = { resource: SessionResource; data: string | null };
export type ControlledResourceLease = { readonly path: string; readonly resource: SessionResource; read(offset: string, limit: number): Buffer; close(): void };
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
// Archive validation can reopen the same files while an earlier immutable
// reader still owns its FD. Retirement must observe both owners' leases.
const activeLeases = new Map<string, number>();

type PendingContentIndex = { entries: string[]; resources: string[]; cleanup?: string[] };
const readIndex = (root: string): { source: Buffer; value: PendingContentIndex } | undefined => {
  const file = join(root, "index.json");
  if (!existsSync(file)) return undefined;
  const source = readFileSync(file), value = JSON.parse(source.toString("utf8")) as PendingContentIndex;
  if (!Array.isArray(value.entries) || !Array.isArray(value.resources)) throw new Error("Invalid pending content index.");
  if ([...value.entries, ...value.resources].some(name => typeof name !== "string" || !/^[a-f0-9]{64}\.json$/.test(name))) throw new Error("Pending archive source is incomplete.");
  if (value.cleanup !== undefined && (!Array.isArray(value.cleanup) || value.cleanup.some(name => typeof name !== "string" || !/^(?:resources\/[a-f0-9]{64}\.json|blobs\/[a-f0-9]{64}\.bin)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.delete$/.test(name)))) throw new Error("Invalid pending resource cleanup inventory.");
  return { source, value };
};
const validatedIndex = (root: string): PendingContentIndex | undefined => {
  let index = readIndex(root);
  if (index === undefined) return undefined;
  const legacyExists = (value: PendingContentIndex): boolean => value.entries.every(name => existsSync(join(root, "timeline", name)));
  if (!legacyExists(index.value)) {
    // A reader may capture the inventory before maintenance publishes retirement.
    // Only a changed atomic inventory can supersede its disappearing legacy files.
    const current = readIndex(root);
    if (current === undefined || current.source.equals(index.source)) throw new Error("Pending archive source is incomplete.");
    if (!legacyExists(current.value)) throw new Error("Pending archive source is incomplete.");
    index = current;
  }
  if (index.value.resources.some(name => !existsSync(join(root, "resources", name)))) throw new Error("Pending archive source is incomplete.");
  return index.value;
};
const publishIndex = (root: string, value: PendingContentIndex): void => writeDurableJson(join(root, "index.json"), value);
const assertSessionManifest = (root: string, sessionId: string): void => {
  const value = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { schemaVersion: number; sessionId: string };
  if (value.schemaVersion !== 1 || value.sessionId !== sessionId) throw new Error("Pending content belongs to another session.");
};

/** Publish retirement before its reader-safe owner removes any legacy timeline files. */
export const retireLegacyTimelineReferences = (journal: string, sessionId: string): void => {
  const root = `${journal}.pending-content`;
  assertSessionManifest(root, sessionId);
  const index = validatedIndex(root);
  if (index !== undefined) publishIndex(root, { ...index, entries: [] });
};

export const openResourceFiles = (journal: string, sessionId: string) => {
  const root = `${journal}.pending-content`;
  const resourceDirectory = join(root, "resources"), blobDirectory = join(root, "blobs");
  const assertDirectory = (directory: string): void => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Pending resource directory must be a private directory.");
  };
  for (const directory of [root, resourceDirectory, blobDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); assertDirectory(directory);
  }
  const assertDirectories = (): void => { for (const directory of [root, resourceDirectory, blobDirectory]) assertDirectory(directory); };
  syncDirectory(dirname(root));
  syncDirectory(root);
  const manifest = join(root, "manifest.json");
  if (existsSync(manifest)) assertSessionManifest(root, sessionId);
  else writeDurableJson(manifest, { schemaVersion: 1, sessionId });
  const indexPath = join(root, "index.json");
  validatedIndex(root);
  const resources = new Map<string, PendingResource>();
  const leaseKey = (id: string): string => `${resolve(root)}\0${id}`;
  let recoveryNeeded = false;
  const assertWritable = (): void => { if (recoveryNeeded) throw new Error("Pending resource deletion requires recovery before further writes."); };
  const pinsPath = join(root, "resource-pins.json");
  const pins: Record<string, string[]> = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, "utf8")) as Record<string, string[]> : {};
  if (!pins || Array.isArray(pins) || typeof pins !== "object" || Object.values(pins).some(values => !Array.isArray(values) || values.some(value => typeof value !== "string" || !value))) throw new Error("Invalid persistent resource references.");
  const name = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;
  const blobPath = (id: string) => join(blobDirectory, name(id).replace(/\.json$/, ".bin"));
  const openBlob = (resource: SessionResource): number => {
    assertDirectories();
    const file = blobPath(resource.resourceId);
    if (!existsSync(file)) throw new Error("Pending archive source is incomplete: saved resource blob is missing.");
    const named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink()) throw new Error("Corrupt pending resource content.");
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || named.dev !== stat.dev || named.ino !== stat.ino || String(stat.size) !== resource.byteLength) throw new Error("Corrupt pending resource content.");
      return fd;
    } catch (cause) { closeSync(fd); throw cause; }
  };
  const verifyBlob = (resource: SessionResource): void => {
    const fd = openBlob(resource);
    try {
      const hash = createHash("sha256"), block = Buffer.alloc(524288); let count = 0;
      for (;;) { const size = readSync(fd, block, 0, block.length, count); if (!size) break; count += size; hash.update(block.subarray(0, size)); }
      if (String(count) !== resource.byteLength || hash.digest("hex") !== resource.sha256) throw new Error("Corrupt pending resource content.");
    } finally { closeSync(fd); }
  };
  const publishBytes = (resource: SessionResource, copy: (fd: number) => { length: number; digest: string }, admitNew = true): void => {
    if (resource.status !== "available" || resource.byteLength === null || resource.sha256 === null || admitNew && BigInt(resource.byteLength) > BigInt(MAX_RESOURCE_BYTES)) throw new Error("Invalid pending resource bytes.");
    const file = blobPath(resource.resourceId), temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    let published = false;
    try {
      const result = copy(fd);
      if (admitNew && result.length > MAX_RESOURCE_BYTES || String(result.length) !== resource.byteLength || result.digest !== resource.sha256) throw new Error("Corrupt pending resource content.");
      fsyncSync(fd); closeSync(fd);
      if (existsSync(file)) { verifyBlob(resource); unlinkSync(temporary); }
      else renameSync(temporary, file);
      syncDirectory(blobDirectory); published = true;
    } finally { if (!published) { try { closeSync(fd); } catch {} if (existsSync(temporary)) unlinkSync(temporary); } }
  };
  for (const file of readdirSync(resourceDirectory).filter(file => file.endsWith(".json"))) {
    const original = readFileSync(join(resourceDirectory, file));
    const value = JSON.parse(original.toString("utf8")) as PendingResource;
    const resource = parseStoredSessionResource(value.resource);
    if (name(resource.resourceId) !== file || (value.data !== null && typeof value.data !== "string")) throw new Error("Invalid pending resource identity.");
    if (value.data !== null) {
      const content = Buffer.from(value.data, "base64");
      if (content.toString("base64") !== value.data) throw new Error("Corrupt pending resource content.");
      publishBytes(resource, fd => { writeFileSync(fd, content); return { length: content.length, digest: createHash("sha256").update(content).digest("hex") }; }, false);
      // Keep the exact old source until the new reader has verified the closure.
      const legacy = join(root, "legacy-resources"); mkdirSync(legacy, { recursive: true, mode: 0o700 });
      const old = join(legacy, file); if (!existsSync(old)) { const fd = openSync(old, "wx", 0o600); try { writeFileSync(fd, original); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(legacy); }
      verifyBlob(resource); writeDurableJson(join(resourceDirectory, file), { resource, data: null });
    }
    if (resource.status === "available") verifyBlob(resource);
    resources.set(resource.resourceId, { resource, data: null });
  }
  // The journal owns the durable timeline inventory. Rewriting a growing
  // entry list on each insert would make an otherwise linear archive quadratic.
  // Resources have their own small inventory because their bytes do not live in SQL.
  const nextIndex = (retired: readonly string[] = []): PendingContentIndex => {
    const cleanup = [...new Set([...(readIndex(root)?.value.cleanup ?? []), ...retired])];
    return { entries: [], resources: [...resources.keys()].map(name).sort(), ...(cleanup.length ? { cleanup } : {}) };
  };
  const updateIndex = (retired: readonly string[] = []) => publishIndex(root, nextIndex(retired));
  let descriptorBytes = [...resources.values()].reduce((sum, value) => sum + encodedBytes(value.resource), 0);
  const retryCleanup = (): void => {
    assertWritable(); assertDirectories(); assertSessionManifest(root, sessionId);
    const index = readIndex(root)?.value;
    if (!index?.cleanup?.length) return;
    // The atomic resource inventory records only backups whose original
    // deletion committed. Never infer ownership by scanning leftover files.
    for (const relative of index.cleanup) {
      const file = join(root, relative);
      let metadata;
      try { metadata = lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid retained resource backup.");
      unlinkSync(file);
    }
    syncDirectory(resourceDirectory); syncDirectory(blobDirectory);
    const { cleanup: _cleanup, ...remaining } = index;
    publishIndex(root, remaining);
  };
  const tryCleanup = (): void => {
    try { retryCleanup(); }
    catch (error) { process.emitWarning(`Retained resource cleanup remains pending: ${String(error)}`); }
  };
  const checkResourceBudget = (resource?: SessionResource): void => {
    assertDirectories();
    tryCleanup();
    const known = new Set([...resources.keys()].map(id => name(id).replace(/\.json$/, ".bin")));
    let bytes = 0, orphans = 0;
    for (const file of readdirSync(blobDirectory).filter(file => file.endsWith(".bin") || /\.bin\.[a-f0-9-]+\.delete$/.test(file))) {
      const metadata = lstatSync(join(blobDirectory, file));
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid pending resource blob.");
      const backup = /^(.*\.bin)\.[a-f0-9-]+\.delete$/.exec(file);
      if (backup && existsSync(join(blobDirectory, backup[1]!))) {
        const original = lstatSync(join(blobDirectory, backup[1]!));
        if (metadata.ino !== 0 && metadata.dev === original.dev && metadata.ino === original.ino) continue;
      }
      bytes += metadata.size; if (!known.has(file)) orphans++;
    }
    let count = resources.size + orphans;
    if (resource && !resources.has(resource.resourceId)) {
      if (!existsSync(blobPath(resource.resourceId))) count++;
      if (resource.status === "available" && !existsSync(blobPath(resource.resourceId))) bytes += Number(resource.byteLength);
    } else if (resource?.status === "available" && !existsSync(blobPath(resource.resourceId))) bytes += Number(resource.byteLength);
    if (count > 1000 || bytes > 1073741824) throw new Error("Pending session resource budget exceeded.");
    const metadata = descriptorBytes - (resource && resources.has(resource.resourceId) ? encodedBytes(resources.get(resource.resourceId)!.resource) : 0) + (resource ? encodedBytes(resource) : 0);
    if (metadata > 4 * 1024 * 1024) throw new Error("Pending resource metadata budget exceeded.");
  };
  if (!existsSync(indexPath)) updateIndex();
  const publishResource = (value: PendingResource, bytes: Uint8Array | undefined, admitNew: boolean): void => {
    assertWritable();
    if (admitNew) parseSessionResource(value.resource); else parseStoredSessionResource(value.resource);
    if (admitNew && value.resource.status === "available" && value.resource.byteLength !== null && BigInt(value.resource.byteLength) > BigInt(MAX_RESOURCE_BYTES)) throw new Error("Invalid pending resource bytes.");
    const input = bytes ?? (value.data === null ? undefined : Buffer.from(value.data, "base64"));
    if (value.data !== null && Buffer.from(value.data, "base64").toString("base64") !== value.data) throw new Error("Corrupt pending resource content.");
    const previous = resources.get(value.resource.resourceId);
    if (previous?.resource.status === "available" && JSON.stringify(previous.resource) !== JSON.stringify(value.resource)) throw new Error("An available local resource cannot change identity.");
    if (admitNew) checkResourceBudget(value.resource);
    if (input !== undefined) publishBytes(value.resource, fd => { writeFileSync(fd, input); return { length: input.byteLength, digest: createHash("sha256").update(input).digest("hex") }; }, admitNew);
    if (value.resource.status === "available") verifyBlob(value.resource);
    const normalized = { resource: value.resource, data: null };
    if (previous && JSON.stringify(previous) === JSON.stringify(normalized)) return;
    const existed = previous !== undefined;
    writeDurableJson(join(resourceDirectory, name(value.resource.resourceId)), normalized);
    resources.set(value.resource.resourceId, JSON.parse(JSON.stringify(normalized)) as PendingResource);
    descriptorBytes += encodedBytes(value.resource) - (previous ? encodedBytes(previous.resource) : 0);
    if (!existed) updateIndex();
  };
  const saveResource = (value: PendingResource, bytes?: Uint8Array): void => publishResource(value, bytes, true);
  const publishMigrationResource = (db: Database.Database, permit: ControllerStoragePermit, value: PendingResource, bytes?: Uint8Array): void => {
    if (!db.inTransaction) throw new Error("Resource migration requires the journal migration transaction.");
    assertControllerStoragePermit(permit, journal);
    if (!db.memory && db.name !== journal) throw new Error("Resource migration permit belongs to another database.");
    publishResource(value, bytes, false);
  };
  const writeResource = (resource: SessionResource, bytes: Uint8Array) => saveResource({ resource, data: null }, bytes);
  const importResourceFile = (resource: SessionResource, source: string): void => {
    assertWritable();
    const previous = resources.get(resource.resourceId);
    if (previous?.resource.status === "available" && JSON.stringify(previous.resource) !== JSON.stringify(resource)) throw new Error("An available local resource cannot change identity.");
    checkResourceBudget(parseSessionResource(resource));
    const before = lstatSync(source), input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(input);
      if (!before.isFile() || before.isSymbolicLink() || before.dev !== stat.dev || before.ino !== stat.ino || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Resource import requires a private regular file.");
      publishBytes(resource, output => { const block = Buffer.alloc(524288), hash = createHash("sha256"); let length = 0;
        for (;;) { const size = readSync(input, block, 0, block.length, length); if (!size) break; if (length + size > MAX_RESOURCE_BYTES) throw new Error("Resource exceeds its byte budget."); let offset = 0; while (offset < size) offset += writeSync(output, block, offset, size - offset); hash.update(block.subarray(0, size)); length += size; }
        return { length, digest: hash.digest("hex") };
      });
    } finally { closeSync(input); }
    saveResource({ resource, data: null });
  };
  const acquireResource = (id: string): ControlledResourceLease => {
    assertWritable();
    const resource = resources.get(id)?.resource;
    if (!resource || resource.status !== "available") throw new Error("Local session resource is unavailable.");
    const fd = openBlob(resource), key = leaseKey(id); let closed = false; activeLeases.set(key, (activeLeases.get(key) ?? 0) + 1);
    return { path: blobPath(id), resource, read(offset, limit) {
      if (closed) throw new Error("Resource lease is closed.");
      if (!/^(0|[1-9][0-9]{0,18})$/.test(offset) || BigInt(offset) > BigInt(resource.byteLength!) || !Number.isSafeInteger(limit) || limit < 1 || limit > 524288) throw new Error("Invalid local resource chunk limit.");
      const size = Math.min(limit, Number(BigInt(resource.byteLength!) - BigInt(offset))), block = Buffer.alloc(size);
      if (size && readSync(fd, block, 0, size, Number(offset)) !== size) throw new Error("Corrupt pending resource content."); return block;
    }, close() { if (!closed) { closeSync(fd); closed = true; const remaining = activeLeases.get(key)! - 1; if (remaining === 0) activeLeases.delete(key); else activeLeases.set(key, remaining); } } };
  };
  const pinResource = (id: string, reference: string): void => { assertWritable(); if (!resources.has(id) || !reference) throw new Error("Invalid resource reference."); pins[id] = [...new Set([...(pins[id] ?? []), reference])]; writeDurableJson(pinsPath, pins); };
  const unpinResource = (id: string, reference: string): void => { assertWritable(); pins[id] = (pins[id] ?? []).filter(value => value !== reference); writeDurableJson(pinsPath, pins); };
  const assertResourceReleasable = (id: string): void => {
    assertWritable();
    if ((activeLeases.get(leaseKey(id)) ?? 0) > 0 || (pins[id]?.length ?? 0) > 0) throw new Error("Resource has an active lease or reference.");
  };
  const releaseResource = (id: string): void => {
    assertResourceReleasable(id);
    const descriptor = join(resourceDirectory, name(id)), blob = blobPath(id), suffix = `.${randomUUID()}.delete`;
    const files = [descriptor, blob].filter(file => existsSync(file));
    const backups: string[] = [];
    const previous = resources.get(id), previousPins = pins[id];
    const oldPins = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, "utf8")) as unknown : undefined;
    const oldIndex = readIndex(root)?.value;
    let pinsAttempted = false, indexAttempted = false;
    let committedIndex: PendingContentIndex | undefined;
    try {
      // Retain both originals until every fallible deletion and metadata update
      // succeeds. Hard links avoid copying a potentially large immutable blob.
      for (const file of files) { linkSync(file, file + suffix); backups.push(file); }
      syncDirectory(resourceDirectory); syncDirectory(blobDirectory);
      for (const file of files) unlinkSync(file);
      if (previous) { descriptorBytes -= encodedBytes(previous.resource); resources.delete(id); }
      delete pins[id];
      pinsAttempted = true; writeDurableJson(pinsPath, pins);
      syncDirectory(blobDirectory); syncDirectory(resourceDirectory);
      committedIndex = nextIndex(backups.map(file => `${file === descriptor ? "resources" : "blobs"}/${basename(file)}${suffix}`));
      indexAttempted = true; publishIndex(root, committedIndex);
    } catch (error) {
      if (indexAttempted) {
        // A failed directory flush can follow the atomic index rename. Once
        // that deletion inventory is visible, restoring only some originals
        // would turn its cleanup authority into permission to erase recovery
        // evidence. Observe publication before deciding whether rollback is safe.
        let current: PendingContentIndex | undefined;
        try { current = readIndex(root)?.value; }
        catch (observation) {
          recoveryNeeded = true;
          throw new AggregateError([error, observation], "Resource deletion publication is unknown; retained backups require recovery.", { cause: error });
        }
        if (JSON.stringify(current) === JSON.stringify(committedIndex)) {
          process.emitWarning(`Resource deletion index was published before its acknowledgement failed: ${String(error)}`);
          tryCleanup(); return;
        }
        if (JSON.stringify(current) !== JSON.stringify(oldIndex)) {
          recoveryNeeded = true;
          throw new Error("Resource deletion inventory changed; retained backups require recovery.", { cause: error });
        }
      }
      if (previous && !resources.has(id)) { resources.set(id, previous); descriptorBytes += encodedBytes(previous.resource); }
      if (previousPins !== undefined) pins[id] = previousPins;
      const failures: unknown[] = [];
      for (const file of backups) {
        try { if (!existsSync(file)) linkSync(file + suffix, file); } catch (failure) { failures.push(failure); }
      }
      try { syncDirectory(resourceDirectory); syncDirectory(blobDirectory); } catch (failure) { failures.push(failure); }
      if (pinsAttempted) {
        try { if (oldPins === undefined) { if (existsSync(pinsPath)) unlinkSync(pinsPath); } else writeDurableJson(pinsPath, oldPins); } catch (failure) { failures.push(failure); }
      }
      if (indexAttempted) {
        try { if (oldIndex === undefined) { if (existsSync(indexPath)) unlinkSync(indexPath); } else publishIndex(root, oldIndex); } catch (failure) { failures.push(failure); }
      }
      if (!failures.length) {
        // Restored originals no longer need these exact backups. Persist their
        // ownership before attempting cleanup after the completed rollback.
        try {
          updateIndex(backups.map(file => `${file === descriptor ? "resources" : "blobs"}/${basename(file)}${suffix}`));
          retryCleanup();
        } catch (cleanup) { throw new AggregateError([error, cleanup], "Resource deletion rollback retained backups requiring cleanup.", { cause: error }); }
        throw error;
      }
      // The backup paths remain available even if restoration itself failed.
      recoveryNeeded = true;
      throw new AggregateError([error, ...failures], `Resource deletion failed; retained sources: ${backups.map(file => file + suffix).join(", ")}`, { cause: error });
    }
    // Logical release has committed. Ordinary callers must not mistake a
    // backup cleanup failure for a rollback; stopped retirement explicitly
    // requires retryCleanup to finish before reporting archive completion.
    tryCleanup();
  };
  return { root, get resources() { assertWritable(); return resources; }, saveResource, publishMigrationResource, writeResource, importResourceFile, acquireResource, pinResource, unpinResource, releaseResource, retryCleanup, assertResourceReleasable, descriptorBytes: () => { assertWritable(); return descriptorBytes; } };
};
export type ResourceFiles = ReturnType<typeof openResourceFiles>;
