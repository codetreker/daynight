import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ApiError, isAbortError, authRequestsPaused, authRequestsPauseRevision, subscribeAuthPause, waitForAuthRequests } from "../../api/client";
import type { CurrentUser } from "../../api/auth-types";
import { getWebhookSecret, type WebhookActiveEndpoint, type WebhookCatalog, type WebhookEndpointSummary, type WebhookOwner, type WebhookSecret, type WebhookSubscription } from "../../api/webhooks";
import { navigate, webhookUrl, type WebhookRoute } from "../../app/router";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { WebhookIntentController, type WebhookIntentInput, type WebhookIntentState, type WebhookIntentTarget } from "../webhook-intents/controller";
import { WebhookConfigurationDialog, WebhookSubscriptionDialog, type WebhookFormActions } from "./WebhookForms";
import { WebhookDialog } from "./WebhookDialog";
import { WebhookPendingNotice } from "./WebhookPendingNotice";
import { WebhookError } from "./WebhookError";
import { WebhookIcon } from "./WebhookIcon";
import { useWebhookMessages } from "./messages";
import { webhookExpansion, webhookAdmissionError } from "./admission";
import { useWebhookListPosition } from "./useWebhookListPosition";
import { useWebhookData, useWebhookDirectories, webhookOwnerKey, type WebhookReadFence } from "./useWebhookData";
import { WebhookDeliveriesPanel } from "../webhook-deliveries/WebhookDeliveriesPanel";
import "./webhooks.css";

const idle: WebhookIntentState = { phase: "idle", prepared: null, result: null, error: null, reconciling: false, persistenceError: null };
const inertSubscribe = () => () => {};
const idleSnapshot = () => idle;
type ModalBody =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly endpoint: WebhookActiveEndpoint }
  | { readonly kind: "delete"; readonly endpoint: WebhookActiveEndpoint }
  | { readonly kind: "rotate"; readonly endpoint: WebhookActiveEndpoint }
  | { readonly kind: "subscription"; readonly endpoint: WebhookActiveEndpoint; readonly subscription: WebhookSubscription | null }
  | { readonly kind: "remove-subscription"; readonly endpoint: WebhookActiveEndpoint; readonly subscription: WebhookSubscription }
  | { readonly kind: "confirm-subscription"; readonly endpoint: WebhookActiveEndpoint; readonly subscription: WebhookSubscription };
type Modal = { readonly scope: string; readonly opener: HTMLElement | null } & ModalBody;
const isBusy = (state: WebhookIntentState) => state.phase === "preparing" || state.phase === "submitting";
const blockedIntent = (state: WebhookIntentState) => isBusy(state) || state.phase === "unknown" || state.reconciling;
const useNarrowWebhookLayout = (): boolean => {
  const query = useMemo(() => window.matchMedia("(max-width: 1080px)"), []);
  const subscribe = useMemo(() => (listener: () => void) => { query.addEventListener("change", listener); return () => query.removeEventListener("change", listener); }, [query]);
  return useSyncExternalStore(subscribe, () => query.matches);
};


