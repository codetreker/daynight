import { ApiError } from "../../api/client";
import {
  decodeWebhookJson, getWebhookOperation, isWebhookIssuedAt, parseWebhookEventType, parseWebhookOwner, submitWebhookMutation, webhookVersion,
  type WebhookAdmission, type WebhookConfigurationInput, type WebhookMutationResult, type WebhookOperationKind, type WebhookOwner, type WebhookReceipt,
} from "../../api/webhooks";
import { canonicalId, record } from "../../api/validation";

export type WebhookPreparedMetadata = {
  readonly serviceOrigin: string;
  readonly actorUserId: string;
  readonly owner: WebhookOwner;
  readonly operationId: string;
  readonly issuedAt: string;
  readonly requestSha256: string;
  readonly kind: WebhookOperationKind;
  readonly endpointId: string | null;
  readonly deliveryId: string | null;
  readonly ifVersion: string | null;
  readonly ifGeneration: string | null;
  readonly destinationRevision: string | null;
};
export type WebhookIntentInput = {
  readonly kind: Exclude<WebhookOperationKind, "delivery.redeliver">;
  readonly endpointId?: string;
  readonly ifVersion?: string;
  readonly destinationRevision?: string;
  readonly body: WebhookConfigurationInput | { readonly mode: "overlap" | "immediate" };
} | {
  readonly kind: "delivery.redeliver";
  readonly endpointId: string;
  readonly deliveryId: string;
  readonly ifVersion: string;
  readonly ifGeneration: string;
  readonly destinationRevision: string;
  readonly body: Record<string, never>;
};
export type WebhookIntentState = {
  readonly phase: "idle" | "preparing" | "submitting" | "unknown" | "rejected" | "confirmed";
  readonly prepared: WebhookPreparedMetadata | null;
  readonly result: WebhookMutationResult | null;
  readonly error: unknown;
  readonly reconciling: boolean;
  readonly persistenceError: unknown;
};
type Options = {
  readonly serviceOrigin: string;
  readonly owner: WebhookOwner;
  readonly admission: WebhookAdmission;
  readonly signal: AbortSignal;
  readonly storage?: Storage;
  readonly canSubmit?: (kind: WebhookOperationKind) => boolean;
};
class WebhookIntentBusy extends Error {
  constructor() {
    super("The original Webhook operation is being checked. Wait for it to finish before submitting another change.");
    this.name = "WebhookIntentBusy";
  }
}
const prefix = "daynight.webhook.pending:";
const kindChoices: readonly WebhookOperationKind[] = ["endpoint.create", "endpoint.patch", "endpoint.delete", "signing-secret.rotate", "delivery.redeliver"];
const invalid = (): never => { throw new ApiError("protocol"); };
const uuid = (value: unknown): string => typeof value === "string" && canonicalId(value) === value && value !== "00000000-0000-0000-0000-000000000000" ? value : invalid();
const origin = (value: unknown): string => {
  if (typeof value !== "string") return invalid();
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value) return invalid();
  return value;
};
const nullableVersion = (value: unknown): string | null => value === null ? null : webhookVersion(value);
const key = (serviceOrigin: string, actorUserId: string, owner: WebhookOwner): string => `${prefix}${encodeURIComponent(serviceOrigin)}:${actorUserId}:${owner.kind}:${owner.id}`;
const metadataFields = ["serviceOrigin", "actorUserId", "owner", "operationId", "issuedAt", "requestSha256", "kind", "endpointId", "deliveryId", "ifVersion", "ifGeneration", "destinationRevision"] as const;

