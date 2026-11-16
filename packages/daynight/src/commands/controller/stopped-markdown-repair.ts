import Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { withStoppedControllerStorage } from "./stopped-storage.js";
import { runSqliteImmediate } from "../../platform/sqlite-access.js";
import { openSessionContent } from "./content/session-content.js";
import { openControllerOutbox } from "./outbox-store.js";
import { controllerMetadataBudget } from "./media/metadata-budget.js";
import { controllerStorageMediaUsage, reserveControllerStoragePeak } from "./storage-capacity.js";
import { createMarkdownImageProjector, type MarkdownProjectedOccurrence, type MarkdownProjectionState } from "./markdown/projection.js";
import { parseSourceEvent } from "../../session/controller-protocol.js";
import { parseTimelineEntry, parseSessionResource, type SessionResource, type TimelineEntry } from "../../session/protocol.js";
import { parseImagePart, type ImagePart } from "../../session/image-values.js";
import { sessionArchiveReferences } from "../../session/archive.js";
import { sessionDisplayEntry } from "./wire-display.js";

export type StoppedMarkdownImageContext = {
  ticket: ControllerLaunchTicket; snapshot: ControllerSnapshot; journalPath: string;
  root: { dev: string; ino: string } | null; signal: AbortSignal;
};
export type StoppedMarkdownImageResolution = { part: ImagePart; resource?: SessionResource; bytes?: Uint8Array };
export type StoppedMarkdownImageResolver = (source: MarkdownProjectedOccurrence, context: StoppedMarkdownImageContext) => Promise<StoppedMarkdownImageResolution>;
export type StoppedMarkdownRepairResult = { repaired: string[]; failures: { entryId: string; code: string }[] };
type Plan = {
  schemaVersion: 1; ticketHash: string; snapshot: string; originalState: MarkdownProjectionState;
  originalEntry: TimelineEntry; parsedState: MarkdownProjectionState; analysisHash: string; state: "prepared" | "committed";
  diagnostic: string | null;
};
const planKey = (entryId: string) => `stopped_markdown_repair:${entryId}`;
const sourceKey = (entryId: string) => `markdown:projection:${entryId}`;
const same = (left: unknown, right: unknown) => controllerPayloadHash(left) === controllerPayloadHash(right);
function failure(code: string): never { throw Object.assign(new Error(`Stopped Markdown repair requires attention (${code}); original content is retained.`), { code }); }
const errorCode = (error: unknown): string => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "repair_failed";
};

/** Only generated identities vary between independent analyses of the same input. */
const comparableAnalysis = (state: MarkdownProjectionState, original: MarkdownProjectionState): unknown => {
  const failed = new Set(original.parts.filter(part => part.status === "failed").map(part => part.partId));
  const existing = new Set(original.parts.flatMap(part => [...part.current, ...part.retained].map(source => source.occurrence.imageId)));
  const allocated = new Set<string>();
  return { ...state, token: null, parts: state.parts.map(part => {
    if (!failed.has(part.partId)) return part;
    const identities = new Map(part.current.map((source, index) => {
      const id = source.occurrence.imageId;
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || existing.has(id) || allocated.has(id)) failure("repair_plan_changed");
      allocated.add(id); return [id, `occurrence:${index}`];
    }));
    const normalize = (source: MarkdownProjectedOccurrence) => {
      const id = source.occurrence.imageId, stable = identities.get(id);
      if (!stable || source.part.imageId !== id || source.occurrence.sourceKey !== `markdown:${part.partId}:${part.revision}:${id}`) failure("repair_plan_changed");
      return { ...source, occurrence: { ...source.occurrence, imageId: stable, sourceKey: `markdown:${part.partId}:${part.revision}:${stable}` }, part: { ...source.part, imageId: stable } };
    };
    return { ...part, current: part.current.map(normalize), cache: part.cache ? { ...part.cache, occurrences: part.cache.occurrences.map(normalize) } : null };
  }) };
};

