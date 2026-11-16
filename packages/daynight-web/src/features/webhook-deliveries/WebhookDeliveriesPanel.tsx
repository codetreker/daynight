import { NativeSelect } from "../../ui/native-select/NativeSelect";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, authRequestsPaused, authRequestsPauseRevision, subscribeAuthPause, waitForAuthRequests } from "../../api/client";
import { getWebhookDelivery, getWebhookPayload, isWebhookIssuedAt, listWebhookAttempts, listWebhookDeliveries, type WebhookEndpoint, type WebhookAttempt, type WebhookAttemptQuery, type WebhookCatalog, type WebhookDelivery, type WebhookDeliveryQuery, type WebhookOwner, type WebhookPayload } from "../../api/webhooks";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import type { WebhookIntentController, WebhookIntentInput, WebhookIntentState, WebhookIntentTarget } from "../webhook-intents/controller";
import { WebhookDialog } from "../webhooks/WebhookDialog";
import { WebhookError } from "../webhooks/WebhookError";
import { WebhookIcon } from "../webhooks/WebhookIcon";
import { WebhookPendingNotice } from "../webhooks/WebhookPendingNotice";
import { useWebhookDeliveryMessages, type WebhookDeliveryMessages } from "./messages";
import { WebhookDeliveryObservations, webhookDeliveryRestricted, redactWebhookDelivery as redacted } from "./observations";
import { useScopedState } from "./useScopedState";
import { useWebhookHistory, webhookHistoryDenied, webhookHistoryMissing } from "./useWebhookHistory";

const resultText = (value: WebhookDelivery["lastResult"], m: WebhookDeliveryMessages): string => value === null ? m.notObserved : `${m[value.category]}${value.httpStatus === null ? "" : ` · HTTP ${value.httpStatus}`}${value.durationMs === null ? "" : ` · ${value.durationMs} ms`}${value.code === null ? "" : ` · ${value.code}`}`;
const stateText = (value: WebhookDelivery, m: WebhookDeliveryMessages): string => value.state === "pending" && value.attemptCount > 0 ? m.retrying : m[value.state];
const stateClass = (value: WebhookDelivery): string => value.state === "delivered" ? "success" : value.state === "pending" || value.state === "leased" ? "retrying" : value.state;
// Target visibility follows management rights; payload visibility follows resource access.
const samePayloadResource = (value: WebhookDelivery): string => JSON.stringify([value.id, value.eventId, value.disclosure, value.resource.projectId, value.resource.taskId, value.resource.stepId, value.resource.messageId, value.payloadAvailable, value.payloadExpiresAt]);
const utc = (value: string): boolean => value.endsWith("Z") && isWebhookIssuedAt(value);
const timeOrder = (value: string): string => `${value.slice(0, 19)}${(value.match(/\.(\d+)Z$/)?.[1] ?? "").slice(0, 9).padEnd(9, "0")}`;
export type WebhookHistoryEndpoint = WebhookEndpoint | { readonly kind: "retained-history" | "checking-configuration"; readonly id: string };
const initialFilters = { eventType: "", state: "", projectId: "", from: "", to: "", limit: "50" };