export const WebhooksPage = ({ user, admission, active, route, catalog }: {
  readonly user: CurrentUser; readonly admission: TaskCacheScope; readonly active: boolean; readonly route: WebhookRoute; readonly catalog: WebhookCatalog;
}) => {
  const m = useWebhookMessages(), narrow = useNarrowWebhookLayout();
  const owner = useMemo<WebhookOwner | null>(() => route.owner === "personal" ? { kind: "personal", id: user.id } : route.teamId === null ? null : { kind: "team", id: route.teamId }, [route.owner, route.teamId, user.id]);
  const scope = owner === null ? null : webhookOwnerKey(owner);
  const [filters, setFilters] = useState<ReadonlyMap<string, { readonly q: string; readonly enabled: "all" | "enabled" | "paused" }>>(new Map());
  const filter = scope === null ? { q: "", enabled: "all" as const } : filters.get(scope) ?? { q: "", enabled: "all" as const };
  const query = useMemo(() => ({ q: filter.q, limit: 50, ...(filter.enabled === "all" ? {} : { enabled: filter.enabled === "enabled" }) }), [filter.q, filter.enabled]);
  const directoryActive = active && route.error === null;
  const directories = useWebhookDirectories(owner, admission, directoryActive);
  const ownerAuthorization = owner === null ? null : directories.getAuthorization(owner);
  const canRead = directoryActive && ownerAuthorization?.readable === true;
  const interactionSequence = useRef(0), previousSelection = useRef("");
  const selectionKey = JSON.stringify([scope, route.endpointId, route.tab, query]);
  if (previousSelection.current !== selectionKey) { previousSelection.current = selectionKey; interactionSequence.current++; }
  const data = useWebhookData(owner, route.endpointId, query, admission, canRead, directories.getAuthorization, directories.authorizationRevision, directories.observeConfiguration, directories.observeOwnerDenied);
  const sourceEndpoint = data.endpoint?.lifecycle === "active" ? data.endpoint : null;
  const secretAreaVisible = route.tab === "configuration" && (!narrow || route.endpointId !== null);
  const controllers = useRef(new Map<string, WebhookIntentController>()), controllerAuthorizations = useRef(new Map<string, string>()), operationExpansions = useRef(new Map<string, boolean>()), live = useRef({ active: canRead, owner, endpoint: sourceEndpoint, endpointId: route.endpointId ?? data.endpointId, catalog, secretAreaVisible, manageOwner: ownerAuthorization?.manage === true });
  const deliveryAdmissions = useRef(new Map<string, (target: WebhookIntentTarget) => boolean>());
  const registerDeliveryAdmission = useCallback((owner: WebhookOwner, endpointId: string, check: (target: WebhookIntentTarget) => boolean) => {
    const key = `${webhookOwnerKey(owner)}:${endpointId}`; deliveryAdmissions.current.set(key, check);
    return () => { if (deliveryAdmissions.current.get(key) === check) deliveryAdmissions.current.delete(key); };
  }, []);
  let controller: WebhookIntentController | null = null;
  if (owner !== null && route.error === null) {
    controller = controllers.current.get(webhookOwnerKey(owner)) ?? null;
    if (controller === null) {
      const controllerOwner = owner;
      controller = new WebhookIntentController({ serviceOrigin: window.location.origin, owner, signal: admission.signal, admission: { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch, ready: signal => admission.ready(signal) }, canSubmit: (kind, target) => live.current.active && directories.getAuthorization(controllerOwner).manage && !admission.isInvalidated && live.current.owner?.kind === controllerOwner.kind && live.current.owner.id === controllerOwner.id && target.owner.kind === controllerOwner.kind && target.owner.id === controllerOwner.id && (kind === "delivery.redeliver" ? live.current.catalog.service.dispatchEnabled && target.endpointId !== null && deliveryAdmissions.current.get(`${webhookOwnerKey(controllerOwner)}:${target.endpointId}`)?.(target) === true : operationExpansions.current.get(webhookOwnerKey(controllerOwner)) === false || live.current.catalog.service.configurationExpansionAvailable) });
      controllers.current.set(webhookOwnerKey(owner), controller);
      controllerAuthorizations.current.set(webhookOwnerKey(owner), directories.getAuthorization(owner).key);
    }
  }
  const intent = useSyncExternalStore(controller?.subscribe ?? inertSubscribe, controller?.getSnapshot ?? idleSnapshot);
  const writePauseRevisions = useRef(new Map<string, number>()), publicationStopRevisions = useRef(new Map<string, number>()), postWriteRead = useRef<AbortController | null>(null), publication = useRef<AbortController | null>(null), editRevision = useRef(0);
  const [publicationRevision, setPublicationRevision] = useState(0);
  const publicationReady = useRef<(() => void) | null>(null);
  const writeContexts = useRef(new Map<string, { readonly modal: Modal | null; readonly edit: number; readonly interaction: number; readonly revision: number; readonly stopRevision: number }>());
  const presentationGuards = useRef(new Map<string, () => boolean>());
  const mayPresent = () => !authRequestsPaused() && (scope === null || ((!writePauseRevisions.current.has(scope) || writePauseRevisions.current.get(scope) === authRequestsPauseRevision()) && (!publicationStopRevisions.current.has(scope) || publicationStopRevisions.current.get(scope) === controller?.getStopRevision()) && (presentationGuards.current.get(scope)?.() ?? true)));
  const deletedByReceipt = mayPresent() && intent.phase === "confirmed" && intent.result?.operation.kind === "endpoint.delete" ? intent.result.operation.endpointId : null;
  const endpoint = sourceEndpoint?.id === deletedByReceipt ? null : sourceEndpoint;
  const historyEndpointId = route.endpointId ?? data.endpointId;
  const historyContextKey = owner === null || ownerAuthorization?.readable !== true || historyEndpointId === null || admission.isInvalidated ? null : JSON.stringify([window.location.origin, admission.userId, owner.kind, owner.id, historyEndpointId, ownerAuthorization.readKey]);
  const missingConfigurations = useRef(new Set<string>());
  const configurationError = data.endpointId === historyEndpointId ? data.detailError : null;
  const configurationMissing = configurationError instanceof ApiError && configurationError.kind === "server" && configurationError.status === 404 && configurationError.code === "not_found";
  if (historyContextKey !== null) {
    if (data.endpoint?.id === historyEndpointId && configurationError === null) missingConfigurations.current.delete(historyContextKey);
    else if (configurationMissing) missingConfigurations.current.add(historyContextKey);
  }
  const standaloneHistory = historyContextKey !== null && route.error === null && route.tab === "deliveries" && endpoint === null;
  const historyContextKind = historyContextKey !== null && missingConfigurations.current.has(historyContextKey) ? "retained-history" : "checking-configuration";
  const unavailableDetailTitle = ownerAuthorization?.status === "absent" ? m.teamUnavailable : configurationError !== null || data.error !== null ? m.detailError : m.loading;
  const visibleItems = data.items === null ? null : data.items.filter(item => item.id !== deletedByReceipt);
  live.current = { active: canRead, owner, endpoint, endpointId: historyEndpointId, catalog, secretAreaVisible, manageOwner: ownerAuthorization?.manage === true };
  const [modal, setModal] = useState<Modal | null>(null), [menu, setMenu] = useState<string | null>(null), [rotation, setRotation] = useState<"overlap" | "immediate">("overlap"), [secret, setSecret] = useState<{ readonly scope: string; readonly value: WebhookSecret } | null>(null), [secretBusy, setSecretBusy] = useState(false), [secretError, setSecretError] = useState<unknown>(null), [copyStatus, setCopyStatus] = useState<string | null>(null), [localError, setLocalError] = useState<unknown>(null);
  const modalRef = useRef(modal); modalRef.current = modal;
  const secretSequence = useRef(0), handled = useRef(new Set<string>()), lifecycle = useRef(0), listRef = useRef<HTMLElement>(null);
  const writeFences = useRef(new Map<string, WebhookReadFence | null>());
  const saveListPosition = useWebhookListPosition(listRef, JSON.stringify([scope, query]), route.endpointId !== null, visibleItems !== null);
  useEffect(() => {
    const unsubscribe = subscribeAuthPause(() => postWriteRead.current?.abort());
    return () => { unsubscribe(); postWriteRead.current?.abort(); postWriteRead.current = null; publication.current?.abort(); publication.current = null; publicationReady.current = null; };
  }, []);
  useLayoutEffect(() => { postWriteRead.current?.abort(); postWriteRead.current = null; }, [selectionKey]);
  useEffect(() => { if (canRead) publicationReady.current?.(); }, [canRead]);
  useEffect(() => { const generation = ++lifecycle.current; return () => { queueMicrotask(() => { if (lifecycle.current === generation) { for (const value of controllers.current.values()) value.dispose(); controllers.current.clear(); } }); }; }, []);
  useEffect(() => { setModal(null); setMenu(null); setSecret(null); setSecretBusy(false); setSecretError(null); setCopyStatus(null); setLocalError(null); secretSequence.current++; }, [scope]);
  useEffect(() => { setSecret(null); setSecretBusy(false); setSecretError(null); setCopyStatus(null); secretSequence.current++; }, [endpoint?.id, endpoint?.signing.activeKeyId, endpoint?.capabilities.readSecret, route.tab, route.endpointId, secretAreaVisible]);
  useEffect(() => { if (ownerAuthorization?.manage !== true) { setSecret(null); setSecretError(null); setSecretBusy(false); setModal(null); secretSequence.current++; } }, [ownerAuthorization?.key]);
  useEffect(() => {
    for (const [scope, controller] of controllers.current) {
      const kind = scope.startsWith("team:") ? "team" : "personal", owner = { kind, id: scope.slice(kind.length + 1) } as WebhookOwner;
      const key = directories.getAuthorization(owner).key;
      if (controllerAuthorizations.current.get(scope) !== key) { controller.forgetCurrentProjection(); controllerAuthorizations.current.set(scope, key); }
    }
  }, [directories.authorizationRevision, scope]);
  useEffect(() => { if (sourceEndpoint !== null && (!sourceEndpoint.capabilities.manage || !sourceEndpoint.capabilities.readSecret)) controller?.forgetCurrentProjection(); }, [sourceEndpoint?.id, sourceEndpoint?.capabilities.manage, sourceEndpoint?.capabilities.readSecret]);
  useEffect(() => { if (modal !== null && modal.kind !== "create" && (endpoint?.id === modal.endpoint.id && !endpoint.capabilities.manage || data.detailError !== null && endpoint === null)) setModal(null); }, [endpoint, modal]);
  useEffect(() => {
    if (intent.phase !== "confirmed" || intent.result === null || intent.prepared === null || handled.current.has(intent.prepared.operationId) || !mayPresent()) return;
    handled.current.add(intent.prepared.operationId); setSecret(null); secretSequence.current++;
    if (intent.result.operation.kind === "endpoint.delete") data.withdraw(intent.result.operation.endpointId);
    if (modal?.scope === scope) setModal(null);
    if (intent.prepared.kind === "endpoint.create" && owner !== null) navigate(webhookUrl({ owner: owner.kind, teamId: owner.kind === "team" ? owner.id : null, endpointId: intent.result.operation.endpointId, tab: "configuration" }));
  }, [intent, publicationRevision]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest(".row-actions")) setMenu(null); };
    document.addEventListener("click", close); return () => document.removeEventListener("click", close);
  }, []);
  const setFilter = (value: Partial<typeof filter>) => { interactionSequence.current++; if (scope !== null) setFilters(old => { const next = new Map(old); next.set(scope, { ...filter, ...value }); return next; }); };
  const selectedTeam = owner?.kind === "team" ? directories.teams?.find(team => team.id === owner.id) : null;
  const projectLabels = new Map(directories.projects?.map(project => [project.id, project.ownership.teamId === user.personalTeam.id ? m.projectOriginPersonal : directories.teams?.find(team => team.id === project.ownership.teamId)?.name ?? m.sharedOrigin]));
  const manageOwner = ownerAuthorization?.manage === true;
  const manage = canRead && manageOwner && endpoint?.capabilities.manage === true && !blockedIntent(intent), createAllowed = canRead && manageOwner && catalog.service.configurationExpansionAvailable && !blockedIntent(intent);
  const createRestriction = !manageOwner ? m.readOnlyReason : !catalog.service.configurationExpansionAvailable ? m.maintenance : undefined;
  const ownerLabel = owner?.kind === "personal" ? user.name ?? user.email ?? user.id : selectedTeam?.name ?? owner?.id ?? m.chooseTeam;
  const selectOwner = (kind: "personal" | "team", teamId: string | null) => { interactionSequence.current++; navigate(webhookUrl({ owner: kind, teamId, endpointId: null, tab: "configuration" })); };
  const select = (id: string) => { saveListPosition(); interactionSequence.current++; setMenu(null); navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: id, tab: route.tab })); };
  const open = (value: ModalBody, opener: HTMLElement | null) => { if (scope !== null) { interactionSequence.current++; setLocalError(null); setRotation("overlap"); setModal({ ...value, scope, opener } as Modal); setMenu(null); } };
  const observeDenial = (error: unknown, requestedOwner: WebhookOwner, authorizationKey: string, management: boolean): void => {
    if (!(error instanceof ApiError) || error.kind !== "server" || error.status !== 403 || error.code !== "forbidden" || admission.isInvalidated || live.current.owner?.kind !== requestedOwner.kind || live.current.owner.id !== requestedOwner.id || (management ? directories.getAuthorization(requestedOwner).key : directories.getAuthorization(requestedOwner).readKey) !== authorizationKey) return;
    const authorization = management ? directories.observeManagementRestricted(requestedOwner, authorizationKey) : directories.observeOwnerDenied(requestedOwner, authorizationKey);
    if (authorization.key !== authorizationKey) { setLocalError(error); directories.refresh(); }
  };
  const deferConfirmation = (targetScope: string, original: WebhookIntentController, outcome: WebhookIntentState, fence: WebhookReadFence | null, requestedOwner: WebhookOwner) => {
    const context = writeContexts.current.get(targetScope), operationId = outcome.prepared?.operationId;
    if (context === undefined || operationId === undefined || isAbortError(outcome.error) || original.getStopRevision() !== context.stopRevision) return;
    const work = new AbortController(); publication.current?.abort(); publication.current = work; publicationReady.current = null;
    const signal = AbortSignal.any([work.signal, admission.signal]);
    const unsubscribe = original.subscribeStop(() => work.abort());
    signal.addEventListener("abort", () => { unsubscribe(); if (publication.current === work) { publication.current = null; publicationReady.current = null; } }, { once: true });
    const sameContext = () => !signal.aborted && !admission.isInvalidated && live.current.owner?.kind === requestedOwner.kind && live.current.owner.id === requestedOwner.id && original.getSnapshot().prepared?.operationId === operationId && writeContexts.current.get(targetScope) === context && original.getStopRevision() === context.stopRevision && interactionSequence.current === context.interaction && modalRef.current === context.modal && editRevision.current === context.edit;
    const publish = () => {
      if (publication.current !== work) return;
      if (!sameContext()) { publication.current = null; publicationReady.current = null; work.abort(); return; }
      if (authRequestsPaused()) {
        publicationReady.current = null;
        void waitForAuthRequests(signal).then(() => { if (sameContext()) { publicationReady.current = publish; publish(); } }, error => { if (sameContext()) setLocalError(error); });
        return;
      }
      if (!live.current.active) return;
      try {
        presentationGuards.current.set(targetScope, sameContext);
        writePauseRevisions.current.set(targetScope, authRequestsPauseRevision());
        if (outcome.result?.endpoint !== undefined && !data.accept(outcome.result.endpoint, fence)) original.forgetCurrentProjection();
        data.refreshCurrent(); directories.refresh(); setPublicationRevision(value => value + 1);
      } catch (error) { if (sameContext()) setLocalError(error); }
      finally { unsubscribe(); if (publication.current === work) { publication.current = null; publicationReady.current = null; } }
    };
    void (async () => {
      try { await waitForAuthRequests(signal); await admission.ready(signal); if (sameContext()) { publicationReady.current = publish; publish(); } }
      catch (error) { if (sameContext()) setLocalError(error); }
      finally { if (publication.current === work && publicationReady.current !== publish && !authRequestsPaused()) { unsubscribe(); publication.current = null; } }
    })();
  };
  const submit = async (input: WebhookIntentInput): Promise<WebhookIntentState> => {
    if (controller === null || scope === null || owner === null || authRequestsPaused() || !live.current.active || !live.current.manageOwner) throw webhookAdmissionError("WebhookAdmissionUnavailable");
    const state = controller.getSnapshot();
    if (state.reconciling || state.phase === "unknown") throw webhookAdmissionError("WebhookIntentBusy");
    if (!isBusy(state)) {
      postWriteRead.current?.abort(); postWriteRead.current = null; publication.current?.abort(); publication.current = null; publicationReady.current = null;
      writePauseRevisions.current.set(scope, authRequestsPauseRevision()); presentationGuards.current.delete(scope);
      if (input.kind === "delivery.redeliver" && !live.current.catalog.service.dispatchEnabled) throw webhookAdmissionError("WebhookAdmissionUnavailable");
      const expansion = webhookExpansion(input, live.current.endpoint);
      if (expansion && !live.current.catalog.service.configurationExpansionAvailable) throw webhookAdmissionError("WebhookExpansionUnavailable");
      operationExpansions.current.set(scope, expansion); writeFences.current.set(scope, data.captureFence());
      publicationStopRevisions.current.set(scope, controller.getStopRevision());
      writeContexts.current.set(scope, { modal, edit: editRevision.current, interaction: interactionSequence.current, revision: authRequestsPauseRevision(), stopRevision: controller.getStopRevision() });
    }
    const fence = writeFences.current.get(scope) ?? null;
    const submittedKind = input.kind, submittedEndpointId = input.kind === "delivery.redeliver" ? input.endpointId : null;
    const requestedOwner = owner, authorizationKey = directories.getAuthorization(owner).key, readAuthorizationKey = directories.getAuthorization(owner).readKey;
    const revision = writePauseRevisions.current.get(scope), context = writeContexts.current.get(scope), interaction = context?.interaction;
    const outcome = await controller.submit(input);
    if (writeContexts.current.get(scope) !== context || publicationStopRevisions.current.get(scope) !== controller.getStopRevision() || outcome.prepared !== null && controller.getSnapshot().prepared?.operationId !== outcome.prepared.operationId) return outcome;
    if (authRequestsPaused() || revision !== authRequestsPauseRevision() || writePauseRevisions.current.get(scope) !== revision) {
      if (outcome.phase === "confirmed" && writePauseRevisions.current.get(scope) === revision) deferConfirmation(scope, controller, outcome, fence, requestedOwner);
      return outcome;
    }
    // A receipt read requires owner access; a rejected management request only
    // disproves administrator authority for forbidden, not Project eligibility
    // refusals or the member's redacted reads.
    if (submittedKind !== "delivery.redeliver" || outcome.phase !== "rejected") observeDenial(outcome.error, requestedOwner, outcome.phase === "rejected" ? authorizationKey : readAuthorizationKey, outcome.phase === "rejected");
    if (submittedKind !== "delivery.redeliver") observeDenial(outcome.result?.currentError, requestedOwner, authorizationKey, true);
    if (submittedKind === "delivery.redeliver" && submittedEndpointId !== null && outcome.phase === "rejected") {
      const readController = new AbortController(); postWriteRead.current = readController;
      const unsubscribe = controller.subscribeStop(() => readController.abort());
      readController.signal.addEventListener("abort", unsubscribe, { once: true });
      const sameOwner = () => !readController.signal.aborted && !authRequestsPaused() && revision === authRequestsPauseRevision() && interactionSequence.current === interaction && controller.getSnapshot().prepared?.operationId === outcome.prepared?.operationId && !admission.isInvalidated && live.current.owner?.kind === requestedOwner.kind && live.current.owner.id === requestedOwner.id && directories.getAuthorization(requestedOwner).readable;
      if (sameOwner()) void (async () => {
        try {
          const read = await data.readEndpoint(submittedEndpointId, readController.signal);
          if (read !== null && sameOwner() && live.current.endpointId === submittedEndpointId && !data.accept(read.endpoint, read.fence)) controller.forgetCurrentProjection();
        } catch (error) { if (sameOwner() && live.current.endpointId === submittedEndpointId) setLocalError(error); }
        finally { unsubscribe(); if (sameOwner()) { data.refreshCurrent(); directories.refresh(); } if (postWriteRead.current === readController) postWriteRead.current = null; }
      })().catch(error => { if (sameOwner()) setLocalError(error); });
      else { unsubscribe(); if (postWriteRead.current === readController) postWriteRead.current = null; }
    }
    if (outcome.phase === "confirmed") {
      if (outcome.result?.endpoint !== undefined && !data.accept(outcome.result.endpoint, fence)) controller.forgetCurrentProjection();
      data.refreshCurrent(); directories.refresh();
    }
    return outcome;
  };
  const reconcile = async () => {
    if (controller === null || owner === null || !canRead || authRequestsPaused()) return;
    const requestedOwner = owner, authorizationKey = directories.getAuthorization(owner).readKey, revision = authRequestsPauseRevision(), stopRevision = controller.getStopRevision(), operationId = controller.getSnapshot().prepared?.operationId;
    if (scope !== null) {
      const previous = writeContexts.current.get(scope);
      if (previous === undefined) {
        writePauseRevisions.current.set(scope, revision);
        writeContexts.current.set(scope, { modal, edit: editRevision.current, interaction: interactionSequence.current, revision, stopRevision });
      } else if (previous.stopRevision !== stopRevision) writeContexts.current.set(scope, { ...previous, stopRevision });
      publicationStopRevisions.current.set(scope, stopRevision);
    }
    const context = scope === null ? undefined : writeContexts.current.get(scope);
    if (scope !== null && context !== undefined) presentationGuards.current.set(scope, () => writeContexts.current.get(scope) === context && controller.getStopRevision() === stopRevision && controller.getSnapshot().prepared?.operationId === operationId && modalRef.current === context.modal && editRevision.current === context.edit && interactionSequence.current === context.interaction);
    const outcome = await controller.reconcile();
    if (controller.getStopRevision() !== stopRevision || scope !== null && writeContexts.current.get(scope) !== context || controller.getSnapshot().prepared?.operationId !== operationId) return;
    if (authRequestsPaused() || revision !== authRequestsPauseRevision()) {
      if (outcome.phase === "confirmed" && scope !== null) deferConfirmation(scope, controller, outcome, writeFences.current.get(scope) ?? null, requestedOwner);
      return;
    }
    observeDenial(outcome.error, requestedOwner, authorizationKey, false);
    if (outcome.phase === "confirmed" && scope !== null && !mayPresent()) { deferConfirmation(scope, controller, outcome, writeFences.current.get(scope) ?? null, requestedOwner); return; }
    if (outcome.phase === "confirmed") { data.refreshCurrent(); directories.refresh(); }
  };
  const patch = (body: WebhookIntentInput["body"]) => { if (endpoint !== null && manage) void submit({ kind: "endpoint.patch", endpointId: endpoint.id, ifVersion: endpoint.configVersion, destinationRevision: endpoint.destinationRevision, body }).catch(setLocalError); };
  const reveal = async () => {
    if (owner === null || endpoint === null || !manageOwner || !endpoint.capabilities.readSecret || !secretAreaVisible || !canRead || secretBusy) return;
    if (secret !== null) { setSecret(null); secretSequence.current++; return; }
    const generation = ++secretSequence.current, requested = endpoint, fence = data.captureFence();
    setSecretBusy(true); setSecretError(null); setCopyStatus(null);
    try {
      const value = await getWebhookSecret(owner, endpoint.id, admission.signal, { userId: admission.userId, onPrincipalMismatch: admission.principalMismatch, ready: signal => admission.ready(signal) });
      const current = live.current.endpoint;
      if (fence !== null && data.fenceCurrent(fence) && generation === secretSequence.current && live.current.active && live.current.secretAreaVisible && current?.id === requested.id && current.capabilities.readSecret && current.signing.activeKeyId === value.keyId && current.configVersion === value.configVersion && scope !== null) setSecret({ scope, value });
    } catch (error) {
      if (fence !== null) observeDenial(error, owner, fence.authorizationKey, true);
      if (generation === secretSequence.current && !admission.isInvalidated) setSecretError(error);
    }
    finally { if (generation === secretSequence.current) setSecretBusy(false); }
  };
  const rowAction = async (item: WebhookEndpointSummary, action: "edit" | "toggle" | "delete", opener: HTMLElement) => {
    if (owner === null || !canRead || !manageOwner || blockedIntent(intent)) return;
    const requestedOwner = owner, interaction = ++interactionSequence.current;
    try {
      const read = await data.readEndpoint(item.id);
      if (read === null) return;
      const value = read.endpoint;
      if (interactionSequence.current !== interaction || admission.isInvalidated || !live.current.active || !live.current.manageOwner || live.current.owner?.kind !== requestedOwner.kind || live.current.owner.id !== requestedOwner.id || value.lifecycle !== "active" || !value.capabilities.manage) return;
      if (!data.accept(value, read.fence)) return;
      select(value.id); setMenu(null);
      if (action === "toggle") await submit({ kind: "endpoint.patch", endpointId: value.id, ifVersion: value.configVersion, destinationRevision: value.destinationRevision, body: { enabled: !value.enabled } });
      else open({ kind: action, endpoint: value }, opener);
    } catch (error) { if (!admission.isInvalidated) setLocalError(error); }
  };
  const displayedSecret = secretAreaVisible && secret !== null && secret.scope === scope && endpoint?.capabilities.readSecret && endpoint.signing.activeKeyId === secret.value.keyId ? secret.value.secret : null;
  const copy = async () => {
    if (displayedSecret === null) { await reveal(); return; }
    try { await navigator.clipboard.writeText(displayedSecret); setCopyStatus(m.copied); }
    catch { const node = document.getElementById("webhook-secret"); if (node !== null) { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); } setCopyStatus(m.copyManual); }
  };
  const actions: WebhookFormActions = { state: intent, expansionAvailable: catalog.service.configurationExpansionAvailable, canRead, reconcile: () => { void reconcile(); }, canSubmit: canRead && !authRequestsPaused() && !blockedIntent(intent) && (modal?.kind === "create" ? createAllowed : manageOwner && endpoint?.capabilities.manage === true), submit, onClose: () => setModal(null), onDraftChange: () => { editRevision.current++; }, opener: modal?.opener ?? null };
  const validModal = manageOwner && modal?.scope === scope && (modal.kind === "create" ? manageOwner : endpoint?.id === modal.endpoint.id && endpoint.capabilities.manage) ? modal : null;
  const tabKeys: readonly WebhookRoute["tab"][] = ["configuration", "subscriptions", "deliveries"];
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabKeys.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabKeys.length - 1)) % tabKeys.length;
    navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: data.endpointId, tab: tabKeys[next]! })); document.getElementById(`webhook-tab-${tabKeys[next]}`)?.focus();
  };
  return <section className="webhooks" aria-label="Webhooks" onChangeCapture={event => { if (event.target instanceof Element && event.target.closest("dialog")) editRevision.current++; }}>
    <div className="heading"><div className="heading-text"><h1>{m.title}</h1><p className="subtitle">{m.subtitle}</p></div><span tabIndex={createRestriction === undefined ? undefined : 0} title={createRestriction}><button className="button primary" type="button" disabled={!createAllowed} title={createRestriction} onClick={event => open({ kind: "create" }, event.currentTarget)}><WebhookIcon name="plus" size={15}/>{m.new}</button></span></div>
    <div className="scope-bar"><div className="scope-group" role="group" aria-label={m.owner}><button className={`scope-button ${route.owner === "personal" ? "selected" : ""}`} type="button" aria-pressed={route.owner === "personal"} onClick={() => selectOwner("personal", null)}><WebhookIcon name="user" size={15}/>{m.personal}</button><button className={`scope-button ${route.owner === "team" ? "selected" : ""}`} type="button" aria-pressed={route.owner === "team"} onClick={() => selectOwner("team", null)}><WebhookIcon name="team" size={16}/>{m.team}</button></div><div className="scope-context"><WebhookIcon name={route.owner === "team" ? "team" : "user"} size={13}/>{route.owner === "team" ? <select className="filter webhook-team-select" aria-label={m.chooseTeam} value={route.teamId ?? ""} onChange={event => selectOwner("team", event.target.value === "" ? null : event.target.value)}><option value="">{m.chooseTeam}</option>{route.teamId !== null && !directories.teams?.some(team => team.id === route.teamId) && <option value={route.teamId}>{route.teamId}</option>}{directories.teams?.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select> : <strong>{ownerLabel}</strong>}<span className="context-divider"/><span>{route.owner === "team" ? m.scopeTeam : m.scopePersonal}</span>{route.owner === "team" && (ownerAuthorization?.status === "admin" || ownerAuthorization?.status === "member") && <span className="role-label">{manageOwner ? m.administrator : m.member}</span>}</div></div>
    {route.error !== null && <div className="inline-error" role="alert">{m.invalidNavigation}</div>}
    {!catalog.service.configurationExpansionAvailable && <p className="hint webhook-maintenance">{m.maintenance}</p>}
    {directories.error !== null && <div className="webhook-directory-error"><WebhookError error={directories.error}/><button className="text-button" type="button" onClick={directories.refresh}>{m.retry}</button></div>}
    {(intent.phase === "unknown" || intent.phase === "confirmed") && intent.prepared !== null && <div className={`webhook-operation ${intent.phase === "unknown" ? "warning-box" : "value-box"}`} role="status"><div><p>{intent.phase === "unknown" ? m.unknown : intent.result?.operation.effect === "unchanged" ? m.unchanged : m.confirmed}</p><span className="tiny">{m.operationId}</span><code>{intent.prepared.operationId}</code>{intent.result?.operation.keyId !== null && intent.result?.operation.keyId !== undefined && <><span className="tiny">{m.originalKey}</span><code>{intent.result.operation.keyId}</code><span className="tiny">{m.originalDeadline}</span><span>{intent.result.operation.overlapUntil ?? m.noOverlap}</span></>}</div><button className="button small" type="button" disabled={!canRead || intent.reconciling} onClick={() => { void reconcile(); }}>{intent.reconciling ? <span className="spinner"/> : <WebhookIcon name="refresh"/>}{m.checkOperation}</button></div>}
    {intent.phase === "confirmed" && intent.error !== null && <WebhookError error={intent.error}/>}
    {intent.persistenceError !== null && <p className="inline-error" role="alert">{m.persistenceError}</p>}{localError !== null && <WebhookError error={localError}/>}
    <div className={`management-grid ${route.endpointId !== null ? "has-mobile-detail" : ""}`}>
      <section className="panel list-panel" aria-labelledby="webhook-list-title" ref={listRef}>
        <div className="panel-heading"><h2 id="webhook-list-title">{m.endpoints}{visibleItems !== null && <span className="count">{visibleItems.length}</span>}</h2><button className="button ghost icon-only" type="button" aria-label={m.refresh} disabled={!canRead || data.refreshing} onClick={() => { data.refresh(); directories.refresh(); }}>{data.refreshing ? <span className="spinner"/> : <WebhookIcon name="refresh"/>}</button></div>
        <div className="panel-tools"><div className="search-wrap"><WebhookIcon name="search" size={15}/><input type="search" aria-label={m.search} placeholder={m.search} value={filter.q} maxLength={200} onChange={event => setFilter({ q: event.target.value })}/></div><span className="webhook-status-select"><select className="filter" aria-label={m.all} value={filter.enabled} onChange={event => setFilter({ enabled: event.target.value as typeof filter.enabled })}><option value="all">{m.all}</option><option value="enabled">{m.enabled}</option><option value="paused">{m.paused}</option></select><svg aria-hidden="true" viewBox="0 0 10 10"><path d="m2 4 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></span></div>
        {route.endpointId === null && data.error !== null && <><WebhookError error={data.error}/><button className="text-button webhook-list-retry" type="button" disabled={!canRead} onClick={data.refresh}>{m.retry}</button></>}
        <div className="endpoint-list">{owner === null ? <WebhookState title={m.chooseTeam}/> : ownerAuthorization?.status === "absent" ? route.endpointId === null ? <div role="alert"><WebhookState title={m.teamUnavailable}/></div> : <WebhookState title={m.loadError}/> : visibleItems === null ? data.error === null ? <WebhookSkeleton/> : <WebhookState title={m.loadError}/> : visibleItems.length === 0 ? <WebhookState title={filter.q === "" && filter.enabled === "all" ? m.emptyTitle : m.noMatches} description={filter.q === "" && filter.enabled === "all" ? m.emptyCopy : m.noMatchesCopy}>{filter.q === "" && filter.enabled === "all" && <button className="button primary" type="button" disabled={!createAllowed} onClick={event => open({ kind: "create" }, event.currentTarget)}><WebhookIcon name="plus"/>{m.new}</button>}</WebhookState> : visibleItems.map(item => <WebhookRow key={item.id} item={item} selected={data.endpointId === item.id} menu={menu === item.id} onSelect={() => select(item.id)} onMenu={() => setMenu(menu === item.id ? null : item.id)} canManage={canRead && manageOwner && !blockedIntent(intent)} onAction={(action, opener) => { void rowAction(item, action, opener); }}/> )}</div>
        {visibleItems !== null && visibleItems.length > 0 && <div className="list-note"><WebhookIcon name="lock" size={11}/><span>{data.pendingQuery ? m.previousResults : data.nextCursor === null ? m.complete : m.partial}</span>{data.nextCursor !== null && <button className="text-button" type="button" disabled={!canRead || data.refreshing} onClick={data.more}>{m.more}</button>}</div>}
      </section>
      <aside className={`panel detail-panel ${route.endpointId !== null ? "mobile-open" : ""}`} aria-label={endpoint?.name ?? (route.endpointId === null ? m.selectDetail : m.title)}>
        {configurationError !== null && !(standaloneHistory && configurationMissing) && <><WebhookError error={configurationError}/><button className="text-button" type="button" onClick={data.refresh} disabled={!canRead}>{m.retry}</button></>}
        {route.endpointId !== null && data.error !== null && <><WebhookError error={data.error}/><button className="text-button" type="button" onClick={data.refresh} disabled={!canRead}>{m.retry}</button></>}
        {data.endpoint?.lifecycle === "deleted" ? <>
          <div className="detail-heading"><button className="text-button detail-back" type="button" onClick={() => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: null, tab: "configuration" }))}><WebhookIcon name="left" size={12}/>{m.back}</button><div className="detail-name"><h2>{m.deleted}</h2><div className="detail-id">{data.endpoint.id}</div></div><div className="detail-status"><span className="badge paused">configVersion {data.endpoint.configVersion}</span><time className="quiet">{data.endpoint.deletedAt}</time></div></div>
          <div className="tabs" role="tablist" aria-label="Webhook"><button id="webhook-tab-deliveries" className="tab" type="button" role="tab" aria-selected={route.tab === "deliveries"} aria-controls="webhook-panel-deliveries" onClick={() => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: data.endpoint!.id, tab: "deliveries" }))}>{m.deliveries}</button></div>
          <div className="tab-panel">{owner !== null && ownerAuthorization !== null && <WebhookDeliveriesPanel owner={owner} endpoint={data.endpoint} admission={admission} active={canRead} visible={route.tab === "deliveries"} authorizationKey={ownerAuthorization.readKey} catalog={catalog} controller={controller} intent={intent} submit={submit} onOwnerDenied={() => directories.observeOwnerDenied(owner, ownerAuthorization.readKey)} onManagementRestricted={() => directories.observeManagementRestricted(owner, ownerAuthorization.key)} registerAdmission={registerDeliveryAdmission} onCheckOperation={() => { void reconcile(); }} onRefreshEndpoint={data.refresh} routeDeliveryId={route.deliveryId ?? null} manageOwner={manageOwner} onSelectDelivery={deliveryId => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: data.endpoint!.id, tab: "deliveries", ...(deliveryId === null ? {} : { deliveryId }) }))}/>}</div>
        </> : standaloneHistory && owner !== null && ownerAuthorization !== null && historyEndpointId !== null ? <>
          <div className="detail-heading"><button className="text-button detail-back" type="button" onClick={() => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: null, tab: "configuration" }))}><WebhookIcon name="left" size={12}/>{m.back}</button><div className="detail-name"><h2>{m.deliveryHistory}</h2><div className="detail-id">{historyEndpointId}</div></div>{historyContextKind === "retained-history" && <p className="hint">{m.retainedHistory}</p>}</div>
          <div className="tabs" role="tablist" aria-label="Webhook"><button id="webhook-tab-deliveries" className="tab" type="button" role="tab" aria-selected aria-controls="webhook-panel-deliveries">{m.deliveries}</button></div>
          <div className="tab-panel"><WebhookDeliveriesPanel owner={owner} endpoint={{ kind: historyContextKind, id: historyEndpointId }} admission={admission} active={canRead} visible authorizationKey={ownerAuthorization.readKey} catalog={catalog} controller={controller} intent={intent} submit={submit} onOwnerDenied={() => directories.observeOwnerDenied(owner, ownerAuthorization.readKey)} onManagementRestricted={() => directories.observeManagementRestricted(owner, ownerAuthorization.key)} registerAdmission={registerDeliveryAdmission} onCheckOperation={() => { void reconcile(); }} onRefreshEndpoint={data.refresh} routeDeliveryId={route.deliveryId ?? null} manageOwner={manageOwner} onSelectDelivery={deliveryId => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: historyEndpointId, tab: "deliveries", ...(deliveryId === null ? {} : { deliveryId }) }))}/></div>
        </> : endpoint === null ? route.endpointId !== null && route.error === null ? <>
          <div className="detail-heading"><button className="text-button detail-back" type="button" onClick={() => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: null, tab: route.tab }))}><WebhookIcon name="left" size={12}/>{m.back}</button></div>
          <div role={ownerAuthorization?.status === "absent" ? "alert" : undefined}><WebhookState title={unavailableDetailTitle}/></div>
        </> : <div className="empty-detail"><div><WebhookIcon name="webhook" size={30}/><p>{m.selectDetail}</p></div></div> : <>
          <div className="detail-heading"><button className="text-button detail-back" type="button" onClick={() => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: null, tab: route.tab }))}><WebhookIcon name="left" size={12}/>{m.back}</button><div className="detail-heading-top"><div className="detail-name"><h2>{endpoint.name}</h2><div className="detail-id">{endpoint.id}</div></div><button className="button ghost icon-only" type="button" aria-label={`${m.edit} ${endpoint.name}`} disabled={!manage} title={!endpoint.capabilities.manage ? m.readOnlyReason : undefined} onClick={event => open({ kind: "edit", endpoint }, event.currentTarget)}><WebhookIcon name="edit"/></button></div><div className="detail-status"><span className={`badge ${endpoint.enabled ? "success" : "paused"}`}>{endpoint.enabled ? <span className="status-dot"/> : <WebhookIcon name="pause" size={10}/>} {endpoint.enabled ? m.enabled : m.paused}</span><span className="quiet">{m.method}</span></div></div>
          <div className="tabs" role="tablist" aria-label="Webhook">{tabKeys.map((tab, index) => <button id={`webhook-tab-${tab}`} className="tab" type="button" role="tab" key={tab} aria-selected={route.tab === tab} aria-controls={`webhook-panel-${tab}`} tabIndex={route.tab === tab ? 0 : -1} onKeyDown={event => tabKey(event, index)} onClick={() => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: data.endpointId, tab }))}>{tab === "subscriptions" ? `${m[tab]} ` : m[tab]}{tab === "subscriptions" && <span className="count">{endpoint.subscriptions.length}</span>}</button>)}</div>
          <div className="tab-panel">
            {owner !== null && ownerAuthorization !== null && <WebhookDeliveriesPanel owner={owner} endpoint={endpoint} admission={admission} active={canRead} visible={route.tab === "deliveries"} authorizationKey={ownerAuthorization.readKey} catalog={catalog} controller={controller} intent={intent} submit={submit} onOwnerDenied={() => directories.observeOwnerDenied(owner, ownerAuthorization.readKey)} onManagementRestricted={() => directories.observeManagementRestricted(owner, ownerAuthorization.key)} registerAdmission={registerDeliveryAdmission} onCheckOperation={() => { void reconcile(); }} onRefreshEndpoint={data.refresh} routeDeliveryId={route.deliveryId ?? null} manageOwner={manageOwner} onSelectDelivery={deliveryId => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: endpoint.id, tab: "deliveries", ...(deliveryId === null ? {} : { deliveryId }) }))}/>}
            <div id={`webhook-panel-${route.tab === "deliveries" ? "configuration" : route.tab}`} role="tabpanel" aria-labelledby={`webhook-tab-${route.tab === "deliveries" ? "configuration" : route.tab}`} hidden={route.tab === "deliveries"}>
            {route.tab === "configuration" ? <>
              <div className="settings-top"><div><strong>{m.enable}</strong><small>{m.enabledCopy}</small></div><button className="switch" type="button" role="switch" aria-checked={endpoint.enabled} aria-label={m.enable} disabled={!manage || !endpoint.enabled && (!catalog.service.configurationExpansionAvailable || endpoint.subscriptions.some(sub => sub.eligibility !== "eligible"))} onClick={() => patch({ enabled: !endpoint.enabled })}><span/></button></div>
              <div className="field-view"><div className="field-label">{m.owner}</div><div className="field-value type-value"><WebhookIcon name={route.owner === "team" ? "team" : "user"}/>{route.owner === "team" ? m.ownerTeam : m.ownerPersonal} · {ownerLabel}</div></div>
              <div className="field-view"><div className="field-label">{m.url}</div><div className="value-box"><span>{endpoint.destination.url ?? endpoint.destination.displayUrl}</span></div></div>
              <div className="field-view"><div className="field-label">{m.protocol}</div><div className="protocol-line"><span className="quiet-chip">CloudEvents 1.0</span><span className="quiet-chip">Standard Webhooks</span><span className="quiet-chip">HMAC-SHA256</span></div></div>
              <div className="section-divider"/><div className="field-view"><div className="field-label">{m.signing}<button className="text-button" type="button" disabled={!manage} onClick={event => { setSecret(null); secretSequence.current++; open({ kind: "rotate", endpoint }, event.currentTarget); }}>{m.rotate}</button></div><div className="value-box secret-row"><span className="secret-value" id="webhook-secret">{displayedSecret ?? "whsec_••••••••••••••••••••••••"}</span><div className="secret-actions"><button className="button ghost icon-only" type="button" aria-label={displayedSecret === null ? m.showSecret : m.hideSecret} disabled={!canRead || !manageOwner || !endpoint.capabilities.readSecret || secretBusy} onClick={() => { void reveal(); }}><WebhookIcon name="eye" size={13}/></button><button className="button ghost icon-only" type="button" aria-label={m.copy} disabled={!canRead || !manageOwner || !endpoint.capabilities.readSecret || secretBusy} onClick={() => { void copy(); }}><WebhookIcon name="copy" size={13}/></button></div></div><p className="hint">{m.secretHelper}</p>{secretError !== null && <WebhookError error={secretError}/>} {copyStatus !== null && <p className="hint" role="status">{copyStatus}</p>}</div>
              <div className="field-view"><div className="field-label">{m.subscriptionSummary}<button className="text-button" type="button" onClick={() => navigate(webhookUrl({ owner: route.owner, teamId: route.teamId, endpointId: endpoint.id, tab: "subscriptions" }))}>{m.edit}<WebhookIcon name="chevron" size={11}/></button></div><div className="protocol-line">{endpoint.subscriptions.length === 0 ? <span className="tiny">—</span> : [...new Map(endpoint.subscriptions.map(sub => [sub.projectId, sub.projectName])).entries()].map(([id, name]) => <span className="quiet-chip" key={id}>{name ?? id}</span>)}</div></div>
              <div className="detail-footer"><span className="tiny">{m.createdAt} <time>{endpoint.createdAt}</time></span><button className="button ghost danger-text small" type="button" disabled={!manage} onClick={event => open({ kind: "delete", endpoint }, event.currentTarget)}><WebhookIcon name="trash" size={12}/>{m.delete}</button></div>
            </> : <><div className="subscription-heading"><h3>{m.subTitle}</h3><button className="text-button" type="button" disabled={!manage || !catalog.service.configurationExpansionAvailable} onClick={event => open({ kind: "subscription", endpoint, subscription: null }, event.currentTarget)}><WebhookIcon name="plus" size={12}/>{m.addSub}</button></div>{endpoint.subscriptions.length === 0 ? <WebhookState icon="code" title={m.noSubscriptions} description={m.noSubscriptionsCopy}/> : endpoint.subscriptions.map(subscription => <div className={`subscription-card ${subscription.eligibility !== "eligible" ? "revoked-card" : ""}`} key={subscription.id}><div className="subscription-top"><div><div className="project-name"><WebhookIcon name={subscription.eligibility === "eligible" ? "grid" : "lock"} size={11}/> {subscription.projectName ?? subscription.projectId}</div><div className="project-owner">{m.eligibility[subscription.eligibility]}</div></div><div className="subscription-controls"><button className="button ghost icon-only" type="button" aria-label={`${m.editSub} ${subscription.projectName ?? subscription.projectId}`} disabled={!manage} onClick={event => open({ kind: "subscription", endpoint, subscription }, event.currentTarget)}><WebhookIcon name="edit" size={12}/></button><button className="button ghost icon-only" type="button" aria-label={`${m.remove} ${subscription.projectName ?? subscription.projectId}`} disabled={!manage} onClick={event => open({ kind: "remove-subscription", endpoint, subscription }, event.currentTarget)}><WebhookIcon name="close" size={12}/></button></div></div><div className="subscription-events">{subscription.eventTypes.map(event => <span className="event-chip" key={event}>{event}</span>)}</div>{subscription.eligibility === "confirmation_required" && <button className="text-button" type="button" disabled={!manage || !catalog.service.configurationExpansionAvailable || !directories.projects?.some(project => project.id === subscription.projectId)} onClick={event => open({ kind: "confirm-subscription", endpoint, subscription }, event.currentTarget)}>{m.confirm}</button>}</div>)}</>}
            </div>
          </div>
        </>}
      </aside>
    </div>
    {validModal?.kind === "create" || validModal?.kind === "edit" ? <WebhookConfigurationDialog endpoint={validModal.kind === "create" ? null : validModal.endpoint} projects={directories.projects} projectLabels={projectLabels} actions={actions} onReview={async () => { if (owner === null || validModal.kind !== "edit") return null; const read = await data.readEndpoint(validModal.endpoint.id); if (read === null || !data.accept(read.endpoint, read.fence)) return null; return read.endpoint.lifecycle === "active" && read.endpoint.capabilities.manage ? read.endpoint : null; }}/> : validModal?.kind === "subscription" ? <WebhookSubscriptionDialog endpoint={validModal.endpoint} subscription={validModal.subscription} projects={directories.projects} projectLabels={projectLabels} actions={actions}/> : validModal !== null && <WebhookDialog title={validModal.kind === "delete" ? m.deleteTitle : validModal.kind === "rotate" ? m.rotateTitle : validModal.kind === "remove-subscription" ? m.removeSubTitle : m.confirm} opener={validModal.opener} onClose={() => setModal(null)} footer={<><button className="button" type="button" onClick={() => setModal(null)}>{m.cancel}</button><button className={`button ${validModal.kind === "delete" || validModal.kind === "remove-subscription" ? "danger" : "primary"}`} type="button" disabled={!actions.canSubmit} onClick={() => {
      const target = validModal.endpoint;
      const input: WebhookIntentInput = validModal.kind === "delete" ? { kind: "endpoint.delete", endpointId: target.id, ifVersion: target.configVersion, body: {} } : validModal.kind === "rotate" ? { kind: "signing-secret.rotate", endpointId: target.id, ifVersion: target.configVersion, destinationRevision: target.destinationRevision, body: { mode: rotation } } : { kind: "endpoint.patch", endpointId: target.id, ifVersion: target.configVersion, destinationRevision: target.destinationRevision, body: validModal.kind === "confirm-subscription" ? { confirmProjectIds: [validModal.subscription!.projectId] } : { subscriptions: target.subscriptions.filter(sub => sub.id !== validModal.subscription!.id).map(({ id, projectId, eventTypes }) => ({ id, projectId, eventTypes })) } };
      void submit(input).catch(setLocalError);
    }}>{validModal.kind === "rotate" && <WebhookIcon name="key" size={13}/>} {validModal.kind === "rotate" ? m.rotationConfirm : validModal.kind === "delete" ? m.deleteConfirm : validModal.kind === "remove-subscription" ? m.remove : m.confirm}</button></>}>
      <WebhookPendingNotice state={intent} active={canRead} onCheck={actions.reconcile}/>
      {(intent.phase === "rejected" || intent.phase === "unknown") && intent.error !== null && <WebhookError error={intent.error}/>}
      {validModal.kind === "rotate" ? <><p className="dialog-copy">{m.rotateCopy}</p><div className="radio-options"><label><input type="radio" name="webhook-rotation" value="overlap" checked={rotation === "overlap"} onChange={() => setRotation("overlap")}/><span>{m.overlap}</span></label><label><input type="radio" name="webhook-rotation" value="immediate" checked={rotation === "immediate"} onChange={() => setRotation("immediate")}/><span>{m.immediate}</span></label></div></> : <><p className="dialog-copy"><strong>{"subscription" in validModal ? endpoint?.subscriptions.find(sub => sub.id === validModal.subscription?.id)?.projectName ?? validModal.subscription?.projectId : validModal.endpoint.name}</strong></p><p className="dialog-copy webhook-confirm-copy">{validModal.kind === "delete" ? m.deleteCopy : validModal.kind === "remove-subscription" ? m.removeSubCopy : m.confirm}</p>{validModal.kind === "delete" && <div className="warning-box">{validModal.endpoint.destination.url ?? validModal.endpoint.destination.displayUrl}</div>}</>}
    </WebhookDialog>}
  </section>;
};