/** Reanalyse durable inputs without admitting a native writer or replaying user input. */
export async function repairStoppedMarkdownProjections(options: {
  journalPath: string; ticket: ControllerLaunchTicket; stateDirectory?: string; signal?: AbortSignal;
  resolveImage?: StoppedMarkdownImageResolver; projector?: ReturnType<typeof createMarkdownImageProjector>;
  beforeWrite?: () => Promise<void>;
}): Promise<StoppedMarkdownRepairResult> {
  const { journalPath, ticket } = options, stateDirectory = options.stateDirectory ?? path.dirname(journalPath);
  const signal = options.signal ?? AbortSignal.timeout(300_000), projector = options.projector ?? createMarkdownImageProjector();
  const ticketHash = controllerPayloadHash(ticket);
  let snapshotText: string | undefined;
  const assertOriginal = (db: Database.Database): ControllerSnapshot => {
    const row = db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string; owner_pid: number | null } | undefined;
    const snapshot = row && JSON.parse(row.snapshot) as ControllerSnapshot;
    if (!row || !snapshot || row.ticket_hash !== ticketHash || row.owner_pid !== null || !snapshot.nativeStopped || snapshot.lifecycle !== "stopped"
      || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId
      || snapshot.testExecutionId !== ticket.testExecutionId || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId
      || snapshotText !== undefined && snapshotText !== row.snapshot) return failure("execution_changed");
    snapshotText = row.snapshot;
    if (!existsSync(`${journalPath}.pending-content/manifest.json`)) return failure("source_missing");
    if (existsSync(`${journalPath}.archive-intent-${ticket.executionGeneration}.json`) || existsSync(`${journalPath}.archive-receipt-${ticket.executionGeneration}.json`)
      || db.prepare("SELECT 1 FROM image_runtime_state WHERE key IN ('stopped_source_tail','archive_history_checkpoint') LIMIT 1").get()) return failure("archive_already_started");
    return snapshot;
  };
  const local = <T>(action: (db: Database.Database) => T): T => {
    signal.throwIfAborted();
    return withStoppedControllerStorage({ journalPath, ticket, stateDirectory, assertOriginal }, db => runSqliteImmediate(db, () => { assertOriginal(db); return action(db); }));
  };
  const load = <T>(db: Database.Database, key: string): T | null => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  };
  const save = (db: Database.Database, key: string, value: unknown): void => {
    const encoded = JSON.stringify(value); controllerMetadataBudget(journalPath, db).assert(Buffer.byteLength(encoded) * 2 + 16384, true);
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, encoded);
  };
  const content = (db: Database.Database) => openSessionContent(journalPath, ticket.sessionId, db, {
    read: action => action(), assertWrite: (additional, growth = 0) => {
      if (!db.inTransaction) throw new Error("Stopped repair publication requires its original transaction.");
      assertOriginal(db);
      const budget = controllerMetadataBudget(journalPath, db); budget.assert(additional, true, growth);
      if (additional > 0) {
        const media = controllerStorageMediaUsage(journalPath, db);
        reserveControllerStoragePeak(journalPath, stateDirectory, ticket.executionId, media.reservedBytes + budget.reservationCeiling(growth), Math.max(0, media.reservedBytes - media.actualBytes) + additional);
      }
    },
  });
  await options.beforeWrite?.();
  const ids = local(db => {
    const values: string[] = [];
    content(db).timeline.iterate(entry => { if (entry.imageProjectionError != null) values.push(entry.entryId); });
    return values;
  });
  const result: StoppedMarkdownRepairResult = { repaired: [], failures: [] };
  for (const entryId of ids) {
    signal.throwIfAborted();
    await options.beforeWrite?.();
    let plan: Plan | null = null;
    try {
      const captured = local(db => {
        const entry = content(db).timeline.get(entryId), state = load<MarkdownProjectionState>(db, sourceKey(entryId));
        if (!entry?.imageProjectionError) return null;
        if (!state || state.entryId !== entryId || state.schemaVersion !== 1) return failure("projection_input_missing");
        const adopted = projector.adoptCommitted(state, entry), rendered = projector.view(adopted).entry;
        const expected = { ...rendered, entrySeq: entry.entrySeq, revision: entry.revision, ...(entry.kind === "user_message" && entry.origin !== undefined ? { origin: entry.origin } : {}) };
        if (!same(expected, entry)) return failure("projection_input_changed");
        const old = load<Plan>(db, planKey(entryId));
        if (old && (old.schemaVersion !== 1 || old.ticketHash !== ticketHash || old.snapshot !== snapshotText || !same(old.originalState, state) || !same(old.originalEntry, entry) || old.state !== "prepared" || old.analysisHash !== controllerPayloadHash(old.parsedState))) return failure("repair_plan_changed");
        const source = db.prepare("SELECT CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS ack FROM execution WHERE id=1").get() as { through: string; ack: string };
        return { entry, state, adopted, old, source, root: load<{ dev: string; ino: string }>(db, "markdown:context:execution-root"), snapshot: assertOriginal(db) };
      });
      if (!captured) continue;
      const unchanged = (db: Database.Database): void => {
        const source = db.prepare("SELECT CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS ack FROM execution WHERE id=1").get();
        if (!same(source, captured.source) || !same(load(db, sourceKey(entryId)), captured.state) || !same(content(db).timeline.get(entryId), captured.entry)
          || !same(load(db, "markdown:context:execution-root"), captured.root)) failure("source_changed");
      };
      const prepared = projector.retryFailed(captured.adopted);
      const parsed = await projector.complete(prepared.state);
      signal.throwIfAborted();
      if (parsed.failed || parsed.pending) {
        await options.beforeWrite?.();
        local(db => {
          unchanged(db);
          save(db, `stopped_markdown_failure:${entryId}`, { ticketHash, originalStateHash: controllerPayloadHash(captured.state), originalEntryHash: controllerPayloadHash(captured.entry), code: "analysis_failed", reasons: parsed.state.parts.filter(part => part.status === "failed").map(part => ({ partId: part.partId, reason: part.failureReason ?? "parse_failed" })) });
        });
        failure("analysis_failed");
      }
      if (captured.old) {
        if (!same(comparableAnalysis(captured.old.parsedState, captured.adopted), comparableAnalysis(parsed.state, captured.adopted))) failure("repair_plan_changed");
        plan = captured.old;
      } else {
        plan = { schemaVersion: 1, ticketHash, snapshot: snapshotText!, originalState: captured.state, originalEntry: captured.entry, parsedState: parsed.state, analysisHash: controllerPayloadHash(parsed.state), state: "prepared", diagnostic: null };
        await options.beforeWrite?.();
        local(db => { unchanged(db); if (load(db, planKey(entryId)) !== null) failure("repair_plan_changed"); save(db, planKey(entryId), plan); });
      }
      let resolved = projector.view(plan.parsedState);
      const resources: StoppedMarkdownImageResolution[] = [];
      // Existing images and retained failures preserve their original identities.
      // Only newly discovered occurrences require a successful, verified capture.
      const oldIds = new Set(captured.state.parts.flatMap(part => [...part.current, ...part.retained].map(source => source.occurrence.imageId)));
      for (const source of plan.parsedState.parts.flatMap(part => part.current)) {
        if (oldIds.has(source.occurrence.imageId) || source.part.type === "image") continue;
        const previousImage = captured.state.parts.flatMap(part => [...part.current, ...part.retained]).find(previous =>
          previous.part.type === "image" && previous.destination === source.destination && previous.contextKey === source.contextKey
          && previous.occurrence.partId === source.occurrence.partId && previous.occurrence.sourceTextSha256 === source.occurrence.sourceTextSha256);
        const reused = local(db => {
          unchanged(db);
          const resourceId = previousImage?.part.type === "image" ? previousImage.part.resourceId : source.occurrence.imageId;
          const resource = content(db).resourceFiles.resources.get(resourceId)?.resource;
          return resource?.status === "available" ? { part: { type: "image" as const, imageId: source.occurrence.imageId, resourceId: resource.resourceId, label: source.part.label }, resource } : null;
        });
        if (!reused && !options.resolveImage) failure("image_source_unavailable");
        const value = reused ?? await options.resolveImage!(source, { ticket, snapshot: captured.snapshot, journalPath, root: captured.root, signal });
        signal.throwIfAborted();
        const part = parseImagePart(value.part);
        if (part.type !== "image" || part.imageId !== source.occurrence.imageId) failure("image_identity_changed");
        if (value.resource) {
          const descriptor = parseSessionResource(value.resource);
          if (descriptor.resourceId !== part.resourceId || descriptor.status !== "available") failure("image_resource_invalid");
        }
        resolved = projector.updateImagePart(resolved.state, source.occurrence.imageId, part);
        resources.push(value);
      }
      const completedPlan: Plan = { ...plan, state: "committed", diagnostic: null };
      await options.beforeWrite?.();
      local(db => {
        unchanged(db);
        if (!same(load(db, planKey(entryId)), plan)) failure("repair_plan_changed");
        const source = content(db);
        const entry = parseTimelineEntry({ ...resolved.entry, entrySeq: captured.entry.entrySeq, revision: String(BigInt(captured.entry.revision) + 1n), ...(captured.entry.kind === "user_message" && captured.entry.origin !== undefined ? { origin: captured.entry.origin } : {}) });
        const oldRefs = sessionArchiveReferences([captured.entry], false), newRefs = sessionArchiveReferences([entry]);
        if ([...oldRefs.resources].some(id => !newRefs.resources.has(id))) failure("retained_resource_lost");
        for (const value of resources) if (value.resource) {
          if (value.bytes) {
            const media = controllerStorageMediaUsage(journalPath, db), budget = controllerMetadataBudget(journalPath, db);
            reserveControllerStoragePeak(journalPath, stateDirectory, ticket.executionId, media.reservedBytes + budget.reservationCeiling() + value.bytes.byteLength, Math.max(0, media.reservedBytes - media.actualBytes) + value.bytes.byteLength * 2);
          }
          source.resourceFiles.saveResource({ resource: value.resource, data: null }, value.bytes);
        }
        for (const id of newRefs.resources) {
          const resource = source.resourceFiles.resources.get(id)?.resource;
          if (!resource || resource.status === "pending") failure("image_resource_missing");
          if (resource.status === "available") {
            const lease = source.resourceFiles.acquireResource(id);
            try {
              const hash = createHash("sha256"); let offset = 0;
              while (offset < Number(resource.byteLength)) {
                const block = lease.read(String(offset), 524288);
                if (!block.length) failure("image_resource_changed");
                hash.update(block); offset += block.length;
              }
              if (String(offset) !== resource.byteLength || hash.digest("hex") !== resource.sha256) failure("image_resource_changed");
            } finally { lease.close(); }
          }
        }
        source.timeline.save(entry);
        const event = { kind: "timeline_upsert" as const, payload: sessionDisplayEntry(entry) };
        const next = BigInt(captured.source.through) + 1n;
        parseSourceEvent({ ...event, sourceSeq: String(next) });
        const encoded = JSON.stringify(event);
        controllerMetadataBudget(journalPath, db).assert(Buffer.byteLength(encoded) + 16384, true);
        openControllerOutbox(db, { assertWrite: () => { if (!db.inTransaction) throw new Error("Stopped repair outbox requires a transaction."); assertOriginal(db); } }).append(next, encoded);
        db.prepare("UPDATE execution SET last_sequence=? WHERE id=1").run(next);
        save(db, sourceKey(entryId), resolved.state);
        save(db, planKey(entryId), completedPlan);
      });
      result.repaired.push(entryId);
    } catch (error) {
      if (signal.aborted) throw error;
      const code = errorCode(error);
      // Never overwrite another repair or conceal an uncertain commit.
      if (plan) {
        await options.beforeWrite?.();
        local(db => {
          const current = load<Plan>(db, planKey(entryId));
          if (current && same(current, plan)) save(db, planKey(entryId), { ...current, diagnostic: code });
        });
      }
      result.failures.push({ entryId, code });
    }
  }
  return result;
}
