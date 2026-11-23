import { createHash } from "node:crypto";
import { bool, count, malformed, record, timestamp } from "./validation.js";

export const WORKER_LIFECYCLE_HEADER = "X-Daynight-Worker-Lifecycle";
export const WORKER_LIFECYCLE_BYTES = 256 * 1024;
type Parser<T> = (value: unknown) => T;
type Parsed<P> = P extends Parser<infer T> ? T : never;
const literal = <T extends string | number | boolean>(expected: T): Parser<T> => value => value === expected ? expected : malformed();
const choice = <T extends string>(...values: T[]): Parser<T> => value => typeof value === "string" && values.includes(value as T) ? value as T : malformed();
const nullable = <T>(parse: Parser<T>): Parser<T | null> => value => value === null ? null : parse(value);
const object = <S extends Record<string, Parser<unknown>>>(schema: S): Parser<{ [K in keyof S]: Parsed<S[K]> }> => value => {
  const input = record(value);
  if (Object.keys(input).length !== Object.keys(schema).length || Object.keys(input).some(key => !Object.hasOwn(schema, key))) return malformed();
  return Object.fromEntries(Object.entries(schema).map(([key, parse]) => [key, parse(input[key])])) as { [K in keyof S]: Parsed<S[K]> };
};
export const lifecycleId: Parser<string> = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000" ? value : malformed();
export const lifecycleVersion: Parser<string> = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : malformed();
const digest: Parser<string> = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : malformed();
const diagnostic = nullable(choice("identity_mismatch", "authority_unavailable", "persistence_failed", "inventory_incomplete", "stop_timeout", "stop_unknown", "save_failed", "upload_failed", "native_unrecoverable", "ownership_changed", "independent_blocker", "unsupported_provider", "resume_interrupted"));
const desired = choice("enabled", "disabled");
const phase = choice("accepting", "disabling", "disabled", "blocked", "resuming");
const save = choice("pending", "durable", "failed");
const protocolVersion = literal(1);
const requestBase = { protocolVersion, operationId: lifecycleId };
const receiptBase = { ...requestBase, workerId: lifecycleId, observedAt: timestamp };
const sortedArray = <T extends { resourceId: string }>(parse: Parser<T>): Parser<T[]> => value => {
  if (!Array.isArray(value) || value.length > 512) return malformed();
  const result = value.map(parse);
  if (result.some((entry, index) => index > 0 && result[index - 1]!.resourceId >= entry.resourceId)) return malformed();
  return result;
};

export const parseLifecycleInstanceRequest = object({ ...requestBase, instanceId: lifecycleId, previousInstanceEpoch: nullable(lifecycleVersion), capabilities: object({ disable: literal(true), resume: literal(true), inventory: literal(1), dispatchFence: literal(1) }), platform: choice("windows", "linux", "macos") });
export type LifecycleInstanceRequest = ReturnType<typeof parseLifecycleInstanceRequest>;
const parseDisableRequest = object({ ...requestBase, action: literal("disable"), expectedVersion: lifecycleVersion, source: choice("web", "local"), localEpoch: nullable(lifecycleVersion), originOperationId: nullable(lifecycleId) });
const parseResumeRequest = object({ ...requestBase, action: literal("resume"), expectedVersion: lifecycleVersion, source: choice("web", "local"), localEpoch: lifecycleVersion, instanceEpoch: lifecycleVersion });
export type LifecycleIntentRequest = ReturnType<typeof parseDisableRequest> | ReturnType<typeof parseResumeRequest>;
export const parseLifecycleIntentRequest = (value: unknown): LifecycleIntentRequest => {
  if (record(value).action === "resume") return parseResumeRequest(value);
  const result = parseDisableRequest(value);
  if (result.source === "web" ? result.localEpoch !== null || result.originOperationId !== null : result.localEpoch === null || result.originOperationId === null) return malformed();
  return result;
};
const activationFields = { ...requestBase, instanceId: lifecycleId, instanceEpoch: lifecycleVersion, intentVersion: lifecycleVersion, localEpoch: lifecycleVersion, scopeGeneration: lifecycleVersion, reportSequence: lifecycleVersion };
const parseResumeActivation = object(activationFields);
const parseInternalActivation = object({ ...activationFields, action: choice("bootstrap", "reconnect") });
export type LifecycleActivationRequest = ReturnType<typeof parseResumeActivation> | ReturnType<typeof parseInternalActivation>;
export const parseLifecycleActivationRequest = (value: unknown): LifecycleActivationRequest => Object.hasOwn(record(value), "action") ? parseInternalActivation(value) : parseResumeActivation(value);
export type LifecycleRequestKind = "instance" | "intent" | "activation";
export type LifecycleResolveRequest = { protocolVersion: 1 } & ({ requestKind: "instance"; request: LifecycleInstanceRequest } | { requestKind: "intent"; request: LifecycleIntentRequest } | { requestKind: "activation"; request: LifecycleActivationRequest });
export const parseLifecycleResolveRequest = (value: unknown): LifecycleResolveRequest => {
  const input = object({ protocolVersion, requestKind: choice("instance", "intent", "activation"), request: record })(value);
  switch (input.requestKind) {
    case "instance": return { ...input, requestKind: "instance", request: parseLifecycleInstanceRequest(input.request) };
    case "intent": return { ...input, requestKind: "intent", request: parseLifecycleIntentRequest(input.request) };
    case "activation": return { ...input, requestKind: "activation", request: parseLifecycleActivationRequest(input.request) };
  }
};