export const parseWebhookPreparedMetadata = (value: unknown): WebhookPreparedMetadata => {
  const data = record(value);
  if (metadataFields.some(field => !Object.hasOwn(data, field)) || Object.keys(data).some(field => !metadataFields.includes(field as typeof metadataFields[number]))) return invalid();
  const kind = data.kind;
  if (typeof kind !== "string" || !kindChoices.includes(kind as WebhookOperationKind) || typeof data.issuedAt !== "string" || !isWebhookIssuedAt(data.issuedAt) || typeof data.requestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.requestSha256)) return invalid();
  const actorUserId = uuid(data.actorUserId), owner = parseWebhookOwner(data.owner);
  const endpointId = data.endpointId === null ? null : uuid(data.endpointId), deliveryId = data.deliveryId === null ? null : uuid(data.deliveryId);
  const ifVersion = nullableVersion(data.ifVersion), ifGeneration = nullableVersion(data.ifGeneration), destinationRevision = nullableVersion(data.destinationRevision);
  if (owner.kind === "personal" && owner.id !== actorUserId || (kind === "endpoint.create") !== (endpointId === null) || (kind === "endpoint.create") !== (ifVersion === null) || (kind === "delivery.redeliver") !== (deliveryId !== null && ifGeneration !== null) || kind !== "delivery.redeliver" && (deliveryId !== null || ifGeneration !== null)) return invalid();
  return { serviceOrigin: origin(data.serviceOrigin), actorUserId, owner, operationId: uuid(data.operationId), issuedAt: data.issuedAt, requestSha256: data.requestSha256, kind: kind as WebhookOperationKind, endpointId, deliveryId, ifVersion, ifGeneration, destinationRevision };
};

export const assertWebhookReceiptMatches = (receipt: WebhookReceipt, prepared: WebhookPreparedMetadata): void => {
  if (receipt.operationId !== prepared.operationId || receipt.issuedAt !== prepared.issuedAt || receipt.requestSha256 !== prepared.requestSha256 || receipt.actorUserId !== prepared.actorUserId || receipt.owner.kind !== prepared.owner.kind || receipt.owner.id !== prepared.owner.id || receipt.kind !== prepared.kind || prepared.endpointId !== null && receipt.endpointId !== prepared.endpointId || receipt.deliveryId !== prepared.deliveryId) return invalid();
  if (prepared.kind !== "endpoint.patch" && receipt.effect !== "applied") return invalid();
  if (prepared.ifVersion === null) {
    if (receipt.configVersionAfter !== "1" || receipt.destinationRevisionAfter !== "1") return invalid();
  } else {
    const before = BigInt(prepared.ifVersion), after = BigInt(receipt.configVersionAfter);
    if (after !== before + (prepared.kind === "delivery.redeliver" || receipt.effect === "unchanged" ? 0n : 1n)) return invalid();
  }
  if (prepared.ifGeneration !== null && (receipt.generationAfter === null || BigInt(receipt.generationAfter) !== BigInt(prepared.ifGeneration) + 1n)) return invalid();
  if (prepared.destinationRevision !== null) {
    const before = BigInt(prepared.destinationRevision), after = BigInt(receipt.destinationRevisionAfter);
    if (after !== before && (prepared.kind !== "endpoint.patch" || receipt.effect !== "applied" || after !== before + 1n)) return invalid();
  }
};

const assertReceiptUnchanged = (receipt: WebhookReceipt, confirmed: WebhookReceipt): void => {
  const { owner, ...facts } = receipt, { owner: confirmedOwner, ...confirmedFacts } = confirmed;
  if (owner.kind !== confirmedOwner.kind || owner.id !== confirmedOwner.id || Object.keys(facts).some(field => facts[field as keyof typeof facts] !== confirmedFacts[field as keyof typeof confirmedFacts])) return invalid();
};