const WebhookSkeleton = () => { const m = useWebhookMessages(); return <div role="status" aria-label={m.loading}>{[0, 1, 2].map(index => <div className="skeleton-row" key={index}><div className="skeleton-icon"/><div className="skeleton-lines"><div className="skeleton-line short"/><div className="skeleton-line"/><div className="skeleton-line medium"/></div></div>)}</div>; };
const WebhookState = ({ title, description, children, icon = "webhook" }: { readonly title: string; readonly description?: string; readonly children?: import("react").ReactNode; readonly icon?: Parameters<typeof WebhookIcon>[0]["name"] }) => <div className="state-box"><span className="state-icon"><WebhookIcon name={icon} size={23}/></span><h3>{title}</h3>{description !== undefined && <p>{description}</p>}{children}</div>;
const WebhookRow = ({ item, selected, menu, onSelect, onMenu, canManage, onAction }: { readonly item: WebhookEndpointSummary; readonly selected: boolean; readonly menu: boolean; readonly onSelect: () => void; readonly onMenu: () => void; readonly canManage: boolean; readonly onAction: (action: "edit" | "toggle" | "delete", opener: HTMLElement) => void }) => {
  const m = useWebhookMessages(), result = item.lastResult, trigger = useRef<HTMLButtonElement>(null);
  const last = result === null ? item.lastAttemptAt === null ? m.notDelivered : m.lastPending : result.category === "acknowledged" ? m.lastSuccess : result.category === "unknown" ? m.lastUnknown : m.lastFailed;
  return <article className={`endpoint-row ${selected ? "selected" : ""}`} tabIndex={0} role="button" aria-label={item.name} onClick={onSelect} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(); } }}>
    <div className="row-top"><div className="row-name-block"><span className="endpoint-icon"><WebhookIcon name="webhook" size={18}/></span><div className="row-words"><h3 className="row-name">{item.name}<span className={`status-dot ${item.enabled ? "" : "paused"}`} title={item.enabled ? m.enabled : m.paused}/></h3><div className="row-url" title={item.destination.url ?? item.destination.displayUrl}>{item.destination.url ?? item.destination.displayUrl}</div></div></div><div className="row-actions"><button ref={trigger} className="button ghost icon-only" type="button" aria-label={`${m.settings} ${item.name}`} aria-expanded={menu} onClick={event => { event.stopPropagation(); onMenu(); }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onMenu(); } }}><WebhookIcon name="more" size={16}/></button>{menu && <div className="row-menu"><button type="button" onClick={event => { event.stopPropagation(); onSelect(); }}><WebhookIcon name="eye" size={13}/>{m.configuration}</button><button type="button" disabled={!canManage} onClick={event => { event.stopPropagation(); onAction("edit", trigger.current!); }}><WebhookIcon name="edit" size={13}/>{m.edit}</button><button type="button" disabled={!canManage} onClick={event => { event.stopPropagation(); onAction("toggle", trigger.current!); }}><WebhookIcon name={item.enabled ? "pause" : "check"} size={13}/>{item.enabled ? m.pause : m.resume}</button><button className="danger-text" type="button" disabled={!canManage} onClick={event => { event.stopPropagation(); onAction("delete", trigger.current!); }}><WebhookIcon name="trash" size={13}/>{m.delete}</button></div>}</div></div>
    <div className="row-subscriptions"><span className="quiet-chip"><WebhookIcon name="code" size={10}/>{m.method}</span><span>{item.projectCount} {m.resources}</span><span>·</span><span>{item.eventTypeCount} {m.events}</span></div><div className="row-bottom"><span className={`result-inline ${result?.category === "acknowledged" ? "success" : result !== null ? "failed" : ""}`}><WebhookIcon name={!item.enabled ? "pause" : result === null ? "clock" : result.category === "acknowledged" ? "check" : "alert"} size={11}/><span>{!item.enabled ? m.paused : last}</span></span><time>{item.lastAttemptAt ?? "—"}</time></div>
  </article>;
};