export const parseLifecycleResourceObservation = object({ resourceId: lifecycleId, ownerKind: choice("task", "bot", "assistant", "probe", "repository", "configuration", "controller"), projectId: nullable(lifecycleId), taskId: nullable(lifecycleId), botId: nullable(lifecycleId), executionId: nullable(lifecycleId), sessionId: nullable(lifecycleId), executionGeneration: nullable(lifecycleVersion), stage: choice("reserved", "running", "stopping", "stopped", "unknown"), stop: choice("pending", "confirmed", "unknown"), save, errorCode: diagnostic });
export type LifecycleResourceObservation = ReturnType<typeof parseLifecycleResourceObservation>;
export const parseLifecycleRecoveryObservation = object({ resourceId: lifecycleId, recoverability: choice("unknown", "eligible", "blocked"), reasonCode: diagnostic });
export type LifecycleRecoveryObservation = ReturnType<typeof parseLifecycleRecoveryObservation>;
const observationFields = { phase, stop: choice("not_started", "stopping", "confirmed", "unknown"), save, sync: choice("pending", "complete", "failed"), inventoryComplete: bool, detailsComplete: bool, inventoryRevision: lifecycleVersion, inventoryDigest: digest, resourceCount: nullable(count), stoppedCount: nullable(count), pendingCount: nullable(count), blockedCount: nullable(count), resources: sortedArray(parseLifecycleResourceObservation), recovery: sortedArray(parseLifecycleRecoveryObservation), errorCode: diagnostic };
const parseObservationShape = object(observationFields);
export type LifecycleObservation = ReturnType<typeof parseObservationShape>;
const validateObservation = <T extends LifecycleObservation>(result: T): T => {
  const { resourceCount, stoppedCount, pendingCount, blockedCount } = result;
  if (result.inventoryComplete && (resourceCount === null || stoppedCount === null || pendingCount === null || blockedCount === null || stoppedCount > resourceCount || pendingCount > resourceCount || blockedCount > resourceCount)) return malformed();
  if (result.stop === "confirmed" && (!result.inventoryComplete || resourceCount === null || resourceCount !== stoppedCount || pendingCount !== 0 || blockedCount !== 0 || result.resources.some(r => r.stop !== "confirmed" || r.stage !== "stopped"))) return malformed();
  if (result.save === "durable" && (!result.inventoryComplete || result.resources.some(r => r.save !== "durable"))) return malformed();
  if (result.phase === "disabled" && (result.stop !== "confirmed" || result.save !== "durable")) return malformed();
  if (result.detailsComplete && (resourceCount === null || resourceCount !== result.resources.length)) return malformed();
  return result;
};
export const parseLifecycleObservation = (value: unknown): LifecycleObservation => validateObservation(parseObservationShape(value));
const envelopeFields = { protocolVersion, instanceId: lifecycleId, instanceEpoch: lifecycleVersion, intentVersion: lifecycleVersion, operationId: nullable(lifecycleId), localEpoch: lifecycleVersion, scopeGeneration: lifecycleVersion, reportSequence: lifecycleVersion };
const parseEnvelopeShape = object({ ...envelopeFields, observation: parseLifecycleObservation });
export type LifecycleObservationEnvelope = ReturnType<typeof parseEnvelopeShape>;
export const parseLifecycleObservationEnvelope = (value: unknown): LifecycleObservationEnvelope => {
  const result = parseEnvelopeShape(value);
  if (Buffer.byteLength(JSON.stringify(result)) > WORKER_LIFECYCLE_BYTES) return malformed();
  return result;
};
const parseObservedObservationShape = object({ ...observationFields, receivedAt: timestamp, freshUntil: timestamp });
const parseObservedEnvelope = object({ ...envelopeFields, observation: (value: unknown) => {
  const result = validateObservation(parseObservedObservationShape(value));
  if (Date.parse(result.freshUntil) - Date.parse(result.receivedAt) !== 30_000) return malformed();
  return result;
} });
export type LifecycleObservedEnvelope = ReturnType<typeof parseObservedEnvelope>;
const parseLifecycleResourceShape = object({ protocolVersion, workerId: lifecycleId, intentVersion: lifecycleVersion, desired, admission: choice("open", "closed"), operationId: nullable(lifecycleId), instance: nullable(object({ instanceId: lifecycleId, instanceEpoch: lifecycleVersion })), capability: choice("supported", "unsupported"), observation: nullable(parseObservedEnvelope), observedAt: timestamp });
export type LifecycleResource = ReturnType<typeof parseLifecycleResourceShape>;
export const parseLifecycleResource = (value: unknown): LifecycleResource => {
  const result = parseLifecycleResourceShape(value);
  if (result.admission === "open" && result.desired !== "enabled") return malformed();
  if (result.observation !== null && (result.instance === null || result.observation.instanceId !== result.instance.instanceId || result.observation.instanceEpoch !== result.instance.instanceEpoch || result.observation.intentVersion !== result.intentVersion)) return malformed();
  return result;
};
export const parseLifecycleInstanceReceipt = object({ ...receiptBase, instanceId: lifecycleId, instanceEpoch: lifecycleVersion, intentVersion: lifecycleVersion, desired, admission: literal("closed"), reconnectAllowed: bool });
export type LifecycleInstanceReceipt = ReturnType<typeof parseLifecycleInstanceReceipt>;
export const parseLifecycleIntentReceipt = object({ ...receiptBase, action: choice("disable", "resume"), intentVersion: lifecycleVersion, desired, admission: literal("closed"), state: choice("accepted", "applied", "blocked", "superseded"), errorCode: diagnostic });
export type LifecycleIntentReceipt = ReturnType<typeof parseLifecycleIntentReceipt>;
export const parseLifecycleActivationReceipt = object({ ...receiptBase, action: choice("resume", "bootstrap", "reconnect"), instanceEpoch: lifecycleVersion, intentVersion: lifecycleVersion, localEpoch: lifecycleVersion, scopeGeneration: lifecycleVersion, admission: literal("open") });
export type LifecycleActivationReceipt = ReturnType<typeof parseLifecycleActivationReceipt>;
export const parseLifecycleObservationReceipt = object({ protocolVersion, accepted: literal(true), intentVersion: lifecycleVersion, instanceEpoch: lifecycleVersion, reportSequence: lifecycleVersion, receivedAt: timestamp });
export type LifecycleObservationReceipt = ReturnType<typeof parseLifecycleObservationReceipt>;
export const parseLifecycleResolutionReceipt = object({ ...receiptBase, requestKind: choice("instance", "intent", "activation"), requestHash: digest, outcome: literal("not_committed") });
export type LifecycleResolutionReceipt = ReturnType<typeof parseLifecycleResolutionReceipt>;
export type LifecycleOperationResult = { kind: "intent"; receipt: LifecycleIntentReceipt; activation: LifecycleActivationReceipt | null; activationOutcome: "not_started" | "committed" | "not_committed" } | { kind: "instance"; receipt: LifecycleInstanceReceipt } | { kind: "activation"; receipt: LifecycleActivationReceipt } | { kind: "not_committed"; receipt: LifecycleResolutionReceipt };
export const parseLifecycleOperationResult = (value: unknown): LifecycleOperationResult => {
  switch (record(value).kind) {
    case "intent": {
      const result = object({ kind: literal("intent"), receipt: parseLifecycleIntentReceipt, activation: nullable(parseLifecycleActivationReceipt), activationOutcome: choice("not_started", "committed", "not_committed") })(value);
      if ((result.activationOutcome === "committed") !== (result.activation !== null)) return malformed();
      if (result.activation !== null && (result.receipt.action !== "resume" || result.activation.action !== "resume" || result.activation.workerId !== result.receipt.workerId || result.activation.operationId !== result.receipt.operationId || result.activation.intentVersion !== result.receipt.intentVersion)) return malformed();
      return result;
    }
    case "instance": return object({ kind: literal("instance"), receipt: parseLifecycleInstanceReceipt })(value);
    case "activation": return object({ kind: literal("activation"), receipt: parseLifecycleActivationReceipt })(value);
    case "not_committed": return object({ kind: literal("not_committed"), receipt: parseLifecycleResolutionReceipt })(value);
    default: return malformed();
  }
};

/** The validated protocol uses ASCII strings and safe integers: sorted keys are RFC 8785 canonical JSON. */
export const lifecycleRequestHash = (kind: LifecycleRequestKind, input: unknown): string => {
  const value = parseLifecycleResolveRequest({ protocolVersion: 1, requestKind: kind, request: input }).request;
  const canonical = (entry: unknown): string => entry !== null && typeof entry === "object" ? `{${Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(entry);
  return createHash("sha256").update(`daynight.lifecycle.v1/${kind}\n${canonical(value)}`).digest("hex");
};