const inputBody = (input: WebhookIntentInput): Record<string, unknown> => {
  if (!kindChoices.includes(input.kind)) return invalid();
  const body = record(input.body);
  const create = input.kind === "endpoint.create", rotate = input.kind === "signing-secret.rotate", remove = input.kind === "endpoint.delete" || input.kind === "delivery.redeliver";
  const allowed = rotate ? ["mode"] : remove ? [] : ["name", "enabled", "destination", "subscriptions", ...(create ? [] : ["confirmProjectIds"])];
  if (Object.keys(body).some(field => !allowed.includes(field)) || create && ["name", "enabled", "destination", "subscriptions"].some(field => !Object.hasOwn(body, field)) || input.kind === "endpoint.patch" && Object.keys(body).length === 0) return invalid();
  if (rotate && body.mode !== "overlap" && body.mode !== "immediate") return invalid();
  if (Object.hasOwn(body, "name") && (typeof body.name !== "string" || !body.name.isWellFormed())) return invalid();
  if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") return invalid();
  if (Object.hasOwn(body, "destination")) {
    const destination = record(body.destination), configuration = record(destination.configuration);
    if (Object.keys(destination).length !== 3 || !Object.hasOwn(destination, "kind") || !Object.hasOwn(destination, "adapterVersion") || Object.keys(configuration).length !== 1 || typeof configuration.url !== "string" || !configuration.url.isWellFormed()) return invalid();
    if (typeof destination.kind !== "string" || typeof destination.adapterVersion !== "string") return invalid();
  }
  if (Object.hasOwn(body, "subscriptions")) {
    if (!Array.isArray(body.subscriptions)) return invalid();
    const ids = new Set<string>();
    for (const item of body.subscriptions) {
      const subscription = record(item);
      if (Object.keys(subscription).length !== 3 || !Object.hasOwn(subscription, "id") || !Object.hasOwn(subscription, "projectId") || !Object.hasOwn(subscription, "eventTypes")) return invalid();
      if (subscription.id !== null) { const id = uuid(subscription.id); if (ids.has(id)) return invalid(); ids.add(id); }
      uuid(subscription.projectId);
      if (!Array.isArray(subscription.eventTypes) || subscription.eventTypes.length === 0 || new Set(subscription.eventTypes).size !== subscription.eventTypes.length) return invalid();
      subscription.eventTypes.forEach(parseWebhookEventType);
    }
  }
  if (Object.hasOwn(body, "confirmProjectIds")) {
    if (!Array.isArray(body.confirmProjectIds) || new Set(body.confirmProjectIds).size !== body.confirmProjectIds.length) return invalid();
    body.confirmProjectIds.forEach(uuid);
  }
  // Clone before the asynchronous digest so a live form cannot replace the
  // submitted values while preparation is in progress.
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
};

export class WebhookIntentController {
  readonly #options: Options;
  readonly #storage: Storage | null;
  readonly #key: string;
  readonly #lifetime = new AbortController();
  readonly #listeners = new Set<() => void>();
  #state: WebhookIntentState = { phase: "idle", prepared: null, result: null, error: null, reconciling: false, persistenceError: null };
  #pending: Promise<WebhookIntentState> | null = null;
  #pendingKind: "write" | "reconcile" | null = null;
  #body: string | null = null;
  #disposed = false;

