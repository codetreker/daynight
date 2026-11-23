import type Database from "better-sqlite3";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const has = (value: ObjectValue, key: string): boolean => Object.hasOwn(value, key);
const invalid = Symbol("invalid JSON"), missing = Symbol("missing companion");
const parse = (value: string): unknown => {
  try { return JSON.parse(value) as unknown; }
  catch (error) { if (error instanceof SyntaxError) return invalid; throw error; }
};

/** Upgrade only the changed capture fields in the journal transaction, without source IO. */
export const migrateDirectCaptureState = (db: Database.Database, sql: string): undefined => {
  const owner = (request: ObjectValue): { request: ObjectValue; attemptId: unknown } | null => {
    if (typeof request.captureId !== "string" || !has(request, "attemptId")) return null;
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`capture:${request.captureId}`) as { value: string } | undefined;
    if (!row) return { request, attemptId: request.attemptId };
    const capture = object(parse(row.value));
    const original = capture && object(capture.request);
    if (!capture || !original || !has(capture, "attemptId")) return null;
    return { request: original, attemptId: capture.attemptId };
  };
  const sealed = (request: ObjectValue): unknown => {
    const row = db.prepare("SELECT validated FROM image_captures WHERE capture_id=?").get(`${request.captureId}:${request.attemptId}`) as { validated: string } | undefined;
    return row ? parse(row.validated) : missing;
  };
  const native = (value: unknown): ObjectValue | null => {
    const old = object(value), request = old && object(old.request);
    if (!old || !request || typeof old.phase !== "string" || !["new", "query", "reserved", "commit", "failure", "settled"].includes(old.phase)) return null;
    // An already mapped state needs no companion lookup or rewrite.
    if (!has(old, "unknownAction") && !has(old, "validated") && has(old, "attemptId") && has(old, "submission")) return old;
    const capture = owner(request);
    if (!capture) return null;
    let frozen: ObjectValue | null = null;
    if (capture.attemptId === request.attemptId && old.phase !== "new" && old.phase !== "settled") {
      if (old.phase !== "failure" && ![null, "register", "commit", "failure"].includes(old.unknownAction as string | null)) return null;
      let outcome: ObjectValue | null = null;
      if (old.phase === "failure" || old.unknownAction === "failure") {
        const part = object(old.part);
        if (!part || !has(part, "error")) return null;
        outcome = { kind: "failed", error: part.error };
      } else {
        const locator = object(request.locator);
        if (!locator || !has(locator, "kind")) return null;
        if (locator.kind === "resource") outcome = { kind: "resource" };
        else {
          if (!has(old, "validated")) return null;
          const validated = old.validated === null ? sealed(request) : old.validated;
          if (validated === invalid || validated === null || (validated === missing && (old.phase === "commit" || old.unknownAction === "commit"))) return null;
          if (validated !== missing) outcome = { kind: "validated", validated };
        }
      }
      if (outcome) frozen = { ...capture, outcome };
    }
    const phase = old.phase === "settled" ? "settled"
      : capture.attemptId !== request.attemptId || old.phase === "query" ? "query"
        : frozen ? "submit" : old.phase === "new" ? "new" : "preparing";
    const resumeReserved = phase === "query" && capture.attemptId === request.attemptId
      ? frozen ? "submission" : old.unknownAction === "register" ? "source" : undefined
      : undefined;
    const { unknownAction: _unknownAction, validated: _validated, ...rest } = old;
    return { ...rest, request: capture.request, attemptId: capture.attemptId, phase, submission: frozen, ...(resumeReserved ? { resumeReserved } : {}) };
  };
  const markdown = (value: unknown): ObjectValue | null => {
    const old = object(value);
    if (!old) return null;
    if (!has(old, "retryControl") && !has(old, "observeOnly") && has(old, "submission")) return old;
    const { retryControl, observeOnly, ...record } = old;
    if (!record.request || record.phase === "settled") return record;
    const request = object(record.request);
    if (!request || typeof record.phase !== "string") return null;
    const capture = owner(request);
    if (!capture) return null;
    const retry = retryControl == null ? null : object(retryControl);
    if (retryControl != null && (!retry || (retry.action !== "failure" && retry.action !== "commit"))) return null;
    let outcome: ObjectValue | null = null;
    if (capture.attemptId === request.attemptId) {
      if (retry?.action === "failure") {
        if (!has(retry, "error")) return null;
        outcome = { kind: "failed", error: retry.error };
      } else if (retry?.action === "commit") {
        if (!has(retry, "validated")) return null;
        outcome = { kind: "validated", validated: retry.validated };
      } else if (record.error && record.phase !== "waiting") outcome = { kind: "failed", error: record.error };
      else if (record.phase === "unknown" || record.phase === "validated") {
        const locator = record.phase === "unknown" ? object(request.locator) : null;
        if (record.phase === "unknown" && (!locator || !has(locator, "kind"))) return null;
        if (locator?.kind === "resource") outcome = { kind: "resource" };
        else if (record.phase === "validated" || observeOnly) {
          const validated = sealed(request);
          if (validated === invalid || validated === null || (validated === missing && record.phase === "validated")) return null;
          if (validated !== missing) outcome = { kind: "validated", validated };
        }
      }
    }
    if (outcome) {
      if (retry && (typeof retry.after !== "number" || typeof record.cooldownUntil !== "number")) return null;
      record.submission = { request: capture.request, attemptId: request.attemptId, outcome };
      record.dispatchPending = !!retryControl || record.phase === "validated";
      if (!record.dispatchPending) record.resumeReserved = "submission";
      record.phase = "unknown";
      if (retry) record.cooldownUntil = Math.max(record.cooldownUntil as number, retry.after as number);
    } else if (record.phase === "unknown" || record.awaitingRetry || capture.attemptId !== request.attemptId) {
      if (!record.started && !record.awaitingRetry && !observeOnly && capture.attemptId === request.attemptId) record.resumeReserved = "source";
      record.awaitingRetry = true; record.phase = "unknown";
    }
    return record;
  };
  const update = (key: string, original: unknown, mapped: ObjectValue | null): void => {
    if (!mapped || JSON.stringify(mapped) === JSON.stringify(original)) return;
    db.prepare("UPDATE image_runtime_state SET value=? WHERE key=?").run(JSON.stringify(mapped), key);
  };
  const rows = db.prepare("SELECT key,value FROM image_runtime_state WHERE key GLOB 'native_provider:image-slot:*' OR key GLOB 'markdown:source:*' ORDER BY key").all() as { key: string; value: string }[];
  for (const row of rows) {
    const value = parse(row.value);
    if (value === invalid) continue;
    update(row.key, value, row.key.startsWith("native_provider:") ? native(value) : markdown(value));
  }
  const publications = db.prepare("SELECT operation_id,value FROM native_input_publications").all() as { operation_id: string; value: string }[];
  for (const row of publications) {
    const value = object(parse(row.value));
    if (!value || !Array.isArray(value.slots)) continue;
    let changed = false;
    const slots = value.slots.map((item: unknown) => {
      const slot = object(item);
      if (!slot || !has(slot, "state")) return item;
      const state = native(slot.state);
      if (!state || JSON.stringify(state) === JSON.stringify(slot.state)) return item;
      changed = true;
      return { ...slot, state };
    });
    if (changed) db.prepare("UPDATE native_input_publications SET value=? WHERE operation_id=?").run(JSON.stringify({ ...value, slots }), row.operation_id);
  }
  db.exec(sql);
};
