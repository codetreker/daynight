import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { classifyFailure } from "./diagnostics.js";
import type { Activity, ActivityPhase, AdmissionReason, Coverage, DeliveryPhase, Failure, FailureComponent, Observation, Reservation, ReservationRole, RetryState, SchedulerPhase, Scope, WaitReason } from "./types.js";

type Identity = { projectId: string; taskId: string; claimId: string };
type ReservationInput = { identity: Identity; roles: readonly ReservationRole[]; occupied?: boolean; observedAt?: string };
type ActivityInput = ActivityPhase & { scope: Scope; status?: Activity["status"]; deadlineAt?: string | null; waitReason?: WaitReason | null; nextAttemptAt?: string | null };
type ActivityPatch = { phase?: Activity["phase"]; status?: Activity["status"]; deadlineAt?: string | null; waitReason?: WaitReason | null; nextAttemptAt?: string | null; progress?: boolean };
type FailureInput = { operationId: string; component: FailureComponent; phase: string; scope: Scope; error: unknown; retryState?: RetryState; nextAttemptAt?: string | null; outcomeUnconfirmed?: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identityKey = (id: Identity): string => `${id.projectId}/${id.taskId}/${id.claimId}`;
const validIdentity = (id: Identity): boolean => uuid.test(id.projectId) && uuid.test(id.taskId) && uuid.test(id.claimId);
const copyScope = (scope: Scope): Scope => scope.kind === "worker" ? { kind: "worker" } : scope.kind === "project" ? { kind: "project", projectId: scope.projectId } : { kind: "claim", projectId: scope.projectId, taskId: scope.taskId, claimId: scope.claimId };
const validScope = (scope: Scope): boolean => scope.kind === "worker" || scope.kind === "project" ? scope.kind === "worker" || uuid.test(scope.projectId) : validIdentity(scope);
const date = (ms: number): string => new Date(ms).toISOString();
const roles: readonly ReservationRole[] = ["active-task", "resource-owner", "unresolved", "cleanup", "pending-stop"];

/** Size of Go's encoding/json output, including its HTML-safe escapes and final newline. */
export const goJsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n", "utf8");

export const createMonitoringObserver = (options: { runId?: string; now?: () => number; monotonic?: () => number; onDirty?: () => void; reservationKey?: Uint8Array; reservationDigest?: (identity: Identity) => Uint8Array } = {}) => {
  const runId = options.runId ?? randomUUID();
  if (!uuid.test(runId)) throw new Error("Monitoring runId must be a canonical UUID.");
  const key = options.reservationKey ?? randomBytes(32);
  if (key.length !== 32) throw new Error("Monitoring reservation key must contain 32 bytes.");
  const now = options.now ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
  const time = (): string => date(now());
  const dirty = (): void => { try { options.onDirty?.(); } catch { /* Monitoring callbacks cannot break execution. */ } };
  let lifecycle: Observation["lifecycle"] = "starting";
  let scheduler: Observation["scheduler"] = { phase: "initializing", coverage: "unknown", cycleId: null, lastCompletedAt: null, lastSuccessfulAt: null, lastOutcome: null, nextPollAt: null };
  let capacity: Observation["capacity"] = null;
  let admission: Observation["admission"] = { observedAt: time(), coverage: "unknown", reasons: [] };
  const projectPreparationReasons = new Map<string, { observedAt: string; nextAttemptAt: string | null }>();
  const nativeConfigurationReasons = new Map<string, { scope: Extract<Scope, { kind: "worker" | "project" }>; observedAt: string; nextAttemptAt: string | null }>();
  let projectPreparationUnknown = false;
  let projectPreparationIncomplete = false;
  let reservations: Reservation[] = [];
  let reservationPartial = false, detailsPartial = false;
  const activities = new Map<string, { value: Activity; monotonicStart: number }>();
  const failures = new Map<string, Failure>();
  let lastRecovery: Observation["lastRecovery"] = null;
  let delivery: Observation["delivery"] = { lastSucceededAt: null, lastFailure: null };
  const preparationIncomplete = (): boolean => projectPreparationUnknown || projectPreparationIncomplete || projectPreparationReasons.size > 0 || nativeConfigurationReasons.size > 0 || [...activities.values()].some(({ value }) => value.kind === "maintenance" && (value.phase === "project-preparation" || value.phase === "configuration"));
  const invalidateAdmission = (): void => { admission = { observedAt: time(), coverage: "unknown", reasons: [] }; scheduler = { ...scheduler, coverage: "partial" }; dirty(); };
  const reservationId = (id: Identity): string => {
    const digest = options.reservationDigest?.(id) ?? createHmac("sha256", key).update("daynight-worker-monitoring-reservation-v1\0", "utf8").update(id.projectId + id.taskId + id.claimId, "ascii").digest();
    if (digest.length < 16) throw new Error("Monitoring reservation digest is too short.");
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const value = bytes.toString("hex");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  };
  const snapshot = (sequence: string): Observation => {
    const activityItems = [...activities.values()].map(({ value, monotonicStart }) => ({ ...value, scope: copyScope(value.scope), elapsedMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(monotonic() - monotonicStart))) }));
    activityItems.sort((a, b) => Number(b.status !== "running") - Number(a.status !== "running") || a.startedAt.localeCompare(b.startedAt) || a.operationId.localeCompare(b.operationId));
    const failureItems = [...failures.values()].map(value => ({ ...value, scope: copyScope(value.scope), error: { ...value.error } })).sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.operationId.localeCompare(b.operationId));
    const reservationItems = reservations.map(value => ({ ...value, scope: copyScope(value.scope), roles: [...value.roles] })).sort((a, b) => Number(b.roles.includes("cleanup") || b.roles.includes("unresolved") || b.roles.includes("pending-stop")) - Number(a.roles.includes("cleanup") || a.roles.includes("unresolved") || a.roles.includes("pending-stop")) || a.observedAt.localeCompare(b.observedAt) || a.reservationId.localeCompare(b.reservationId));
    const preparationReasons: AdmissionReason[] = [...projectPreparationReasons].map(([projectId, reason]) => ({ code: "project-preparation-failed", scope: { kind: "project", projectId }, ...reason }));
    const nativeReasons: AdmissionReason[] = [...nativeConfigurationReasons.values()].map(reason => ({ code: "configuration-incomplete", ...reason, scope: copyScope(reason.scope) }));
    const admissionCoverage: Coverage = preparationIncomplete() ? "partial" : admission.coverage;
    let selectedReasons = [...admission.reasons.filter(reason => reason.code !== "configuration-incomplete" || !nativeConfigurationReasons.has(reason.scope.kind === "worker" ? "native" : reason.scope.kind === "project" ? `project/${reason.scope.projectId}` : "")), ...preparationReasons, ...nativeReasons].sort((a, b) => Number(b.code === "cleanup-capacity-blocked") - Number(a.code === "cleanup-capacity-blocked") || a.observedAt.localeCompare(b.observedAt) || a.code.localeCompare(b.code));
    const reasonsTruncated = selectedReasons.length > 16;
    if (admissionCoverage !== "complete" || reasonsTruncated) selectedReasons = selectedReasons.filter(reason => reason.code !== "no-ready-tasks" && reason.code !== "no-projects-selected");
    const result: Observation = {
      runId, sequence, capturedAt: time(), lifecycle, scheduler: { ...scheduler, coverage: preparationIncomplete() ? "partial" : scheduler.coverage }, capacity: capacity === null ? null : { ...capacity, detailCoverage: reservationPartial || reservationItems.length > 128 ? "partial" : "complete" },
      admission: { ...admission, coverage: reasonsTruncated && admissionCoverage !== "unknown" ? "partial" : admissionCoverage, reasons: selectedReasons.slice(0, 16).map(item => ({ ...item, scope: copyScope(item.scope) })) },
      reservations: reservationItems.slice(0, 128), activities: activityItems.slice(0, 128), currentFailures: failureItems.slice(0, 32), lastRecovery: lastRecovery === null ? null : { ...lastRecovery, scope: copyScope(lastRecovery.scope) },
      detailCoverage: detailsPartial || reservationPartial || reservationItems.length > 128 || activityItems.length > 128 || failureItems.length > 32 ? "partial" : "complete", delivery: { ...delivery, lastFailure: delivery.lastFailure === null ? null : { ...delivery.lastFailure, error: { ...delivery.lastFailure.error } } },
    };
    // Account for both the PUT envelope and Go's normalized body; never infer total capacity from details.
    const payload = { expectedRevision: "00000000-0000-4000-8000-000000000000", observation: result };
    while (goJsonBytes(payload) > 256 * 1024 || goJsonBytes(result) > 256 * 1024) {
      if (result.activities.length) { result.activities = result.activities.slice(0, -1); result.detailCoverage = "partial"; }
      else if (result.reservations.length) { result.reservations = result.reservations.slice(0, -1); result.detailCoverage = "partial"; if (result.capacity) result.capacity.detailCoverage = "partial"; }
      else if (result.currentFailures.length) { result.currentFailures = result.currentFailures.slice(0, -1); result.detailCoverage = "partial"; }
      else if (result.admission.reasons.length) { result.admission.reasons = result.admission.reasons.slice(0, -1).filter(reason => reason.code !== "no-ready-tasks" && reason.code !== "no-projects-selected"); result.admission.coverage = "partial"; }
      else throw new Error("Monitoring observation exceeds its encoding budget.");
    }
    return result;
  };
  return {
    runId,
    setLifecycle(value: Observation["lifecycle"]): void { lifecycle = value; dirty(); },
    startCycle(phase: SchedulerPhase): string { const cycleId = randomUUID(); scheduler = { ...scheduler, phase, cycleId, coverage: "unknown" }; dirty(); return cycleId; },
    setPhase(phase: SchedulerPhase, coverage?: Coverage): void { scheduler = { ...scheduler, phase, ...(coverage === undefined ? {} : { coverage }) }; dirty(); },
    endCycle(outcome: "completed" | "failed" | "cancelled", coverage: Coverage = outcome === "completed" ? "complete" : "partial"): void { const at = time(); scheduler = { ...scheduler, lastCompletedAt: at, lastOutcome: outcome, coverage: preparationIncomplete() ? "partial" : coverage }; dirty(); },
    markCycleSuccessful(): void { if (!preparationIncomplete()) { scheduler = { ...scheduler, lastSuccessfulAt: time() }; dirty(); } },
    setNextPoll(at: string | null): void { scheduler = { ...scheduler, nextPollAt: at }; dirty(); },
    setCapacity(input: { limit: number; occupied: number; reservations: readonly ReservationInput[]; partial?: boolean; observedAt?: string }): void {
      const at = input.observedAt ?? time();
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64 || !Number.isSafeInteger(input.occupied) || input.occupied < 0) throw new Error("Invalid monitoring capacity.");
      const unique = new Map<string, ReservationInput>();
      let partial = input.partial === true;
      for (const item of input.reservations) {
        if (!validIdentity(item.identity)) { partial = true; continue; }
        const id = identityKey(item.identity), previous = unique.get(id);
        unique.set(id, { identity: { ...item.identity }, roles: roles.filter(role => item.roles.includes(role) || previous?.roles.includes(role)), occupied: item.occupied !== false || previous?.occupied === true, observedAt: previous?.observedAt ?? item.observedAt ?? at });
      }
      const hashes = new Map<string, string[]>();
      for (const [id, item] of unique) { const rid = reservationId(item.identity); hashes.set(rid, [...hashes.get(rid) ?? [], id]); }
      reservations = [];
      for (const [rid, identities] of hashes) {
        if (identities.length !== 1) { partial = true; continue; }
        const item = unique.get(identities[0]!)!;
        if (!item.roles.length) { partial = true; continue; }
        reservations.push({ reservationId: rid, scope: { kind: "claim", ...item.identity }, roles: item.roles, occupied: item.occupied !== false, observedAt: item.observedAt ?? at });
      }
      if (unique.size < input.occupied) partial = true;
      reservationPartial = partial;
      capacity = { observedAt: at, quality: "current", limit: input.limit, occupied: input.occupied, available: Math.max(0, input.limit - input.occupied), detailCoverage: partial ? "partial" : "complete" }; dirty();
    },
    staleCapacity(): void { if (capacity !== null) { capacity = { ...capacity, quality: "stale" }; dirty(); } },
    setAdmission(coverage: Coverage, reasons: readonly AdmissionReason[]): void {
      let partial = false;
      const observedAt = time();
      let globalCleanup = false;
      const accepted = reasons.filter(reason => { const duplicate = reason.code === "cleanup-capacity-blocked" && globalCleanup; if (reason.code === "cleanup-capacity-blocked") globalCleanup = true; const valid = !duplicate && validScope(reason.scope) && (!(reason.code === "project-unavailable" || reason.code === "project-preparation-failed") || reason.scope.kind !== "worker") && (reason.code !== "cleanup-capacity-blocked" || reason.scope.kind === "worker"); if (!valid) partial = true; return valid; }).map(reason => ({ code: reason.code, scope: copyScope(reason.scope), observedAt: reason.code === "cleanup-capacity-blocked" ? observedAt : reason.observedAt, nextAttemptAt: reason.code === "cleanup-capacity-blocked" ? null : reason.nextAttemptAt }));
      const effectiveCoverage = (partial || preparationIncomplete()) && coverage !== "unknown" ? "partial" : coverage;
      admission = { observedAt, coverage: effectiveCoverage, reasons: effectiveCoverage === "complete" ? accepted : accepted.filter(reason => reason.code !== "no-ready-tasks" && reason.code !== "no-projects-selected") }; dirty();
    },
    setProjectPreparationReason(projectId: string, reason: { observedAt: string; nextAttemptAt: string | null } | null): void {
      if (!uuid.test(projectId)) { detailsPartial = true; dirty(); return; }
      if (reason === null) { if (projectPreparationReasons.delete(projectId)) dirty(); return; }
      const previous = projectPreparationReasons.get(projectId);
      if (previous?.observedAt === reason.observedAt && previous.nextAttemptAt === reason.nextAttemptAt) return;
      if (previous === undefined) invalidateAdmission();
      projectPreparationReasons.set(projectId, { ...reason }); dirty();
    },
    setProjectPreparationUnknown(value: boolean): void { if (projectPreparationUnknown !== value) { if (value) invalidateAdmission(); projectPreparationUnknown = value; dirty(); } },
    setProjectPreparationIncomplete(value: boolean): void { if (projectPreparationIncomplete !== value) { if (value) invalidateAdmission(); projectPreparationIncomplete = value; dirty(); } },
    setNativeConfigurationReason(scope: Extract<Scope, { kind: "worker" | "project" }>, reason: { observedAt: string; nextAttemptAt: string | null } | null): void {
      if (!validScope(scope)) { detailsPartial = true; dirty(); return; }
      const key = scope.kind === "worker" ? "native" : `project/${scope.projectId}`;
      if (reason === null) { if (nativeConfigurationReasons.delete(key)) dirty(); return; }
      const previous = nativeConfigurationReasons.get(key);
      if (previous?.observedAt === reason.observedAt && previous.nextAttemptAt === reason.nextAttemptAt) return;
      if (previous === undefined) invalidateAdmission();
      nativeConfigurationReasons.set(key, { scope: copyScope(scope) as Extract<Scope, { kind: "worker" | "project" }>, ...reason }); dirty();
    },
    invalidateAdmission,
    startActivity(input: ActivityInput): string {
      const operationId = randomUUID();
      if (!validScope(input.scope)) { detailsPartial = true; dirty(); return operationId; }
      if (input.kind === "maintenance" && (input.phase === "project-preparation" || input.phase === "configuration")) invalidateAdmission();
      const at = time(), value = { kind: input.kind, phase: input.phase, operationId, scope: copyScope(input.scope), status: input.status ?? "running", startedAt: at, lastProgressAt: null, elapsedMs: 0, deadlineAt: input.deadlineAt ?? null, waitReason: input.waitReason ?? null, nextAttemptAt: input.nextAttemptAt ?? null } as Activity;
      activities.set(operationId, { value, monotonicStart: monotonic() }); dirty(); return operationId;
    },
    updateActivity(id: string, patch: ActivityPatch): void { const entry = activities.get(id); if (!entry) return; entry.value = { ...entry.value, ...(patch.phase === undefined ? {} : { phase: patch.phase }), ...(patch.status === undefined ? {} : { status: patch.status }), ...(patch.deadlineAt === undefined ? {} : { deadlineAt: patch.deadlineAt }), ...(patch.waitReason === undefined ? {} : { waitReason: patch.waitReason }), ...(patch.nextAttemptAt === undefined ? {} : { nextAttemptAt: patch.nextAttemptAt }), ...(patch.progress ? { lastProgressAt: time() } : {}) } as Activity; dirty(); },
    endActivity(id: string): void { if (activities.delete(id)) dirty(); },
    clearActivities(): void { if (activities.size > 0) { activities.clear(); dirty(); } },
    fail(input: FailureInput): void {
      if (!validScope(input.scope) || input.component === "project" && input.scope.kind === "worker" || !uuid.test(input.operationId)) { detailsPartial = true; dirty(); return; }
      const at = time(), previous = failures.get(input.operationId), retryState = input.retryState ?? "none";
      if (retryState === "scheduled" && !input.nextAttemptAt) throw new Error("A scheduled retry requires its next attempt time.");
      failures.set(input.operationId, { operationId: input.operationId, component: input.component, phase: input.phase, scope: copyScope(input.scope), error: classifyFailure(input.error, input.outcomeUnconfirmed), firstObservedAt: previous?.firstObservedAt ?? at, lastObservedAt: at, occurrencesInRun: Math.min(Number.MAX_SAFE_INTEGER, (previous?.occurrencesInRun ?? 0) + 1), retryState, nextAttemptAt: retryState === "scheduled" ? input.nextAttemptAt! : null }); dirty();
    },
    updateFailureRetry(id: string, retryState: RetryState, nextAttemptAt: string | null = null): void {
      const failure = failures.get(id);
      if (failure === undefined) return;
      if ((retryState === "scheduled") !== (nextAttemptAt !== null)) throw new Error("A scheduled retry requires its next attempt time.");
      if (failure.retryState === retryState && failure.nextAttemptAt === nextAttemptAt) return;
      failures.set(id, { ...failure, retryState, nextAttemptAt }); dirty();
    },
    discardFailure(id: string): void { if (failures.delete(id)) dirty(); },
    recover(id: string): void { const failure = failures.get(id); if (!failure) return; failures.delete(id); lastRecovery = { operationId: id, component: failure.component, scope: copyScope(failure.scope), observedAt: time(), explanation: "The operation recovered.", explanationTruncated: false }; dirty(); },
    capture: snapshot,
    deliverySuccess(): void { delivery = { ...delivery, lastSucceededAt: time() }; },
    deliveryFailure(phase: DeliveryPhase, error: unknown, requestId: string | null): void { delivery = { ...delivery, lastFailure: { observedAt: time(), phase, error: classifyFailure(error), requestId: requestId !== null && uuid.test(requestId) ? requestId : null } }; },
  };
};