  constructor(options: Options) {
    const serviceOrigin = origin(options.serviceOrigin), actorUserId = uuid(options.admission.userId), owner = parseWebhookOwner(options.owner);
    if (owner.kind === "personal" && owner.id !== actorUserId) invalid();
    this.#options = { ...options, serviceOrigin, owner: Object.freeze({ ...owner }), admission: { ...options.admission, userId: actorUserId } };
    this.#key = key(serviceOrigin, actorUserId, owner);
    let storage: Storage | null = null;
    try { storage = options.storage ?? sessionStorage; }
    catch (persistenceError) { this.#state = { ...this.#state, persistenceError }; }
    this.#storage = storage;
    if (storage !== null) {
      try {
        const saved = storage.getItem(this.#key);
        if (saved !== null) {
          const prepared = parseWebhookPreparedMetadata(decodeWebhookJson(saved));
          if (prepared.serviceOrigin !== serviceOrigin || prepared.actorUserId !== actorUserId || prepared.owner.kind !== owner.kind || prepared.owner.id !== owner.id) invalid();
          this.#state = { ...this.#state, phase: "unknown", prepared };
        }
      } catch (persistenceError) { this.#state = { ...this.#state, persistenceError }; }
    }
  }

  getSnapshot = (): WebhookIntentState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #publish(state: WebhookIntentState): WebhookIntentState {
    this.#state = state;
    if (!this.#disposed && !this.#options.signal.aborted) for (const listener of this.#listeners) listener();
    return state;
  }
  #persist(prepared: WebhookPreparedMetadata | null): void {
    if (this.#storage === null) return;
    try {
      if (prepared === null) {
        const operationId = this.#state.prepared?.operationId, current = this.#storage.getItem(this.#key);
        if (operationId !== undefined && current !== null && parseWebhookPreparedMetadata(decodeWebhookJson(current)).operationId === operationId) this.#storage.removeItem(this.#key);
      } else this.#storage.setItem(this.#key, JSON.stringify(prepared));
    }
    catch (persistenceError) { this.#publish({ ...this.#state, persistenceError }); }
  }
  #signal = (): AbortSignal => AbortSignal.any([this.#options.signal, this.#lifetime.signal]);

  submit = (input: WebhookIntentInput): Promise<WebhookIntentState> => {
    if (this.#pending !== null) {
      if (this.#pendingKind === "reconcile") throw new WebhookIntentBusy();
      return this.#pending;
    }
    if (this.#state.phase === "unknown") return Promise.resolve(this.#state);
    if (this.#options.canSubmit !== undefined && !this.#options.canSubmit(input.kind)) throw new ApiError("server", 503, "webhooks_unavailable");
    const signal = this.#signal();
    signal.throwIfAborted();
    const body = inputBody(input), create = input.kind === "endpoint.create", redeliver = input.kind === "delivery.redeliver";
    const endpointId = create ? null : uuid(input.endpointId), ifVersion = create ? null : webhookVersion(input.ifVersion);
    if (create && (input.endpointId !== undefined || input.ifVersion !== undefined)) return invalid();
    const deliveryId = redeliver ? uuid(input.deliveryId) : null, ifGeneration = redeliver ? webhookVersion(input.ifGeneration) : null;
    if (!redeliver && (Object.hasOwn(input, "deliveryId") || Object.hasOwn(input, "ifGeneration"))) return invalid();
    const destinationRevision = redeliver ? webhookVersion(input.destinationRevision) : input.destinationRevision === undefined ? null : webhookVersion(input.destinationRevision);
    const operationId = uuid(crypto.randomUUID()), issuedAt = new Date().toISOString();
    const serializedBody = JSON.stringify({ operationId, issuedAt, expectedUserId: this.#options.admission.userId, ...(ifVersion === null ? {} : { ifVersion }), ...(ifGeneration === null ? {} : { ifGeneration }), ...body });
    const bytes = new TextEncoder().encode(serializedBody);
    if (bytes.length > 262_144) return invalid();
    this.#body = serializedBody;
    const pending = Promise.resolve().then(() => this.#prepareAndSubmit(input.kind, endpointId, deliveryId, ifVersion, ifGeneration, destinationRevision, operationId, issuedAt, bytes, signal));
    this.#pending = pending;
    this.#pendingKind = "write";
    this.#publish({ ...this.#state, phase: "preparing", prepared: null, result: null, error: null, reconciling: false });
    void pending.then(() => { if (this.#pending === pending) { this.#pending = null; this.#pendingKind = null; } });
    return pending;
  };

  async #prepareAndSubmit(kind: WebhookIntentInput["kind"], endpointId: string | null, deliveryId: string | null, ifVersion: string | null, ifGeneration: string | null, destinationRevision: string | null, operationId: string, issuedAt: string, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<WebhookIntentState> {
    let dispatched = false;
    try {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      signal.throwIfAborted();
      const prepared: WebhookPreparedMetadata = { serviceOrigin: this.#options.serviceOrigin, actorUserId: this.#options.admission.userId, owner: this.#options.owner, operationId, issuedAt, requestSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""), kind, endpointId, deliveryId, ifVersion, ifGeneration, destinationRevision };
      this.#publish({ ...this.#state, phase: "submitting", prepared });
      this.#persist(prepared);
      const admission: WebhookAdmission = { ...this.#options.admission, ready: async requestSignal => {
        await this.#options.admission.ready?.(requestSignal);
        requestSignal.throwIfAborted();
        if (this.#options.canSubmit !== undefined && !this.#options.canSubmit(kind)) throw new ApiError("server", 503, "webhooks_unavailable");
      } };
      const body = this.#body;
      if (body === null) throw new DOMException("The pending request body was cleared.", "AbortError");
      const result = await submitWebhookMutation(prepared.owner, kind, endpointId, operationId, body, signal, admission, receipt => {
        assertWebhookReceiptMatches(receipt, prepared);
        this.#publish({ ...this.#state, phase: "confirmed", result: { operation: receipt }, error: null });
        this.#persist(null);
      }, () => {
        if (this.#body === null) throw new DOMException("The pending request body was cleared.", "AbortError");
        if (this.#options.canSubmit !== undefined && !this.#options.canSubmit(kind)) throw new ApiError("server", 503, "webhooks_unavailable");
        dispatched = true;
      }, deliveryId);
      this.#body = null;
      return this.#publish({ ...this.#state, phase: "confirmed", result, error: result.currentError ?? null });
    } catch (error) {
      if (this.#state.phase === "confirmed") return this.#publish({ ...this.#state, error });
      const definite = !dispatched || error instanceof ApiError && error.kind === "server" && error.status !== null && error.status < 500;
      if (definite) { this.#body = null; this.#persist(null); }
      this.#publish({ ...this.#state, phase: definite ? "rejected" : "unknown", error });
      if (!definite && !signal.aborted) return this.#observe(signal);
      return this.#state;
    }
  }

  reconcile = (): Promise<WebhookIntentState> => {
    if (this.#pending !== null) return this.#pending;
    const prepared = this.#state.prepared;
    if (prepared === null || this.#state.phase !== "unknown" && this.#state.phase !== "confirmed") return Promise.resolve(this.#state);
    const signal = this.#signal();
    signal.throwIfAborted();
    const pending = Promise.resolve().then(() => this.#observe(signal));
    this.#pending = pending;
    this.#pendingKind = "reconcile";
    void pending.then(() => { if (this.#pending === pending) { this.#pending = null; this.#pendingKind = null; } });
    return pending;
  };

  #observe(signal: AbortSignal): Promise<WebhookIntentState> {
    const prepared = this.#state.prepared!;
    this.#pendingKind = "reconcile";
    this.#publish({ ...this.#state, reconciling: true });
    return getWebhookOperation(prepared.owner, prepared.operationId, signal, this.#options.admission).then(receipt => {
      assertWebhookReceiptMatches(receipt, prepared);
      const confirmed = this.#state.phase === "confirmed" ? this.#state.result : null;
      if (confirmed !== null) assertReceiptUnchanged(receipt, confirmed.operation);
      this.#body = null;
      this.#persist(null);
      return this.#publish({ ...this.#state, phase: "confirmed", result: confirmed ?? { operation: receipt }, error: null, reconciling: false });
    }).catch(error => this.#publish({ ...this.#state, error, reconciling: false }));
  }

  forgetCurrentProjection = (): void => {
    this.#body = null;
    const result = this.#state.result;
    if (result?.endpoint === undefined && result?.delivery === undefined) return;
    const { endpoint: _endpoint, delivery: _delivery, ...retained } = result!;
    this.#publish({ ...this.#state, result: retained });
  };

  dispose = (): void => {
    this.#disposed = true;
    this.#lifetime.abort();
    this.#listeners.clear();
    this.#body = null;
    this.#state = { ...this.#state, result: this.#state.result === null ? null : { operation: this.#state.result.operation }, error: null };
  };
}

export const clearWebhookPending = (serviceOrigin: string, userId: string, storage?: Storage): Error | null => {
  try {
    const accountPrefix = `${prefix}${encodeURIComponent(origin(serviceOrigin))}:${uuid(userId)}:`;
    const target = storage ?? sessionStorage;
    const keys: string[] = [];
    for (let index = 0; index < target.length; index++) { const value = target.key(index); if (value?.startsWith(accountPrefix)) keys.push(value); }
    keys.forEach(value => target.removeItem(value));
    return null;
  } catch (cause) {
    return cause instanceof Error || cause instanceof DOMException ? cause : new Error("Could not clear the account's pending Webhook records.", { cause });
  }
};