export const WebhookDeliveriesPanel = ({ owner, endpoint, admission, active, visible, authorizationKey, catalog, controller, intent, submit, onOwnerDenied, onRefreshEndpoint, routeDeliveryId, onSelectDelivery, manageOwner, onManagementRestricted = () => {}, registerAdmission = () => () => {}, onCheckOperation }: {
  readonly owner: WebhookOwner; readonly endpoint: WebhookHistoryEndpoint; readonly admission: TaskCacheScope; readonly active: boolean; readonly visible: boolean; readonly authorizationKey: string; readonly catalog: WebhookCatalog; readonly controller: WebhookIntentController | null; readonly intent: WebhookIntentState; readonly submit: (input: WebhookIntentInput) => Promise<WebhookIntentState>; readonly onOwnerDenied: () => void; readonly onRefreshEndpoint: () => void; readonly routeDeliveryId: string | null; readonly onSelectDelivery: (id: string | null) => void; readonly manageOwner: boolean; readonly onCheckOperation: () => void; readonly onManagementRestricted?: () => void; readonly registerAdmission?: (owner: WebhookOwner, endpointId: string, check: (target: WebhookIntentTarget) => boolean) => () => void;
}) => {
  const formId = useId();
  const currentEndpoint = "lifecycle" in endpoint && endpoint.lifecycle === "active" ? endpoint : null;
  const m = useWebhookDeliveryMessages(), scope = `${window.location.origin}:${admission.userId}:${owner.kind}:${owner.id}:${endpoint.id}:${authorizationKey}`;
  const filterScope = `${owner.kind}:${owner.id}:${endpoint.id}`;
  const [draft, setDraft] = useScopedState(filterScope, initialFilters), [query, setQuery] = useScopedState<WebhookDeliveryQuery>(filterScope, { limit: 50 }), [filtersOpen, setFiltersOpen] = useScopedState(filterScope, false), [filterError, setFilterError] = useScopedState(filterScope, false);
  const [selection, setSelection] = useState<{ readonly scope: string; readonly id: string; readonly opener: HTMLElement | null } | null>(null), [detailState, setDetailState] = useState<{ readonly scope: string; readonly value: WebhookDelivery | null; readonly error: unknown; readonly refreshing: boolean }>({ scope, value: null, error: null, refreshing: false });
  const [payload, setPayload] = useState<{ readonly key: string; readonly value: WebhookPayload } | null>(null), [payloadError, setPayloadError] = useState<unknown>(null), [payloadBusy, setPayloadBusy] = useState(false), [confirm, setConfirm] = useState<{ readonly version: string; readonly generation: string } | null>(null), [writeError, setWriteError] = useState<unknown>(null);
  const [generationDraft, setGenerationDraft] = useState(""), [generation, setGeneration] = useState<string | undefined>(), [generationError, setGenerationError] = useState(false), [now, setNow] = useState(Date.now);
  const detailRequest = useRef<AbortController | null>(null), detailSequence = useRef(0), payloadRequest = useRef<AbortController | null>(null), payloadSequence = useRef(0), detailRef = useRef(detailState), rejectedReads = useRef(new Set<AbortController>()), observations = useRef(new WebhookDeliveryObservations());
  detailRef.current = detailState;
  const selected = selection?.scope === scope ? selection : null;
  const live = useRef({ scope, active, visible, selected, endpoint, manageOwner, confirm, intent, controller }); live.current = { scope, active, visible, selected, endpoint, manageOwner, confirm, intent, controller };
  const operation = useRef<object | null>(null), mounted = useRef(true);
  const publication = useRef<{ readonly abort: AbortController; readonly resume: () => void } | null>(null);
  const observation = useRef<{ readonly controller: WebhookIntentController; readonly id: string; readonly stopRevision: number; readonly pauseRevision: number; readonly scope: string; readonly selected: typeof selected; readonly confirm: typeof confirm } | null>(null);
  const requestAdmission = { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch, ready: (signal: AbortSignal) => admission.ready(signal) };
  const clearPayload = (preserveError = false) => { payloadSequence.current++; payloadRequest.current?.abort(); setPayload(null); if (!preserveError) setPayloadError(null); setPayloadBusy(false); };
  const assertTargetDisclosure = (value: WebhookDelivery) => {
    if ((!live.current.manageOwner || "lifecycle" in live.current.endpoint && live.current.endpoint.lifecycle === "active" && !live.current.endpoint.capabilities.manage) && value.target.url !== null) throw new ApiError("protocol");
  };
  const forgetPrivateProjection = (id: string) => {
    if (controller?.getSnapshot().result?.delivery?.id === id) controller.forgetCurrentProjection();
  };
  const publishDetail = (value: WebhookDelivery | null) => {
    const old = detailRef.current.value;
    if (value === null || value.disclosure === "metadata_only" || !value.payloadAvailable || old?.id === value.id && samePayloadResource(old) !== samePayloadResource(value)) clearPayload(true);
    const next = { scope: live.current.scope, value, error: null, refreshing: false }; detailRef.current = next; setDetailState(next);
  };
  const observeResource = (value: WebhookDelivery, startedAt: number): WebhookDelivery | null => {
    assertTargetDisclosure(value);
    const observedAt = Date.now(); setNow(observedAt);
    const expired = observedAt >= Date.parse(value.payloadExpiresAt);
    const current = observations.current.observe(expired ? { ...value, payloadAvailable: false } : value, startedAt);
    if (webhookDeliveryRestricted(current)) forgetPrivateProjection(value.id);
    if (current?.disclosure === "full" && current.target.url === null) onManagementRestricted();
    return current;
  };
  const observe = (items: readonly WebhookDelivery[], startedAt: number) => {
    const observed = items.map(item => observeResource(item, startedAt)).filter((item): item is WebhookDelivery => item !== null);
    const current = live.current.selected, matching = current === null ? undefined : observed.find(item => item.id === current.id);
    if (matching !== undefined && webhookDeliveryRestricted(matching)) { detailSequence.current++; detailRequest.current?.abort(); publishDetail(matching); }
    return observed;
  };
  const projectResources = (items: readonly WebhookDelivery[]) => items.map(item => { const current = observations.current.current(item.id); return current === undefined ? item : current; }).filter((item): item is WebhookDelivery => item !== null);
  const history = useWebhookHistory(scope, query, admission, active && visible, (filters, signal) => listWebhookDeliveries(owner, endpoint.id, filters as WebhookDeliveryQuery, signal, requestAdmission), onOwnerDenied, observe, observations.current.beginRead, projectResources);
  const restrictResource = (id: string, value: WebhookDelivery | null) => {
    observations.current.restrict(id, value); forgetPrivateProjection(id);
    const current = observations.current.current(id);
    if (current === null) history.prune(item => item.id !== id);
    else if (current !== undefined) history.mapItems(item => item.id === id ? current : item);
  };
  const withdrawUnavailableHistory = (requestedScope: string, requestedId: string, error: unknown) => {
    if (!webhookHistoryMissing(error) || live.current.scope !== requestedScope || live.current.selected?.id !== requestedId || !live.current.active || !live.current.visible || admission.isInvalidated) return;
    detailSequence.current++; detailRequest.current?.abort(); clearPayload(true); setConfirm(null);
    restrictResource(requestedId, null);
    const next = { scope: requestedScope, value: null, error, refreshing: false }; detailRef.current = next; setDetailState(next);
  };
  const detail = detailState.scope === scope && detailState.value?.id === selected?.id ? detailState.value : null;
  const historyExpired = detailState.scope === scope && webhookHistoryMissing(detailState.error);
  const knownDetail = detail === null ? undefined : observations.current.current(detail.id);
  const privateDetail = knownDetail === undefined ? detail : knownDetail;
  const displayedDetail = historyExpired ? null : privateDetail;
  const payloadKey = displayedDetail === null ? null : `${scope}:${samePayloadResource(displayedDetail)}`;
  const payloadAllowed = displayedDetail?.disclosure === "full" && displayedDetail.payloadAvailable && now < Date.parse(displayedDetail.payloadExpiresAt);
  const displayedPayload = payloadAllowed && payload?.key === payloadKey ? payload.value : null;
  const attempts = useWebhookHistory<WebhookAttempt, WebhookAttemptQuery>(`${scope}:${selected?.id ?? ""}`, { ...(generation === undefined ? {} : { generation }), limit: 50 }, admission, active && visible && selected !== null && !historyExpired, (filters, signal) => listWebhookAttempts(owner, endpoint.id, selected!.id, filters, signal, requestAdmission), onOwnerDenied, items => items, observations.current.beginRead, items => items, error => { if (selected !== null) withdrawUnavailableHistory(scope, selected.id, error); });
  const readDetail = async (visibleRefresh: boolean) => {
    const requested = live.current;
    if (!requested.active || !requested.visible || requested.selected === null || admission.isInvalidated) return;
    const startedAt = observations.current.beginRead(), sequence = ++detailSequence.current; detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    const signal = AbortSignal.any([admission.signal, controller.signal]);
    const current = () => !signal.aborted && !admission.isInvalidated && live.current.active && live.current.visible && live.current.scope === requested.scope && live.current.selected?.id === requested.selected!.id && detailSequence.current === sequence;
    if (visibleRefresh) setDetailState(old => ({ ...old, refreshing: true }));
    try {
      const value = await getWebhookDelivery(owner, endpoint.id, requested.selected.id, signal, requestAdmission);
      await admission.ready(signal); if (!current()) return;
      const currentValue = observeResource(value, startedAt);
      if (currentValue === null) history.prune(item => item.id !== value.id);
      else history.mapItems(item => item.id === value.id ? currentValue : item);
      publishDetail(currentValue);
    } catch (error) {
      if (!current()) return;
      if (webhookHistoryDenied(error)) { clearPayload(); restrictResource(requested.selected.id, null); onOwnerDenied(); }
      if (webhookHistoryMissing(error)) { withdrawUnavailableHistory(requested.scope, requested.selected.id, error); return; }
      const old = detailRef.current;
      const next = { scope: requested.scope, value: webhookHistoryMissing(error) || webhookHistoryDenied(error) ? null : old.scope === requested.scope && old.value?.id === requested.selected.id ? old.value : null, error, refreshing: false }; detailRef.current = next; setDetailState(next);
    }
  };
  const revalidateRejectedDelivery = async (requestedScope: string, requestedId: string, isOriginal: () => boolean): Promise<void> => {
    if (!isOriginal()) return;
    const controller = new AbortController(); rejectedReads.current.add(controller);
    const signal = AbortSignal.any([admission.signal, controller.signal]), startedAt = observations.current.beginRead();
    const current = () => !signal.aborted && isOriginal();
    try {
      const value = await getWebhookDelivery(owner, endpoint.id, requestedId, signal, requestAdmission);
      await admission.ready(signal); if (!current()) return;
      const projection = observeResource(value, startedAt);
      if (projection === null) history.prune(item => item.id !== requestedId);
      else history.mapItems(item => item.id === requestedId ? projection : item);
      if (live.current.selected?.id === requestedId) publishDetail(projection);
    } catch (error) {
      if (!current()) return;
      if (webhookHistoryMissing(error)) { restrictResource(requestedId, null); withdrawUnavailableHistory(requestedScope, requestedId, error); }
      else if (webhookHistoryDenied(error)) onOwnerDenied();
      else if (live.current.selected?.id === requestedId) { const next = { ...detailRef.current, error }; detailRef.current = next; setDetailState(next); }
    } finally { rejectedReads.current.delete(controller); }
  };
  useLayoutEffect(() => {
    const projection = intent.result?.delivery;
    if (projection === undefined) return;
    const current = observations.current.current(projection.id);
    if (current === null || current !== undefined && (webhookDeliveryRestricted(current) || BigInt(current.generation) > BigInt(projection.generation))) controller?.forgetCurrentProjection();
  }, [intent.result?.delivery, scope]);
  useLayoutEffect(() => {
    if (manageOwner) return;
    observations.current.restrictTargets();
    history.mapItems(item => { const current = observations.current.current(item.id); return current === undefined || current === null ? item : current; });
    const current = detailRef.current.value;
    if (current !== null) { const projection = observations.current.current(current.id); if (projection !== undefined) publishDetail(projection); }
    const writeProjection = controller?.getSnapshot().result?.delivery;
    if (writeProjection !== undefined) forgetPrivateProjection(writeProjection.id);
  }, [manageOwner, scope]);
  useLayoutEffect(() => registerAdmission(owner, endpoint.id, target => {
    const current = live.current, configuration = current.endpoint;
    if (!current.active || !current.manageOwner || admission.isInvalidated || !("lifecycle" in configuration) || configuration.lifecycle !== "active" || !configuration.enabled || !configuration.capabilities.redeliver || target.owner.kind !== owner.kind || target.owner.id !== owner.id || target.endpointId !== configuration.id || target.deliveryId === null || target.ifVersion !== configuration.configVersion || target.destinationRevision !== configuration.destinationRevision) return false;
    const delivery = observations.current.current(target.deliveryId);
    return delivery !== undefined && delivery !== null && delivery.disclosure === "full" && delivery.target.url !== null && delivery.payloadAvailable && delivery.state !== "suppressed" && delivery.state !== "leased" && target.ifGeneration === delivery.generation && target.destinationRevision === delivery.target.destinationRevision && Date.now() < Date.parse(delivery.payloadExpiresAt);
  }), [scope, registerAdmission, admission]);
  const readRef = useRef(readDetail); readRef.current = readDetail;
  useLayoutEffect(() => {
    detailSequence.current++; detailRequest.current?.abort(); for (const request of rejectedReads.current) request.abort(); rejectedReads.current.clear(); clearPayload(); setConfirm(null); setWriteError(null);
    if (detailRef.current.scope !== scope) { observations.current.clear(); const empty = { scope, value: null, error: null, refreshing: false }; detailRef.current = empty; setDetailState(empty); }
  }, [scope]);
  useEffect(() => {
    if (!visible) return;
    if (routeDeliveryId === null) { if (selected !== null) { clearPayload(); setSelection(null); setConfirm(null); } }
    else if (active && selected?.id !== routeDeliveryId) { clearPayload(); setSelection({ scope, id: routeDeliveryId, opener: null }); }
  }, [scope, routeDeliveryId, visible, active]);
  useEffect(() => { if (selected !== null && visible) { clearPayload(); setConfirm(null); setWriteError(null); setGenerationDraft(""); setGeneration(undefined); } }, [scope, selected?.id, visible]);
  useEffect(() => { if (selected !== null && active && visible) void readRef.current(false); }, [scope, selected?.id, active, visible]);
  useLayoutEffect(() => {
    if (!visible || admission.isInvalidated) { detailSequence.current++; detailRequest.current?.abort(); clearPayload(); setSelection(null); setConfirm(null); }
  }, [visible, admission.isInvalidated]);
  useEffect(() => {
    const check = () => { void readRef.current(false); }, visible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useLayoutEffect(() => {
    const stop = () => { publication.current?.abort.abort(); publication.current = null; for (const request of rejectedReads.current) request.abort(); rejectedReads.current.clear(); };
    const unsubscribe = controller?.subscribeStop(stop);
    return () => { unsubscribe?.(); stop(); };
  }, [controller]);
  useLayoutEffect(() => {
    if (controller === null) return;
    let observing = false;
    const capture = () => {
      const state = controller.getSnapshot();
      if (state.reconciling && !observing && state.prepared !== null) {
        publication.current?.abort.abort(); publication.current = null;
        observation.current = { controller, id: state.prepared.operationId, stopRevision: controller.getStopRevision(), pauseRevision: authRequestsPauseRevision(), scope: live.current.scope, selected: live.current.selected, confirm: live.current.confirm };
      }
      observing = state.reconciling;
    };
    const unsubscribe = controller.subscribe(capture); capture();
    return unsubscribe;
  }, [controller]);
  useEffect(() => {
    if (detail === null) return;
    const deadline = Date.parse(detail.payloadExpiresAt), observedAt = Date.now();
    if (deadline <= observedAt) { if (now < deadline) setNow(observedAt); return; }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(1, deadline - observedAt + 1)));
    return () => window.clearTimeout(timer);
  }, [detail?.payloadExpiresAt, now]);
  useLayoutEffect(() => {
    if (payloadAllowed) return;
    clearPayload(true);
    if (detail !== null && now >= Date.parse(detail.payloadExpiresAt) && detail.payloadAvailable) restrictResource(detail.id, { ...detail, payloadAvailable: false });
  }, [payloadAllowed, detail?.payloadAvailable, detail?.payloadExpiresAt, now]);
  useEffect(() => {
    if (!active || !visible || displayedDetail === null) return;
    const delay = ["pending", "leased"].includes(displayedDetail.state) ? 2000 : 30_000;
    const timer = window.setTimeout(() => { void readRef.current(false); attempts.check(); history.check(); }, delay);
    return () => window.clearTimeout(timer);
  }, [active, visible, displayedDetail, detailState.error]);
  useEffect(() => {
    if (!active || !visible || selected !== null) return;
    const timer = window.setInterval(() => history.check(), 30_000);
    return () => window.clearInterval(timer);
  }, [active, visible, selected?.id]);
  useEffect(() => {
    mounted.current = true;
    const stopPause = subscribeAuthPause(() => { for (const request of rejectedReads.current) request.abort(); rejectedReads.current.clear(); });
    return () => { mounted.current = false; operation.current = null; publication.current?.abort.abort(); publication.current = null; stopPause(); detailSequence.current++; detailRequest.current?.abort(); for (const request of rejectedReads.current) request.abort(); rejectedReads.current.clear(); payloadSequence.current++; payloadRequest.current?.abort(); };
  }, []);
  useEffect(() => () => { publication.current?.abort.abort(); publication.current = null; for (const request of rejectedReads.current) request.abort(); rejectedReads.current.clear(); }, [scope, selected, confirm]);
  useEffect(() => { publication.current?.resume(); }, [active, visible, intent.phase, intent.prepared?.operationId]);
  const open = (value: WebhookDelivery, opener: HTMLElement) => { const known = observations.current.current(value.id); if (known === null) return; setNow(Date.now()); clearPayload(); setConfirm(null); setWriteError(null); const next = { scope, value: known === undefined ? value : known, error: null, refreshing: false }; detailRef.current = next; setDetailState(next); setSelection({ scope, id: value.id, opener }); onSelectDelivery(value.id); };
  const close = () => { detailSequence.current++; detailRequest.current?.abort(); clearPayload(); setSelection(null); setConfirm(null); onSelectDelivery(null); };
  const revealPayload = async () => {
    if (displayedPayload !== null) { clearPayload(); return; }
    if (!payloadAllowed || displayedDetail === null || payloadBusy || !active || !visible) return;
    const requested = displayedDetail, requestedScope = scope, requestedKey = payloadKey!, sequence = ++payloadSequence.current; payloadRequest.current?.abort(); const controller = new AbortController(); payloadRequest.current = controller;
    const signal = AbortSignal.any([admission.signal, controller.signal]); setPayloadBusy(true); setPayloadError(null);
    const current = () => !signal.aborted && !admission.isInvalidated && live.current.active && live.current.visible && live.current.scope === requestedScope && live.current.selected?.id === requested.id && payloadSequence.current === sequence && detailRef.current.value?.id === requested.id && samePayloadResource(detailRef.current.value) === samePayloadResource(requested) && observations.current.current(requested.id)?.disclosure === "full" && Date.now() < Date.parse(requested.payloadExpiresAt);
    try {
      const value = await getWebhookPayload(owner, endpoint.id, requested.id, requested.eventId, signal, requestAdmission);
      await admission.ready(signal); if (current()) setPayload({ key: requestedKey, value });
    } catch (error) {
      if (!current()) return;
      setPayload(null); setPayloadError(error);
      if (webhookHistoryDenied(error)) { detailSequence.current++; detailRequest.current?.abort(); restrictResource(requested.id, redacted(requested)); const next = { scope, value: redacted(requested), error: null, refreshing: false }; detailRef.current = next; setDetailState(next); }
      else if (error instanceof ApiError && error.kind === "server" && error.status === 410) { detailSequence.current++; detailRequest.current?.abort(); const value = { ...requested, payloadAvailable: false }; restrictResource(requested.id, value); const next = { scope, value, error: null, refreshing: false }; detailRef.current = next; setDetailState(next); }
      else if (webhookHistoryMissing(error)) withdrawUnavailableHistory(requestedScope, requested.id, error);
    } finally { if (payloadSequence.current === sequence) setPayloadBusy(false); }
  };
  const apply = () => {
    if (draft.projectId !== "" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(draft.projectId) || draft.from !== "" && !utc(draft.from) || draft.to !== "" && !utc(draft.to) || draft.from !== "" && draft.to !== "" && timeOrder(draft.from) > timeOrder(draft.to) || !/^[1-9][0-9]{0,2}$/.test(draft.limit) || Number(draft.limit) > 100) { setFilterError(true); return; }
    setFilterError(false); setQuery({ limit: Number(draft.limit), ...(draft.eventType === "" ? {} : { eventType: draft.eventType as NonNullable<WebhookDeliveryQuery["eventType"]> }), ...(draft.state === "" ? {} : { state: draft.state as NonNullable<WebhookDeliveryQuery["state"]> }), ...(draft.projectId === "" ? {} : { projectId: draft.projectId }), ...(draft.from === "" ? {} : { from: draft.from }), ...(draft.to === "" ? {} : { to: draft.to }) });
  };
  const busy = intent.phase === "preparing" || intent.phase === "submitting" || intent.phase === "unknown" || intent.reconciling;
  const redeliveryReason = displayedDetail === null ? m.unavailable : currentEndpoint === null ? "kind" in endpoint ? endpoint.kind === "checking-configuration" ? m.endpointChecking : m.endpointUnavailable : m.endpointDeleted : !manageOwner || !currentEndpoint.capabilities.redeliver || displayedDetail.target.url === null ? m.readOnly : !catalog.service.dispatchEnabled ? m.dispatchDisabled : !currentEndpoint.enabled ? m.unavailable : displayedDetail.disclosure !== "full" || displayedDetail.state === "suppressed" ? m.stoppedReason : displayedDetail.target.destinationRevision !== currentEndpoint.destinationRevision ? m.targetChanged : !payloadAllowed ? m.payloadExpired : displayedDetail.state === "leased" ? m.leaseReason : displayedDetail.manualOperationCount >= catalog.limits.maxManualOperations ? m.manualLimit : null;
  const canRedeliver = active && visible && redeliveryReason === null && !busy;
  const receipt = intent.phase === "confirmed" && intent.result?.operation.kind === "delivery.redeliver" && intent.result.operation.deliveryId === selected?.id && intent.result.operation.endpointId === endpoint.id ? intent.result.operation : null;
  const handled = useRef<string | null>(null);
  const operationGuard = useRef<{ readonly belongs: () => boolean; readonly revision: number; id: string | null } | null>(null);
  const publishWhenAdmitted = (belongs: () => boolean, revision: number) => {
    publication.current?.abort.abort();
    const abort = new AbortController(), signal = AbortSignal.any([admission.signal, abort.signal]);
    let waiting = false, admittedRevision = revision;
    const resume = () => {
      if (signal.aborted || !belongs()) { abort.abort(); if (publication.current?.abort === abort) publication.current = null; return; }
      if (authRequestsPaused() || authRequestsPauseRevision() !== admittedRevision) {
        if (!waiting) {
          waiting = true;
          void (async () => {
            while (!signal.aborted && belongs()) {
              await waitForAuthRequests(signal);
              await admission.ready(signal);
              if (authRequestsPaused()) continue;
              admittedRevision = authRequestsPauseRevision(); waiting = false; resume(); return;
            }
          })().catch(error => { if (!signal.aborted && belongs()) setWriteError(error); if (publication.current?.abort === abort) publication.current = null; }).finally(() => { if (signal.aborted && publication.current?.abort === abort) publication.current = null; });
        }
        return;
      }
      if (!live.current.active || !live.current.visible) return;
      publication.current = null; setConfirm(null); void readRef.current(false); attempts.refresh(); history.refresh(); onRefreshEndpoint();
    };
    publication.current = { abort, resume };
    resume();
  };
  useEffect(() => {
    if (receipt === null || handled.current === receipt.operationId) return;
    handled.current = receipt.operationId;
    const observed = observation.current;
    if (observed !== null && observed.id === receipt.operationId && observed.controller === controller) {
      publishWhenAdmitted(() => mounted.current && !admission.isInvalidated && live.current.controller === observed.controller && observed.controller.getStopRevision() === observed.stopRevision && live.current.scope === observed.scope && live.current.selected === observed.selected && live.current.confirm === observed.confirm && live.current.intent.phase === "confirmed" && live.current.intent.result?.operation.operationId === observed.id, observed.pauseRevision);
      return;
    }
    const guard = operationGuard.current;
    if (guard !== null && guard.id === null) guard.id = receipt.operationId;
    if (guard?.id === receipt.operationId) { if (guard.belongs()) publishWhenAdmitted(guard.belongs, guard.revision); return; }
    if (authRequestsPaused()) return;
    const requestedScope = scope, requestedSelection = selected, requestedConfirm = confirm;
    const stopRevision = controller?.getStopRevision();
    publishWhenAdmitted(() => mounted.current && !admission.isInvalidated && live.current.controller === controller && controller?.getStopRevision() === stopRevision && live.current.scope === requestedScope && live.current.selected === requestedSelection && live.current.confirm === requestedConfirm && live.current.intent.phase === "confirmed" && live.current.intent.result?.operation.operationId === receipt.operationId, authRequestsPauseRevision());
  }, [receipt?.operationId]);
  const register = async () => {
    if (!canRedeliver || authRequestsPaused() || confirm === null || displayedDetail === null || controller === null || currentEndpoint === null) return;
    publication.current?.abort.abort(); publication.current = null; for (const request of rejectedReads.current) request.abort(); rejectedReads.current.clear();
    const requestedScope = scope, requestedId = displayedDetail.id, requestedSelection = selected, requestedConfirm = confirm, revision = authRequestsPauseRevision(), stopRevision = controller.getStopRevision(), token = {};
    operation.current = token;
    const belongs = () => {
      const state = controller.getSnapshot();
      return mounted.current && operation.current === token && !admission.isInvalidated && live.current.controller === controller && controller.getStopRevision() === stopRevision && live.current.scope === requestedScope && live.current.selected === requestedSelection && live.current.confirm === requestedConfirm && (guard.id === null || state.phase === "idle" || state.prepared?.operationId === guard.id);
    };
    const current = () => belongs() && !authRequestsPaused() && authRequestsPauseRevision() === revision && live.current.active && live.current.visible;
    const guard = { belongs, revision, id: null as string | null }; operationGuard.current = guard;
    try {
      const outcome = await submit({ kind: "delivery.redeliver", endpointId: endpoint.id, deliveryId: requestedId, ifVersion: confirm.version, ifGeneration: confirm.generation, destinationRevision: currentEndpoint.destinationRevision, body: {} });
      guard.id ??= outcome.prepared?.operationId ?? outcome.result?.operation.operationId ?? null;
      if (outcome.phase === "rejected" && operationGuard.current === guard) operationGuard.current = null;
      if (outcome.phase === "confirmed") {
        const id = outcome.result?.operation.operationId;
        if (id !== undefined && handled.current === id) return;
        if (id !== undefined) handled.current = id;
        if (belongs()) publishWhenAdmitted(belongs, revision);
      }
      else if (!current()) return;
      else if (outcome.phase === "rejected") void revalidateRejectedDelivery(requestedScope, requestedId, current).catch(error => { if (current()) setWriteError(error); });
    } catch (error) { if (operationGuard.current === guard) operationGuard.current = null; if (current()) setWriteError(error); }
  };
  const items = history.page?.items;
  return <div id="webhook-panel-deliveries" role="tabpanel" aria-labelledby="webhook-tab-deliveries" hidden={!visible}>
    <div className="deliveries-heading"><h3>{m.deliveries}</h3><div className="delivery-tools"><button className="button ghost icon-only" type="button" aria-label={m.filters} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><WebhookIcon name="search" size={13}/></button><button className="button ghost icon-only" type="button" aria-label={m.refresh} disabled={!active || history.refreshing} onClick={() => { history.refresh(); void readRef.current(true); attempts.refresh(); onRefreshEndpoint(); }}>{history.refreshing ? <span className="spinner"/> : <WebhookIcon name="refresh" size={13}/>}</button></div></div>
    {filtersOpen && <form className="delivery-filters" onSubmit={event => { event.preventDefault(); apply(); }}>
      <div className="form-field"><label htmlFor={`${formId}-event`}>{m.event}</label><NativeSelect layout="fill" id={`${formId}-event`} value={draft.eventType} onChange={event => setDraft(old => ({ ...old, eventType: event.target.value }))}><option value="">{m.all}</option>{catalog.items.map(item => <option key={item.key} value={item.key}>{item.key}</option>)}</NativeSelect></div>
      <div className="form-field"><label htmlFor={`${formId}-state`}>{m.state}</label><NativeSelect layout="fill" id={`${formId}-state`} value={draft.state} onChange={event => setDraft(old => ({ ...old, state: event.target.value }))}><option value="">{m.all}</option>{["pending", "leased", "delivered", "failed", "suppressed"].map(state => <option key={state} value={state}>{m[state as WebhookDelivery["state"]]}</option>)}</NativeSelect></div>
      {(["projectId", "from", "to", "limit"] as const).map(key => <div className="form-field" key={key}><label htmlFor={`${formId}-${key}`}>{key === "projectId" ? m.project : m[key]}</label><input className="input" id={`${formId}-${key}`} value={draft[key]} inputMode={key === "limit" ? "numeric" : undefined} placeholder={key === "from" || key === "to" ? "2026-11-08T00:00:00Z" : undefined} onChange={event => setDraft(old => ({ ...old, [key]: event.target.value }))}/></div>)}
      {filterError && <p className="inline-error" role="alert">{m.invalidFilters}</p>}<div className="delivery-filter-actions"><button className="button small" type="submit" disabled={!active}>{m.apply}</button><button className="text-button" type="button" onClick={() => { setDraft(initialFilters); setQuery({ limit: 50 }); setFilterError(false); }}>{m.reset}</button></div>
    </form>}
    {history.error !== null && <><WebhookError error={history.error}/><button className="text-button" type="button" disabled={!active} onClick={history.refresh}>{m.retry}</button></>}
    {items === undefined ? history.error === null && <div className="delivery-loading" role="status">{m.loading}</div> : items.length === 0 ? <div className="state-box"><span className="state-icon"><WebhookIcon name="clock" size={23}/></span><h3>{m.empty}</h3><p>{m.emptyCopy}</p></div> : <div className="delivery-list">{items.map(item => { const known = observations.current.current(item.id), value = known === undefined ? item : known; if (value === null) return null; return <button className="delivery-row" type="button" key={value.id} onClick={event => open(value, event.currentTarget)}><div className="delivery-row-top"><span className="delivery-event">{value.eventType ?? m.inaccessible}</span><DeliveryStatusBadge value={value} messages={m}/></div><div className="delivery-meta"><span>{value.resource.displayName ?? value.resource.projectId ?? m.inaccessible}</span><time>{value.occurredAt}</time></div><div className="delivery-response"><WebhookIcon name={value.state === "suppressed" ? "lock" : "arrow"} size={10}/><span>{value.state === "suppressed" ? m.stoppedReason : resultText(value.lastResult, m)} · {value.attemptCount} {m.attempts}</span></div></button>; })}</div>}
    {history.page !== null && <div className="delivery-history-note"><p>{history.pendingQuery ? m.previousResults : history.page.nextCursor === null ? m.complete : m.historyIncomplete}</p><p>{m.historyIncomplete} {m.payloadDays}: {history.page.retention.payloadRetentionSeconds} {m.seconds} · {m.metadataDays}: {history.page.retention.metadataRetentionSeconds} {m.seconds}</p>{history.page.nextCursor !== null && <button className="text-button" type="button" disabled={!active || history.refreshing || history.pendingQuery} onClick={history.more}>{m.more}</button>}</div>}
    {selected !== null && visible && <WebhookDialog title={m.details} opener={selected.opener} onClose={close} footer={<><span className="tiny dialog-footer-spacer">{m.acknowledgementCopy}</span><button className="button" type="button" onClick={close}>{m.close}</button><button className="button primary" type="button" disabled={!canRedeliver} title={redeliveryReason ?? undefined} onClick={() => { if (displayedDetail !== null && currentEndpoint !== null) { setWriteError(null); setConfirm({ version: currentEndpoint.configVersion, generation: displayedDetail.generation }); } }}><WebhookIcon name="refresh" size={13}/>{m.redeliver}</button></>}>
      <div className="delivery-details">
        <WebhookPendingNotice state={intent} active={active} onCheck={onCheckOperation}/>
        {receipt !== null && <div className="value-box delivery-receipt" role="status"><span><strong>{m.registered}</strong><br/>{m.registeredGeneration}: {receipt.generationAfter} · {m.currentGeneration}: {displayedDetail?.generation ?? "—"}<br/>{m.receiptCopy}</span></div>}
        {detailState.scope === scope && detailState.error !== null && <><WebhookError error={detailState.error}/><button className="text-button" type="button" disabled={!active || detailState.refreshing} onClick={() => { void readRef.current(true); }}>{m.readCurrent}</button></>}
        {historyExpired && <p className="inline-error" role="alert">{m.historyExpired}</p>}
        {displayedDetail === null ? !historyExpired && detailState.error === null && <p role="status">{m.loading}</p> : <>
          <div className="delivery-summary"><div><div className="delivery-event">{displayedDetail.eventType ?? m.inaccessible}</div><div className="delivery-resource">{displayedDetail.resource.displayName ?? displayedDetail.resource.projectId ?? m.inaccessible}</div></div><DeliveryStatusBadge value={displayedDetail} messages={m}/></div>
          {displayedDetail.disclosure === "metadata_only" && <div className="inline-error"><WebhookIcon name="lock" size={14}/><span>{m.payloadDenied}</span></div>}
          <RecordGrid entries={[[m.eventId, displayedDetail.eventId], [m.deliveryId, displayedDetail.id], [m.generation, displayedDetail.generation], [m.resourceVersion, displayedDetail.resourceVersion], [m.originalTarget, displayedDetail.target.url ?? displayedDetail.target.displayUrl], [m.destinationRevision, displayedDetail.target.destinationRevision], [m.occurred, displayedDetail.occurredAt], [m.lastAcknowledged, displayedDetail.lastAcknowledgedAt], [m.latestResult, resultText(displayedDetail.lastResult, m)], [m.lastAttempt, displayedDetail.lastAttemptAt], [m.nextAttempt, displayedDetail.nextAttemptAt], [m.automaticCount, `${displayedDetail.automaticAttemptCount} / ${catalog.limits.maxAutomaticAttempts}`], [m.manualCount, `${displayedDetail.manualOperationCount} / ${catalog.limits.maxManualOperations}`], [m.automaticExpires, displayedDetail.automaticExpiresAt], [m.payloadExpires, displayedDetail.payloadExpiresAt], [m.expires, displayedDetail.expiresAt]]}/>
          <div className="delivery-attempt-heading"><h3 className="section-title">{m.attemptHistory}</h3><button className="text-button" type="button" disabled={!active || attempts.refreshing || detailState.refreshing} onClick={() => { attempts.refresh(); void readRef.current(true); }}><WebhookIcon name="refresh" size={12}/>{m.refresh}</button></div>
          <div className="delivery-generation-filter"><form id={`${formId}-generation-form`} onSubmit={event => { event.preventDefault(); if (generationDraft !== "" && (!/^[1-9][0-9]{0,18}$/.test(generationDraft) || BigInt(generationDraft) > 9_223_372_036_854_775_807n)) { setGenerationError(true); return; } setGenerationError(false); setGeneration(generationDraft === "" ? undefined : generationDraft); }}><div className="form-field"><label htmlFor={`${formId}-generation`}>{m.generation}</label><input className="input" id={`${formId}-generation`} inputMode="numeric" value={generationDraft} placeholder={m.generations} onChange={event => setGenerationDraft(event.target.value)}/></div></form><button className="button small" type="submit" form={`${formId}-generation-form`} disabled={!active}>{m.apply}</button></div>{generationError && <p className="inline-error" role="alert">{m.invalidGeneration}</p>}
          {attempts.error !== null && <WebhookError error={attempts.error}/>}{attempts.page === null ? attempts.error === null && <p className="hint" role="status">{m.loading}</p> : attempts.page.items.length === 0 ? <p className="hint">{m.notSent}</p> : <div className="timeline">{attempts.page.items.map(attempt => <Attempt key={attempt.id} value={attempt} messages={m}/>)}</div>}{attempts.page?.nextCursor !== null && attempts.page !== null && <button className="text-button" type="button" disabled={!active || attempts.refreshing || attempts.pendingQuery} onClick={attempts.more}>{m.more}</button>}
          <div className="section-divider"/><div className="payload-summary"><h3>{m.payload}</h3><button className="text-button" type="button" disabled={!active || !payloadAllowed || payloadBusy} onClick={() => { void revealPayload(); }}>{payloadBusy ? <span className="spinner"/> : <WebhookIcon name="eye" size={12}/>} {displayedPayload === null ? m.showPayload : m.hidePayload}</button></div>
          {payloadError !== null && <WebhookError error={payloadError}/>} {!payloadAllowed && <div className="value-box"><WebhookIcon name="lock" size={13}/><span>{now >= Date.parse(displayedDetail.payloadExpiresAt) ? m.payloadExpired : m.payloadUnavailable}</span></div>}
          {displayedPayload !== null && <><pre className="code-block" tabIndex={0} aria-label={m.payload}>{displayedPayload.text}</pre><p className="hint delivery-payload-hash">{displayedPayload.bytes} {m.bytes} · {m.hash}: {displayedPayload.sha256}</p></>}
          {redeliveryReason !== null && <p className="hint">{redeliveryReason}</p>}
          {(intent.phase === "rejected" || intent.phase === "unknown" || intent.phase === "confirmed") && intent.error !== null && <WebhookError error={intent.error}/>}{writeError !== null && <WebhookError error={writeError}/>}
          {confirm !== null && <div className="warning-box delivery-redelivery-confirm"><h3>{m.redeliveryDecision}</h3><p>{m.redeliveryCopy}</p><p>{m.generation}: {confirm.generation} · configVersion: {confirm.version}</p><div className="delivery-filter-actions"><button className="button" type="button" onClick={() => setConfirm(null)}>{m.cancel}</button><button className="button primary" type="button" autoFocus disabled={!canRedeliver} onClick={() => { void register(); }}>{intent.phase === "preparing" || intent.phase === "submitting" ? <span className="spinner"/> : null}{m.confirmRedelivery}</button></div></div>}
        </>}
      </div>
    </WebhookDialog>}
  </div>;
};

