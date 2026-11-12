import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseSessionResource, type SessionResource } from "../../../session/protocol.js";
import { syncDirectory, writeDurableJson } from "../../../platform/durable-json.js";

export type PendingResource = { resource: SessionResource; data: string | null };
export type ControlledResourceLease = { readonly path: string; readonly resource: SessionResource; read(offset: string, limit: number): Buffer; close(): void };
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const name = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;

export const openResourceFiles = (journal: string, sessionId: string) => {
  const root = `${journal}.pending-content`;
  const timelineDirectory = join(root, "timeline"), resourceDirectory = join(root, "resources"), blobDirectory = join(root, "blobs");
  mkdirSync(resourceDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(blobDirectory, { recursive: true, mode: 0o700 });
  syncDirectory(dirname(root));
  syncDirectory(root);
  const manifest = join(root, "manifest.json");
  if (existsSync(manifest)) {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as { schemaVersion: number; sessionId: string };
    if (value.schemaVersion !== 1 || value.sessionId !== sessionId) throw new Error("Pending content belongs to another session.");
  } else writeDurableJson(manifest, { schemaVersion: 1, sessionId });
  const indexPath = join(root, "index.json");
  type ResourceIndex = { entries: string[]; resources: string[] };
  const removalPath = join(root, "resource-removal.json");
  const recoverRemoval = (): void => {
    if (!existsSync(removalPath)) return;
    const removal = JSON.parse(readFileSync(removalPath, "utf8")) as { name: string; suffix: string; index: ResourceIndex };
    if (!/^[a-f0-9]{64}\.json$/.test(removal.name) || !/^\.[a-f0-9-]{36}\.removing$/.test(removal.suffix) || !Array.isArray(removal.index?.entries) || !Array.isArray(removal.index?.resources)) throw new Error("Invalid pending resource removal.");
    const blob = removal.name.replace(/\.json$/, ".bin");
    for (const file of [join(blobDirectory, blob), join(resourceDirectory, removal.name)]) {
      const backup = file + removal.suffix;
      if (existsSync(backup) && !existsSync(file)) renameSync(backup, file);
    }
    syncDirectory(blobDirectory); syncDirectory(resourceDirectory);
    writeDurableJson(indexPath, removal.index);
    unlinkSync(removalPath);
    syncDirectory(root);
  };
  recoverRemoval();
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) as ResourceIndex : { entries: [], resources: [] };
  if (!Array.isArray(index.entries) || !Array.isArray(index.resources)) throw new Error("Invalid pending content index.");
  // Retain unconfirmed staged originals. A leftover after confirmed deletion is
  // indistinguishable from an unconfirmed commit without the removal record.
  for (const [directory, extension] of [[resourceDirectory, "json"], [blobDirectory, "bin"]] as const) {
    let changed = false;
    for (const file of readdirSync(directory)) {
      const match = new RegExp(`^([a-f0-9]{64})\\.${extension}\\.[a-f0-9-]{36}\\.removing$`).exec(file);
      if (!match) continue;
      if (!index.resources.includes(`${match[1]}.json`)) continue;
      const original = join(directory, `${match[1]}.${extension}`), backup = join(directory, file);
      if (!existsSync(original)) { renameSync(backup, original); changed = true; }
    }
    if (changed) syncDirectory(directory);
  }
  for (const [directory, names] of [[timelineDirectory, index.entries], [resourceDirectory, index.resources]] as const) {
    for (const name of names) if (!/^[a-f0-9]{64}\.json$/.test(name) || !existsSync(join(directory, name))) throw new Error("Pending archive source is incomplete.");
  }
  const resources = new Map<string, PendingResource>();
  const leases = new Map<string, number>();
  let recoveryNeeded = false;
  const assertWritable = (): void => { if (recoveryNeeded) throw new Error("Pending resource removal requires recovery before further writes."); };
  const assertNoStagedDescriptor = (id: string): void => {
    const prefix = `${name(id)}.`;
    if (readdirSync(resourceDirectory).some(file => file.startsWith(prefix) && /^[a-f0-9-]{36}\.removing$/.test(file.slice(prefix.length)))) throw new Error("Unconfirmed pending resource removal; staged descriptor was retained.");
  };
  const pinsPath = join(root, "resource-pins.json");
  const pins: Record<string, string[]> = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, "utf8")) as Record<string, string[]> : {};
  if (!pins || Array.isArray(pins) || typeof pins !== "object" || Object.values(pins).some(values => !Array.isArray(values) || values.some(value => typeof value !== "string" || !value))) throw new Error("Invalid persistent resource references.");
  const blobPath = (id: string) => join(blobDirectory, name(id).replace(/\.json$/, ".bin"));
  const openBlob = (resource: SessionResource): number => {
    const file = blobPath(resource.resourceId);
    if (!existsSync(file)) throw new Error("Pending archive source is incomplete: saved resource blob is missing.");
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || String(stat.size) !== resource.byteLength) { closeSync(fd); throw new Error("Corrupt pending resource content."); }
    return fd;
  };
  const verifyBlob = (resource: SessionResource): void => {
    const fd = openBlob(resource);
    try {
      const hash = createHash("sha256"), block = Buffer.alloc(524288); let count = 0;
      for (;;) { const size = readSync(fd, block, 0, block.length, count); if (!size) break; count += size; hash.update(block.subarray(0, size)); }
      if (count > MAX_RESOURCE_BYTES || String(count) !== resource.byteLength || hash.digest("hex") !== resource.sha256) throw new Error("Corrupt pending resource content.");
    } finally { closeSync(fd); }
  };
  const publishBytes = (resource: SessionResource, copy: (fd: number) => { length: number; digest: string }): void => {
    if (resource.status !== "available" || resource.byteLength === null || resource.sha256 === null || BigInt(resource.byteLength) > BigInt(MAX_RESOURCE_BYTES)) throw new Error("Invalid pending resource bytes.");
    const file = blobPath(resource.resourceId), temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    let published = false;
    try {
      const result = copy(fd);
      if (result.length > MAX_RESOURCE_BYTES || String(result.length) !== resource.byteLength || result.digest !== resource.sha256) throw new Error("Corrupt pending resource content.");
      fsyncSync(fd); closeSync(fd);
      if (existsSync(file)) { verifyBlob(resource); unlinkSync(temporary); }
      else renameSync(temporary, file);
      syncDirectory(blobDirectory); published = true;
    } finally { if (!published) { try { closeSync(fd); } catch {} if (existsSync(temporary)) unlinkSync(temporary); } }
  };
  for (const file of readdirSync(resourceDirectory).filter(file => file.endsWith(".json"))) {
    const original = readFileSync(join(resourceDirectory, file));
    const value = JSON.parse(original.toString("utf8")) as PendingResource;
    const resource = parseSessionResource(value.resource);
    if (name(resource.resourceId) !== file || (value.data !== null && typeof value.data !== "string")) throw new Error("Invalid pending resource identity.");
    if (value.data !== null) {
      const content = Buffer.from(value.data, "base64");
      if (content.toString("base64") !== value.data) throw new Error("Corrupt pending resource content.");
      publishBytes(resource, fd => { writeFileSync(fd, content); return { length: content.length, digest: createHash("sha256").update(content).digest("hex") }; });
      // Keep the exact old source until the new reader has verified the closure.
      const legacy = join(root, "legacy-resources"); mkdirSync(legacy, { recursive: true, mode: 0o700 });
      const old = join(legacy, file); if (!existsSync(old)) { const fd = openSync(old, "wx", 0o600); try { writeFileSync(fd, original); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(legacy); }
      verifyBlob(resource); writeDurableJson(join(resourceDirectory, file), { resource, data: null });
    }
    if (resource.status === "available") verifyBlob(resource);
    resources.set(resource.resourceId, { resource, data: null });
  }
  // SQL content_index is the durable timeline inventory. Rewriting a growing
  // entry list on each insert would make an otherwise linear archive quadratic.
  // Resources have their own small inventory because their bytes do not live in SQL.
  const updateIndex = () => writeDurableJson(indexPath, { entries: [], resources: [...resources.keys()].map(name).sort() });
  const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  let descriptorBytes = [...resources.values()].reduce((sum, value) => sum + encodedBytes(value.resource), 0);
  const checkResourceBudget = (resource?: SessionResource): void => {
    const known = new Set([...resources.keys()].map(id => name(id).replace(/\.json$/, ".bin")));
    let bytes = 0, orphans = 0;
    for (const file of readdirSync(blobDirectory).filter(file => file.endsWith(".bin") || /^[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.removing$/.test(file))) {
      const metadata = lstatSync(join(blobDirectory, file));
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid pending resource blob.");
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
  checkResourceBudget();
  if (!existsSync(indexPath)) updateIndex();
  const saveResource = (value: PendingResource, bytes?: Uint8Array) => {
    assertWritable();
    assertNoStagedDescriptor(value.resource.resourceId);
    parseSessionResource(value.resource);
    const input = bytes ?? (value.data === null ? undefined : Buffer.from(value.data, "base64"));
    if (value.data !== null && Buffer.from(value.data, "base64").toString("base64") !== value.data) throw new Error("Corrupt pending resource content.");
    const previous = resources.get(value.resource.resourceId);
    if (previous?.resource.status === "available" && JSON.stringify(previous.resource) !== JSON.stringify(value.resource)) throw new Error("An available local resource cannot change identity.");
    checkResourceBudget(value.resource);
    if (input !== undefined) publishBytes(value.resource, fd => { writeFileSync(fd, input); return { length: input.byteLength, digest: createHash("sha256").update(input).digest("hex") }; });
    if (value.resource.status === "available") verifyBlob(value.resource);
    const normalized = { resource: value.resource, data: null };
    if (previous && JSON.stringify(previous) === JSON.stringify(normalized)) return;
    const existed = previous !== undefined;
    writeDurableJson(join(resourceDirectory, name(value.resource.resourceId)), normalized);
    resources.set(value.resource.resourceId, JSON.parse(JSON.stringify(normalized)) as PendingResource);
    descriptorBytes += encodedBytes(value.resource) - (previous ? encodedBytes(previous.resource) : 0);
    if (!existed) updateIndex();
  };
  const writeResource = (resource: SessionResource, bytes: Uint8Array) => saveResource({ resource, data: null }, bytes);
  const importResourceFile = (resource: SessionResource, source: string): void => {
    assertWritable();
    assertNoStagedDescriptor(resource.resourceId);
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
    const resource = resources.get(id)?.resource;
    if (!resource || resource.status !== "available") throw new Error("Local session resource is unavailable.");
    const fd = openBlob(resource); let closed = false; leases.set(id, (leases.get(id) ?? 0) + 1);
    return { path: blobPath(id), resource, read(offset, limit) {
      if (closed) throw new Error("Resource lease is closed.");
      if (!/^(0|[1-9][0-9]{0,18})$/.test(offset) || BigInt(offset) > BigInt(resource.byteLength!) || !Number.isSafeInteger(limit) || limit < 1 || limit > 524288) throw new Error("Invalid local resource chunk limit.");
      const size = Math.min(limit, Number(BigInt(resource.byteLength!) - BigInt(offset))), block = Buffer.alloc(size);
      if (size && readSync(fd, block, 0, size, Number(offset)) !== size) throw new Error("Corrupt pending resource content."); return block;
    }, close() { if (!closed) { closeSync(fd); closed = true; leases.set(id, leases.get(id)! - 1); } } };
  };
  const pinResource = (id: string, reference: string): void => { assertWritable(); if (!resources.has(id) || !reference) throw new Error("Invalid resource reference."); pins[id] = [...new Set([...(pins[id] ?? []), reference])]; writeDurableJson(pinsPath, pins); };
  const unpinResource = (id: string, reference: string): void => { assertWritable(); pins[id] = (pins[id] ?? []).filter(value => value !== reference); writeDurableJson(pinsPath, pins); };
  const releaseResource = (id: string): void => {
    assertWritable();
    assertNoStagedDescriptor(id);
    if ((leases.get(id) ?? 0) > 0 || (pins[id]?.length ?? 0) > 0) throw new Error("Resource has an active lease or reference.");
    const descriptor = join(resourceDirectory, name(id)), blob = blobPath(id);
    const suffix = `.${randomUUID()}.removing`, previous = resources.get(id), previousPins = pins[id];
    const currentIndex = JSON.parse(readFileSync(indexPath, "utf8")) as ResourceIndex;
    const rollbackIndex = { entries: currentIndex.entries, resources: [...resources.keys()].map(name).sort() };
    // The durable undo record remains until the deletion inventory is confirmed.
    try {
      writeDurableJson(removalPath, { name: name(id), suffix, index: rollbackIndex });
      delete pins[id]; writeDurableJson(pinsPath, pins);
      if (existsSync(descriptor)) renameSync(descriptor, descriptor + suffix);
      syncDirectory(resourceDirectory);
      resources.delete(id);
      updateIndex();
      unlinkSync(removalPath);
      syncDirectory(root);
    } catch (error) {
      if (previous) resources.set(id, previous);
      if (previousPins !== undefined) pins[id] = previousPins;
      try {
        if (!existsSync(removalPath)) writeDurableJson(removalPath, { name: name(id), suffix, index: rollbackIndex });
        recoverRemoval();
      } catch { recoveryNeeded = true; }
      throw error;
    }
    descriptorBytes -= previous ? encodedBytes(previous.resource) : 0;
    // An orphaned blob stays visible to the physical budget if cleanup fails.
    for (const file of [blob, descriptor + suffix]) { try { unlinkSync(file); } catch {} }
  };
  return { root, resources, saveResource, writeResource, importResourceFile, acquireResource, pinResource, unpinResource, releaseResource, descriptorBytes: () => descriptorBytes };
};
export type ResourceFiles = ReturnType<typeof openResourceFiles>;
