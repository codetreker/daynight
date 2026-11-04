import { assertTerminalBinding } from "../../../session/v2/protocol.js";
import { canonicalSessionJson, SESSION_V2_PROTOCOL } from "../../../session/v2/values.js";
import type { SessionV2Message } from "../../../session/v2/types.js";
import type { ClaimIdentity } from "../types.js";
import { herdrLedgerHash, herdrLedgerPayloadHash, type HerdrLifecycleStore } from "./lifecycle-store.js";
import type { HerdrLedgerRequest, HerdrLifecycleRecord } from "./lifecycle-types.js";
import { HerdrSessionHttpError, type HerdrSessionApi, type HerdrSessionState } from "./session-api.js";

const same = (left: unknown, right: unknown): boolean => canonicalSessionJson(left) === canonicalSessionJson(right);
const reject = (): never => { throw new Error("The original Herdr Session decision is unconfirmed or conflicts with service state; no replacement registration was submitted."); };
const need = (store: HerdrLifecycleStore, identity: ClaimIdentity): HerdrLifecycleRecord => store.get(identity) ?? reject();
const envelope = (record: HerdrLifecycleRecord, generation = record.runs.at(-1)?.run.executionGeneration) => {
  if (generation === undefined) return reject();
  return { protocol: SESSION_V2_PROTOCOL, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: generation, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const };
};
const stateIdentity = (record: HerdrLifecycleRecord) => ({ owner: record.owner, sessionId: record.sessionId, claimId: record.claimId });

/** Service history can lag a local stop or native-ID observation, but cannot replace it. */
const assertHistory = (record: HerdrLifecycleRecord, observed: HerdrSessionState): void => {
  if (observed.sessionId !== record.sessionId || observed.claimId !== record.claimId || !same(observed.owner, record.owner) || observed.ledger.finalizationId !== null || Object.values(observed.capabilities).some(Boolean)) reject();
  const local = record.runs.map(run => run.run), remote = observed.ledger.runs;
  if (remote.length > local.length || local.length > remote.length + 1) reject();
  const registered = local.find(run => run.executionGeneration === observed.executionGeneration);
  if (registered === undefined || observed.executionGeneration !== (remote.at(-1)?.executionGeneration ?? "1")) return reject();
  assertTerminalBinding(observed.binding, registered.binding);
  for (const [index, previous] of remote.entries()) {
    const next = local[index]!;
    if (previous.executionGeneration !== next.executionGeneration || previous.startedAt !== next.startedAt || !same(previous.owner, next.owner)) reject();
    assertTerminalBinding(previous.binding, next.binding);
    if (previous.stopProof !== null && !same(previous, next)) reject();
    if (previous.segmentIds.length > next.segmentIds.length || !same(previous.segmentIds, next.segmentIds.slice(0, previous.segmentIds.length))) reject();
  }
};

const reconcileRegistration = async (store: HerdrLifecycleStore, record: HerdrLifecycleRecord, api: HerdrSessionApi, signal?: AbortSignal): Promise<HerdrLifecycleRecord> => {
  const request = record.registrationRequest;
  if (request === null) return reject();
  const observed = await api.current({ owner: record.owner, claimId: record.claimId }, signal);
  if (observed.status !== "registered") return reject();
  assertHistory(record, observed);
  const expectedEpoch = String(BigInt(request.payload.connectionEpoch ?? "0") + 1n);
  if (observed.executionGeneration !== request.executionGeneration || observed.connectionEpoch !== expectedEpoch || !same(observed.binding, request.payload.binding)) return reject();
  return store.update(record, draft => { draft.connectionEpoch = observed.connectionEpoch; draft.registrationRequest = null; });
};

const matchesLedger = (request: HerdrLedgerRequest, observed: HerdrSessionState): boolean => observed.executionGeneration === request.message.executionGeneration && observed.connectionEpoch === request.connectionEpoch && same(observed.ledger, request.message.payload) && same(observed.binding, request.message.payload.runs.at(-1)!.binding);
const acknowledgeLedger = (store: HerdrLifecycleStore, record: HerdrLifecycleRecord, request: HerdrLedgerRequest): HerdrLifecycleRecord => store.update(record, draft => {
  draft.publishedLedgerHash = herdrLedgerPayloadHash(request.message.payload);
  draft.ledgerRequest = null;
});
const reconcileLedger = async (store: HerdrLifecycleStore, record: HerdrLifecycleRecord, api: HerdrSessionApi, signal?: AbortSignal): Promise<HerdrLifecycleRecord> => {
  const request = record.ledgerRequest;
  if (request === null) return reject();
  const observed = await api.state(stateIdentity(record), signal);
  assertHistory(record, observed);
  if (!matchesLedger(request, observed)) return reject();
  return acknowledgeLedger(store, record, request);
};