const DeliveryStatusBadge = ({ value, messages }: { readonly value: WebhookDelivery; readonly messages: WebhookDeliveryMessages }) => {
  const icon = value.state === "delivered" ? "check" : value.state === "failed" ? "alert" : value.state === "pending" || value.state === "leased" ? "clock" : null;
  return <span className={`badge ${stateClass(value)}`}>{icon !== null && <WebhookIcon name={icon} size={11}/>}{stateText(value, messages)}</span>;
};
const RecordGrid = ({ entries }: { readonly entries: readonly (readonly [string, ReactNode])[] }) => <dl className="record-grid">{entries.map(([label, value]) => <div className="record-entry" key={label}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>)}</dl>;
const Attempt = ({ value, messages: m }: { readonly value: WebhookAttempt; readonly messages: WebhookDeliveryMessages }) => <article className={`attempt ${value.outcome === "acknowledged" ? "success" : value.outcome === null ? "pending" : "failed"}`}>
  <div className="attempt-title"><strong>{m.generation} {value.generation} · #{value.number} · {value.outcome === null ? m.leased : m[value.outcome]}</strong><time>{value.claimedAt}</time></div>
  <RecordGrid entries={[[m.claimed, value.claimedAt], [m.admitted, value.admittedAt], [m.dispatched, value.dispatchedAt], [m.finished, value.finishedAt], [m.httpStatus, value.httpStatus], [m.duration, value.durationMs === null ? null : `${value.durationMs} ms`]]}/>
  {value.error !== null && <p>{value.error.code} · {value.error.message}</p>}{value.recoveredUnknownAt !== null && <p>{m.recovered}: {value.recoveredUnknownAt}. {m.unknownCopy}</p>}
  {value.lateResult !== null && <div className="delivery-late-result"><strong>{m.lateResult}</strong><p>{m[value.lateResult.outcome]} · {m.lateObserved}: {value.lateResult.observedAt} · HTTP {value.lateResult.httpStatus ?? "—"} · {value.lateResult.durationMs === null ? "—" : `${value.lateResult.durationMs} ms`}{value.lateResult.error === null ? "" : ` · ${value.lateResult.error}`}</p></div>}
</article>;
