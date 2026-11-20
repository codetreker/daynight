import { randomUUID } from "node:crypto";
import type { UsageAck, UsagePayload, UsageQueuedEvent, UsageState, UsageStore } from "./types.js";

import { usageProfileId } from "./profiles.js";

const PROTOCOL = "daynight.usage.v1";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sequence = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export type UsageUploaderOptions = {
  serverOrigin: string;
  store: UsageStore;
  identity: { sessionId: string; executionGeneration: string; controllerInstanceId: string };
  /** Null when the original Controller connection is no longer authoritative. */
  connection(): { connectionEpoch: string; nativeSessionId: string } | null;
  readParentToken(): Promise<string>;
  onDiagnostic?(message: string): void;
  fetch?: typeof globalThis.fetch;
};

/** Usage delivery never shares the Session relay's cumulative acknowledgement. */
export const createUsageUploader = (options: UsageUploaderOptions) => {
  const { store } = options;
  let closed = false, draining = false, disabled = false, work: Promise<void> | null = null;
  let controller: AbortController | null = null, nextAttempt = 0, failures = 0;
  let profiles: Record<string, unknown>[] | null = null;
  const blocked = new Set<string>();
  const diagnose = (message: string) => options.onDiagnostic?.(message);
  const capability = (state: UsageState): UsagePayload | null => {
    const profile = profiles?.find(item => item.id === usageProfileId(state.provider) && item.provider === state.provider);
    const exact = (Array.isArray(profile?.qualifiedVersions) ? profile.qualifiedVersions : []).map(object).find(item => item.providerVersion === state.providerVersion);
    const value = object(exact?.capability ?? profile?.capability);
    if (value.profileId !== usageProfileId(state.provider) || !["verified", "unverified", "unsupported"].includes(String(value.qualification))) return null;
    if (!exact && value.qualification === "verified") return { ...value, qualification: "unverified" };
    return value;
  };
  const qualified = (state: UsageState): boolean => capability(state)?.qualification === "verified";
  const pendingUpload = (state: UsageState, limit: number) => store.pending(state.stateId, limit, qualified(state) ? undefined : "execution_state");
  /** A failed capability read remains retryable; a known refusal or profile filter does not. */
  const canReplay = (state: UsageState): boolean => {
    if (disabled || blocked.has(state.stateId)) return false;
    if (profiles === null) return !state.stopped || store.pending(state.stateId, 1).length > 0;
    if (capability(state) === null) return false;
    return !state.stopped || pendingUpload(state, 1).length > 0;
  };
  const delay = (retryAfter?: string | null) => {
    failures++;
    const seconds = retryAfter !== undefined && retryAfter !== null && /^\d+$/.test(retryAfter) ? Math.min(300, Math.max(1, Number(retryAfter))) : null;
    nextAttempt = Date.now() + (seconds === null ? Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) * (0.8 + Math.random() * 0.4) : seconds * 1000);
  };
  const request = async (path: string, token: string, body?: unknown) => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 15_000);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(new URL(path, options.serverOrigin), {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Bound responses independently of a peer-provided Content-Length.
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262_144) throw new Error("Usage response exceeded its limit."); chunks.push(part.value); } } finally { await reader.cancel(); }
      const text = Buffer.concat(chunks).toString("utf8");
      let value: unknown; try { value = JSON.parse(text); } catch { value = null; }
      if (closed) throw new Error("Usage uploader is closed.");
      return { response, value: object(value) };
    } finally { clearTimeout(timeout); controller = null; }
  };
  const stopState = (state: UsageState, reason: string) => { blocked.add(state.stateId); store.gap(state.stateId, reason); diagnose(`Usage upload stopped: ${reason}.`); };
  const refusal = (state: UsageState | null, response: Response): boolean => {
    if (response.status === 404 || response.status === 501) { disabled = true; diagnose("Usage reporting is unavailable on this service."); return true; }
    if ([401, 403, 410].includes(response.status)) { if (state) stopState(state, response.status === 410 ? "upload_expired" : "permission_revoked"); else disabled = true; return true; }
    if (response.status === 429 || response.status >= 500) { delay(response.headers.get("retry-after")); return true; }
    return false;
  };
  const validState = (state: UsageState, value: Record<string, unknown>): boolean => value.id === state.stateId && value.sessionId === options.identity.sessionId && value.executionGeneration === state.generation && value.nativeSessionId === state.nativeSessionId && value.registrationId === state.registrationId && value.providerVersion === state.providerVersion && value.profileId === usageProfileId(state.provider) && value.provider === state.provider && sequence(value.rowVersion);
  const saveReceipt = (state: UsageState, value: Record<string, unknown>): boolean => {
    const remote = object(value.state), grant = object(value.grant);
    if (!validState(state, remote) || typeof grant.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) || typeof grant.expiresAt !== "string" || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) return false;
    store.saveGrant(state.stateId, { token: grant.token, expiresAt: grant.expiresAt }, remote.rowVersion as string); return true;
  };
  const acquire = async (state: UsageState): Promise<boolean> => {
    if (state.grant && Date.parse(state.grant.expiresAt) > Date.now() + (state.stopped ? 0 : 60_000)) return true;
    const connection = options.connection();
    if (!connection || state.generation !== options.identity.executionGeneration || connection.nativeSessionId !== state.nativeSessionId || state.stopped) {
      if (state.grant && Date.parse(state.grant.expiresAt) > Date.now()) return true;
      if (state.grant) stopState(state, "upload_expired");
      return false;
    }
    const token = await options.readParentToken();
    const observed = await request(`/api/usage/v1/states/${state.stateId}`, token);
    const current = object(observed.value.state ?? observed.value);
    if (observed.response.status === 404) {
      // An unknown registration outcome is not permission to replay that write.
      if (state.registrationAttempted) { stopState(state, "registration_missing"); return false; }
      store.markRegistrationAttempted(state.stateId);
      const result = await request("/api/usage/v1/registrations", token, {
        protocol: PROTOCOL, stateId: state.stateId, registrationId: state.registrationId,
        ...options.identity, connectionEpoch: connection.connectionEpoch, nativeSessionId: state.nativeSessionId,
        profileId: usageProfileId(state.provider), providerVersion: state.providerVersion,
      });
      if (result.response.status === 429) store.clearRegistrationAttempted(state.stateId);
      if (refusal(state, result.response)) return false;
      if (result.response.status === 409 && object(result.value.error).code === "registration_unavailable") {
        // The server explicitly rejected before registration. A later relay ACK
        // can establish the same original native identity without changing it.
        store.clearRegistrationAttempted(state.stateId); delay(); return false;
      }
      if (![200, 201].includes(result.response.status)) { stopState(state, "registration_missing"); return false; }
      if (!saveReceipt(state, result.value)) { delay(); return false; }
      return true;
    }
    if (refusal(state, observed.response)) return false;
    if (!observed.response.ok || !validState(state, current)) { delay(); return false; }
    if (current.grantRevokedAt) { stopState(state, "permission_revoked"); return false; }
    if (state.grantRequestAttempted) { stopState(state, "collector_failed"); return false; }
    store.markGrantAttempted(state.stateId);
    const result = await request(`/api/usage/v1/states/${state.stateId}/grant`, token, {
      expectedRowVersion: current.rowVersion, ...options.identity, connectionEpoch: connection.connectionEpoch,
    });
    if (result.response.status === 429) store.clearGrantAttempted(state.stateId);
    if (refusal(state, result.response)) return false;
    if (result.response.status === 409 && ["registration_unavailable", "usage_changed"].includes(String(object(result.value.error).code))) {
      // These refusals precede grant replacement. Reobserve the original
      // connection and row version next time; unknown outcomes keep the fence.
      store.clearGrantAttempted(state.stateId); delay(); return false;
    }
    if (!result.response.ok || !saveReceipt(state, result.value)) { delay(); return false; }
    return true;
  };
  const verifyStale = async (state: UsageState, flight: readonly UsageQueuedEvent[], results: readonly UsageAck[]): Promise<boolean> => {
    const stale = results.filter(result => result.outcome === "stale");
    if (!stale.length) return true;
    const keys = stale.map(result => result.sourceKey).filter((key): key is string => key !== null);
    // sources requires at least one key even when only the state revision is read.
    const suffix = `?${new URLSearchParams((keys.length ? keys : ["usage-state-probe-v1"]).map((key): [string, string] => ["key", key]))}`;
    const observed = await request(`/api/usage/v1/states/${state.stateId}/sources${suffix}`, state.grant!.token);
    if (!observed.response.ok) return false;
    const sources = Array.isArray(observed.value.items) ? observed.value.items.map(object) : [];
    return stale.every(result => {
      const sent = flight.find(item => item.eventId === result.eventId)?.payload;
      if (!sent) return false;
      if (sent.kind === "execution_state") return result.stateSequence === observed.value.stateSequence && result.bodyHash === observed.value.bodyHash && sequence(result.stateSequence) && BigInt(result.stateSequence) > BigInt(String(sent.stateSequence));
      const source = sources.find(item => item.sourceKey === sent.sourceKey);
      return sent.revisionAuthority === "native" && source?.originatingStateId === sent.originatingStateId && source?.sourceRevision === result.sourceRevision && source?.finality === result.finality && source?.bodyHash === result.bodyHash;
    });
  };
  const upload = async (state: UsageState) => {
    let flight = pendingUpload(state, 100);
    while (flight.length && Buffer.byteLength(JSON.stringify({ protocol: PROTOCOL, batchId: "00000000-0000-0000-0000-000000000000", events: flight.map(item => item.payload) })) > 262_144) flight.pop();
    if (!flight.length) return;
    const batchId = randomUUID();
    const result = await request(`/api/usage/v1/states/${state.stateId}/batches`, state.grant!.token, { protocol: PROTOCOL, batchId, events: flight.map(item => item.payload) });
    if (refusal(state, result.response)) return;
    if (result.response.status === 409) {
      const fault = object(result.value.error), item = flight.find(item => item.eventId === fault.eventId);
      if (item && ["source_conflict", "finality_regression"].includes(String(fault.code)) && fault.sourceKey === item.payload.sourceKey) {
        store.quarantine(item.eventId, "source_conflict");
        const cap = capability(state);
        if (cap) store.enqueueState(state.stateId, { collectionState: "partial", capability: cap, reasonCodes: ["source_conflict"], nativeStartedAt: null, nativeEndedAt: null, observedAt: new Date().toISOString(), seal: state.stopped });
      } else delay();
      return;
    }
    if (!result.response.ok) { stopState(state, "collector_failed"); return; }
    if (result.value.protocol !== PROTOCOL || result.value.batchId !== batchId || !Array.isArray(result.value.results)) { delay(); return; }
    const rows = result.value.results.map(object);
    if (rows.some(row => !uuid(row.eventId) || !uuid(row.rowId) || !sequence(row.rowVersion) || !hash(row.bodyHash))) { delay(); return; }
    const acks = rows as UsageAck[];
    if (!await verifyStale(state, flight, acks) || !store.acknowledge(flight, acks)) { delay(); return; }
    failures = 0; nextAttempt = 0;
  };
  const run = async () => {
    if (closed || disabled || Date.now() < nextAttempt || store.states().length === 0) return;
    try {
      if (!profiles) {
        const result = await request("/api/usage/v1/capabilities", await options.readParentToken());
        if (refusal(null, result.response)) return;
        if (!result.response.ok || result.value.protocol !== PROTOCOL || result.value.schemaVersion !== 1 || !Array.isArray(result.value.profiles)) { delay(); return; }
        if (result.value.writeEnabled !== true) { disabled = true; return; }
        profiles = result.value.profiles.map(object);
      }
      for (let state of store.states()) {
        if (closed || blocked.has(state.stateId)) continue;
        if (!await acquire(state)) continue;
        state = store.getState(state.stateId);
        await upload(state);
        if (nextAttempt > Date.now() || disabled) return;
      }
    } catch { if (!closed) { diagnose("Usage upload is temporarily unavailable; durable records were retained."); delay(); } }
  };
  const tick = (): Promise<void> => {
    if (draining || closed) return Promise.resolve();
    if (work) return work;
    const active = run().finally(() => { if (work === active) work = null; }); work = active; return active;
  };
  return {
    tick, capability, qualified, canReplay,
    /** Admit a final drain without extending native shutdown beyond five seconds. */
    close: async (): Promise<void> => {
      if (closed || draining) return;
      const final = work ?? tick(); draining = true;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([final, new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); })]);
      if (timeout) clearTimeout(timeout);
      closed = true; controller?.abort();
      // Requests are abortable; the bounded return leaves queued data durable.
    },
  };
};