/** A persisted pending request is read back, never automatically dispatched a second time. */
export const connectHerdrSession = async (store: HerdrLifecycleStore, identity: ClaimIdentity, api: HerdrSessionApi, signal?: AbortSignal): Promise<HerdrLifecycleRecord> => {
  let record = need(store, identity);
  if (record.ledgerRequest !== null) record = await reconcileLedger(store, record, api, signal);
  if (record.registrationRequest !== null) return reconcileRegistration(store, record, api, signal);
  await api.verifySupport(signal);
  let generation = record.runs.at(-1)?.run.executionGeneration, binding = record.runs.at(-1)?.run.binding;
  if (generation === undefined || binding === undefined) return reject();
  if (record.connectionEpoch === null) {
    const observed = await api.current({ owner: record.owner, claimId: record.claimId }, signal);
    if (observed.status !== "not_registered" || generation !== "1") return reject();
  } else {
    const observed = await api.state(stateIdentity(record), signal);
    assertHistory(record, observed);
    if (observed.connectionEpoch !== record.connectionEpoch) return reject();
    // A prepared successor is granted by the ledger only after reconnecting the registered generation.
    generation = observed.executionGeneration; binding = observed.binding;
  }
  const request: Extract<SessionV2Message, { type: "registration" }> = { ...envelope(record, generation), type: "registration", payload: { registrationId: record.registrationId, mode: record.connectionEpoch === null ? "register" : "reconnect", connectionEpoch: record.connectionEpoch, owner: record.owner, binding, capabilities: { observe: false, control: false, archive: false } } };
  record = store.update(record, draft => { draft.registrationRequest = request; });
  let epoch: string;
  try { epoch = (await api.register(request, signal)).payload.connectionEpoch; }
  catch { return reconcileRegistration(store, record, api, signal); }
  return store.update(record, draft => { draft.connectionEpoch = epoch; draft.registrationRequest = null; });
};

/** Stop publication retains the original epoch even after the claim becomes terminal. */
export const publishHerdrLedger = async (store: HerdrLifecycleStore, identity: ClaimIdentity, api: HerdrSessionApi, signal?: AbortSignal): Promise<void> => {
  let record = need(store, identity);
  if (record.ledgerRequest !== null) record = await reconcileLedger(store, record, api, signal);
  if (record.registrationRequest !== null) record = await reconcileRegistration(store, record, api, signal);
  if (record.connectionEpoch === null) return reject();
  if (record.publishedLedgerHash === herdrLedgerHash(record)) return;
  const message: Extract<SessionV2Message, { type: "generation_ledger" }> = { ...envelope(record), type: "generation_ledger", payload: { runs: record.runs.map(run => run.run), finalizationId: null } };
  const request: HerdrLedgerRequest = { message, connectionEpoch: record.connectionEpoch };
  try {
    const observed = await api.state(stateIdentity(record), signal);
    assertHistory(record, observed);
    if (observed.connectionEpoch !== record.connectionEpoch) return reject();
    if (matchesLedger(request, observed)) { acknowledgeLedger(store, record, request); return; }
  }
  catch (error) {
    // Deleted tasks reject state reads while retaining the owner's stopped-ledger endpoint.
    // Only a first, fully stopped publication can use that endpoint without a state snapshot.
    if (!(error instanceof HerdrSessionHttpError) || error.status !== 404 || record.runs.length === 0 || record.runs.some(run => run.phase !== "stopped_confirmed" || run.run.stopProof === null)) throw error;
  }
  record = store.update(record, draft => { draft.ledgerRequest = request; });
  try { await api.ledger(message, request.connectionEpoch, signal); }
  catch { await reconcileLedger(store, record, api, signal); return; }
  acknowledgeLedger(store, record, request);
};
