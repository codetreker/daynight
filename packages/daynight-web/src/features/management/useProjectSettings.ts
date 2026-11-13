import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useProjectAccess } from "../projects/ProjectAccess";
import { ApiError, authRequestsPaused, isAbortError, subscribeAuthPause } from "../../api/client";
import { getProject, isExecutionWarningMinutes, saveProjectSettings } from "../../api/project-settings";
import type { Project } from "../../api/types";
import type { ProjectManagementGuard } from "./ProjectManagementGuard";
import { isRetryableTaskCacheLifecycleChange } from "../task-cache/project-cache";

export type SettingsNotice = "saved" | "cancelled" | "conflict" | "permission" | "reconciled" | null;
export const parseWarningDraft = (draft: string): number | null => {
  if (!/^[0-9]+$/.test(draft)) return null;
  const minutes = Number(draft);
  return isExecutionWarningMinutes(minutes) ? minutes : null;
};

const abortable = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { cleanup(); reject(signal.reason); };
  const cleanup = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  void promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
});

export const useProjectSettings = (projectId: string, userId: string, onRoute: boolean, active: boolean, onRetentionChange?: (retain: boolean) => void, guard?: ProjectManagementGuard) => {
  const [project, setProject] = useState<Project | null>(null);
  const access = useProjectAccess(projectId);
  const role = access.status === "ready" ? access.access!.effectiveRole : null;
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const uncertainRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [writeError, setWriteError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice>(null);
  const [awaitingSavedRead, setAwaitingSavedRead] = useState(false);
  const [returnReadRequired, setReturnReadRequired] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [reconciliationRequired, setReconciliationRequired] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const publication = useRef<AbortController | null>(null);
  const reloadAfterRevocation = useRef(false);
  const confirmedNeedsRead = useRef(false);
  const pendingSettingsRead = useRef(false);
  const confirmedReadInFlight = useRef(false);
  const generation = useRef(0);
  const submitting = useRef(false);
  const routeRef = useRef(onRoute);
  const activeRef = useRef(active);
  const retention = useRef(onRetentionChange);
  const returnRead = useRef(false);
  const returnNotice = useRef<SettingsNotice>(null);
  const reconciliationNotice = useRef<SettingsNotice>(null);
  const rejectedDraft = useRef(false);
  const noticeForRead = (fallback: SettingsNotice): SettingsNotice =>
    reconciliationNotice.current ?? (uncertainRef.current ? "reconciled" : confirmedNeedsRead.current ? "saved" : fallback);
  activeRef.current = active;
  retention.current = onRetentionChange;
  const routeGeneration = useRef(0);
  if (routeRef.current !== onRoute) {
    routeRef.current = onRoute; ++routeGeneration.current;
    if (onRoute) { returnRead.current = true; returnNotice.current = noticeForRead(notice); }
  }
  const admission = useRef<{ readonly controller: AbortController; dispatched: boolean; confirmed: boolean } | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const activityWaiters = useRef(new Set<() => void>());
  const unavailableRef = useRef(false);
  const revokedAccess = useRef(false);
  const setUnavailableState = (value: boolean) => {
    unavailableRef.current = value; setUnavailable(value);
    if (!value) for (const resume of activityWaiters.current) resume();
  };
  const routeRead = useRef<{ route: number; generation: number; status: "pending" | "succeeded" | "failed" | "cancelled" } | null>(null);
  const confirmedFloor = useRef<bigint | null>(null);
  const confirmedValue = useRef<string | null>(null);
  const confirmedEditGeneration = useRef<number | null>(null);
  const draftRef = useRef(draft);
  const draftGeneration = useRef(0);
  const discardedDraftGeneration = useRef<number | null>(null);
  const cancelledDraftGeneration = useRef<number | null>(null);
  const draftVersion = useRef<bigint | null>(null);
  const draftConflictRef = useRef(false);
  draftRef.current = draft;

  useLayoutEffect(() => {
    if (active && onRoute) for (const resume of activityWaiters.current) resume();
  }, [active, onRoute]);

  // The access session updates its active flag in a passive effect. Check the
  // route synchronously as well so a late receipt cannot publish during that gap.
  const canPresent = () => {
    const current = access.session.snapshot();
    return activeRef.current && routeRef.current && !authRequestsPaused() && !access.session.scope.isInvalidated && !access.session.scope.hasIdentityMismatch
      && (!unavailableRef.current || revokedAccess.current && current.status === "ready")
      && !access.session.scope.isProjectSuspended(projectId) && current.status !== "unavailable"
      && current.status === "ready" && !current.refreshing;
  };
  const waitForScope = async (signal: AbortSignal) => {
    while (true) {
      try { await access.session.scope.ready(signal); return; }
      catch (failure) {
        if (signal.aborted || access.session.scope.isInvalidated || !isRetryableTaskCacheLifecycleChange(failure)) throw failure;
      }
    }
  };
  const waitForFreshAccess = async (signal: AbortSignal, requireActive = false) => {
    signal = AbortSignal.any([signal, access.session.scope.mismatchSignal]);
    while (true) {
      await waitForScope(signal);
      signal.throwIfAborted();
      if (requireActive && (!activeRef.current || !routeRef.current)) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { activityWaiters.current.delete(resume); signal.removeEventListener("abort", abort); };
          const resume = () => { cleanup(); resolve(); };
          const abort = () => { cleanup(); reject(signal.reason); };
          activityWaiters.current.add(resume); signal.addEventListener("abort", abort, { once: true });
        });
        continue;
      }
      const current = access.session.snapshot();
      if (!current.refreshing) return current.status === "ready" ? current.access : null;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", abort); };
        const resume = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const unsubscribe = access.session.subscribe(resume);
        signal.addEventListener("abort", abort, { once: true });
        if (!access.session.snapshot().refreshing) resume();
      });
    }
  };
  const waitForPresentation = async (signal: AbortSignal) => {
    const lifetime = AbortSignal.any([signal, access.session.scope.signal, access.session.scope.mismatchSignal]);
    while (true) {
      lifetime.throwIfAborted();
      if (!activeRef.current || !routeRef.current) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { activityWaiters.current.delete(resume); lifetime.removeEventListener("abort", abort); };
        const resume = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(lifetime.reason); };
        activityWaiters.current.add(resume);
        lifetime.addEventListener("abort", abort, { once: true });
      });
      await waitForFreshAccess(lifetime, true);
      lifetime.throwIfAborted();
      if (canPresent()) return;
      if (authRequestsPaused()) continue;
      if (activeRef.current && routeRef.current) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { unsubscribe(); activityWaiters.current.delete(resume); lifetime.removeEventListener("abort", abort); };
        const resume = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(lifetime.reason); };
        const unsubscribe = access.session.subscribe(resume);
        activityWaiters.current.add(resume);
        lifetime.addEventListener("abort", abort, { once: true });
        if (canPresent() || !activeRef.current || !routeRef.current) resume();
      });
    }
  };

  useEffect(() => {
    if (onRoute) return;
    if (admission.current !== null && !admission.current.dispatched) admission.current.controller.abort();
    if (readController.current !== null) {
      readController.current.abort(); readController.current = null;
      if (routeRead.current?.status === "pending") routeRead.current.status = "cancelled";
      ++generation.current; setLoading(false);
    }
  }, [onRoute]);

  const setUncertainState = (value: boolean) => { uncertainRef.current = value; setUncertain(value); };
  const releaseResolvedRetention = () => {
    if (!submitting.current && publication.current === null && !returnRead.current && !confirmedNeedsRead.current && reconciliationNotice.current === null && !uncertainRef.current && !(access.session.scope.hasIdentityMismatch && rejectedDraft.current)) {
      guard?.release("settings");
      retention.current?.(false);
    }
  };
  const clearPrivateDraft = () => {
    ++draftGeneration.current; discardedDraftGeneration.current = draftGeneration.current; cancelledDraftGeneration.current = null;
    draftVersion.current = null; draftConflictRef.current = false; setDraftConflict(false);
    projectRef.current = null; draftRef.current = "";
    setProject(null); setDraft(""); setInvalid(false);
  };
  const clearPrivate = () => {
    revokedAccess.current = false;
    clearPrivateDraft(); setUncertainState(false); setUnavailableState(true);
    returnRead.current = false; setReturnReadRequired(false);
    confirmedNeedsRead.current = false; confirmedEditGeneration.current = null; confirmedFloor.current = null; confirmedValue.current = null; setAwaitingSavedRead(false);
    reconciliationNotice.current = null; rejectedDraft.current = false; setReconciliationRequired(false); setWriteError(null);
    releaseResolvedRetention();
  };
  const load = async (lifetime: AbortSignal, nextNotice: SettingsNotice = null) => {
    if (access.session.scope.hasIdentityMismatch) return;
    readController.current?.abort();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal, access.session.scope.mismatchSignal]);
    const current = ++generation.current;
    const route = routeGeneration.current;
    routeRead.current = { route, generation: current, status: "pending" };
    const finishRead = (status: "succeeded" | "failed" | "cancelled") => {
      if (routeRead.current?.generation === current) routeRead.current.status = status;
    };
    // A return read may replace a submitted draft after confirmation or under
    // the existing conflict/unknown reconciliation rules, not after other rejections.
    const returning = returnRead.current;
    const preserveDraft = (returning && submitting.current && admission.current?.confirmed === false && reconciliationNotice.current === null && !uncertainRef.current)
      || (!submitting.current && (returning || confirmedNeedsRead.current || reconciliationNotice.current !== null || uncertainRef.current));
    const preserveError = returning || confirmedNeedsRead.current || reconciliationNotice.current !== null;
    const originalDraft = draftGeneration.current;
    // During an unresolved read the version also records an edit back to the
    // old value, so retries cannot mistake it for an explicit cancellation.
    const hadDraftIntent = draftVersion.current !== null
      && (returning && rejectedDraft.current || confirmedEditGeneration.current === null || draftGeneration.current !== confirmedEditGeneration.current);
    const currentRoute = () => routeGeneration.current === route && (!returning || activeRef.current && routeRef.current);
    if (!returning) setLoading(true);
    if (!preserveError) setError(null);
    try {
      // A revoked or failed access observation cannot reconcile an already
      // dispatched write. Wait for authorization instead of treating a 404
      // from the resource read as evidence of that write's outcome.
      if ((uncertainRef.current || reconciliationNotice.current !== null || confirmedNeedsRead.current) && access.session.snapshot().status !== "ready") {
        pendingSettingsRead.current = true;
        finishRead("failed");
        return;
      }
      await waitForScope(signal);
      signal.throwIfAborted();
      const [saved] = await Promise.all([abortable(getProject(projectId, signal, { userId, onPrincipalMismatch: access.session.scope.principalMismatch }), signal), abortable(access.session.revalidate(), signal)]);
      let admitted;
      let currentAccess;
      do {
        admitted = await waitForFreshAccess(signal);
        currentAccess = access.session.snapshot();
      } while (authRequestsPaused() || currentAccess.refreshing || currentAccess.status === "ready" && currentAccess.access !== admitted);
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current || !currentRoute()) { finishRead("cancelled"); return; }
      if (admitted === null || currentAccess.status !== "ready" || access.session.scope.isProjectSuspended(projectId)) { pendingSettingsRead.current = true; finishRead("failed"); return; }
      if (confirmedFloor.current !== null && saved.settings.version < confirmedFloor.current) throw new Error("Project settings read is older than the confirmed save");
      if (projectRef.current !== null && saved.settings.version < projectRef.current.settings.version) throw new Error("Project settings read is older than the displayed settings");
      pendingSettingsRead.current = false;
      confirmedFloor.current = null;
      if (activeRef.current && routeRef.current) {
        returnRead.current = false; setReturnReadRequired(false);
      }
      projectRef.current = saved; setProject(saved);
      const changedSinceSubmit = confirmedEditGeneration.current !== null && draftGeneration.current !== confirmedEditGeneration.current
        && (discardedDraftGeneration.current !== draftGeneration.current || cancelledDraftGeneration.current === draftGeneration.current);
      const keepDraft = preserveDraft && (discardedDraftGeneration.current !== draftGeneration.current || changedSinceSubmit)
        && (hadDraftIntent || draftGeneration.current !== originalDraft || changedSinceSubmit);
      if (!keepDraft) {
        discardedDraftGeneration.current = null;
        draftVersion.current = null;
        draftConflictRef.current = false; setDraftConflict(false);
        const value = String(saved.settings.executionWarningMinutes);
        draftRef.current = value; setDraft(value);
      } else if (draftRef.current === String(saved.settings.executionWarningMinutes) && (confirmedEditGeneration.current === null || draftGeneration.current === confirmedEditGeneration.current)) {
        draftVersion.current = null;
        draftConflictRef.current = false; setDraftConflict(false);
      } else if (draftVersion.current !== null && draftVersion.current !== saved.settings.version) {
        draftConflictRef.current = true; setDraftConflict(true);
      }
      revokedAccess.current = false; setUnavailableState(false); setUncertainState(false);
      setError(null);
      if (!preserveDraft || draftGeneration.current === originalDraft) {
        setInvalid(false);
        if (!(keepDraft && nextNotice === "conflict" && draftRef.current !== String(saved.settings.executionWarningMinutes))) setNotice(nextNotice);
      }
      if (nextNotice === "saved") { confirmedNeedsRead.current = false; confirmedValue.current = null; setAwaitingSavedRead(false); }
      confirmedEditGeneration.current = null; rejectedDraft.current = false;
      if (reconciliationNotice.current !== null && nextNotice === reconciliationNotice.current) {
        reconciliationNotice.current = null; setReconciliationRequired(false); setWriteError(null);
      }
      finishRead("succeeded");
      releaseResolvedRetention();
    } catch (failure) {
      if (signal.aborted || current !== generation.current || isAbortError(failure) || !currentRoute()) { finishRead("cancelled"); return; }
      try { do { await waitForScope(signal); } while (authRequestsPaused()); } catch { return; }
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current || !currentRoute()) { finishRead("cancelled"); return; }
      if (failure instanceof ApiError && failure.kind === "server" && (failure.status === 404 || failure.status === 403)) {
        if (uncertainRef.current || reconciliationNotice.current !== null || confirmedNeedsRead.current) {
          revokedAccess.current = false;
          clearPrivateDraft(); setUnavailableState(true); setError(failure);
        } else clearPrivate();
      } else setError(failure);
      finishRead("failed");
    } finally {
      if (routeRead.current?.generation === current && routeRead.current.status === "pending") finishRead("cancelled");
      if (readController.current === read) readController.current = null;
      if (!returning && current === generation.current && (!signal.aborted || access.session.scope.hasIdentityMismatch)) setLoading(false);
    }
  };

  useEffect(() => access.session.scope.subscribe((event) => {
    if (event.projectId !== projectId || !event.accessRevoked) return;
    ++generation.current; readController.current?.abort(); routeRead.current = null;
    if (admission.current !== null && !admission.current.dispatched) admission.current.controller.abort();
    confirmedEditGeneration.current = null;
    reloadAfterRevocation.current = true;
    revokedAccess.current = true;
    clearPrivateDraft(); setUnavailableState(true); setLoading(false); setError(null);
    releaseResolvedRetention();
  }), [projectId, access.session]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    void load(active.signal);
    return () => { active.abort(); publication.current?.abort(); publication.current = null; readController.current?.abort(); confirmedNeedsRead.current = false; pendingSettingsRead.current = false; ++generation.current; };
  }, [projectId, userId]);
  useEffect(() => {
    if (unavailableRef.current && access.refreshing && readController.current === null) reloadAfterRevocation.current = true;
    if (!access.ready || controller.current === null || publication.current !== null && !(unavailableRef.current && reloadAfterRevocation.current) || submitting.current && !reloadAfterRevocation.current) return;
    if (readController.current !== null || returnRead.current && (!onRoute || !active)) return;
    if (confirmedNeedsRead.current) {
      if (routeRead.current?.status === "failed" && !reloadAfterRevocation.current && !pendingSettingsRead.current) return;
      if (!confirmedReadInFlight.current) {
        confirmedReadInFlight.current = true; reloadAfterRevocation.current = false; pendingSettingsRead.current = false;
        void load(controller.current.signal, "saved").finally(() => { confirmedReadInFlight.current = false; });
      }
    } else if (reloadAfterRevocation.current || pendingSettingsRead.current) {
      reloadAfterRevocation.current = false; pendingSettingsRead.current = false;
      void load(controller.current.signal, noticeForRead(returnRead.current ? returnNotice.current : null));
    }
  }, [access.ready, access.refreshing, unavailable, access.session, awaitingSavedRead, pending, onRoute, active]);
  useEffect(() => {
    if (confirmedNeedsRead.current && onRoute && active && !unavailableRef.current && !authRequestsPaused() && !access.session.scope.hasIdentityMismatch) setNotice("saved");
  }, [access.status, access.ready, onRoute, active, awaitingSavedRead]);
  useEffect(() => {
    const prior = routeRead.current;
    if (!onRoute || !active || !returnRead.current || admission.current !== null || publication.current !== null || readController.current !== null || controller.current === null || prior?.route === routeGeneration.current && prior.status !== "cancelled") return;
    retention.current?.(true);
    setReturnReadRequired(true);
    void load(controller.current.signal, noticeForRead(returnNotice.current));
  }, [onRoute, active, pending]);

  const save = async () => {
    const admitted = access.session.snapshot();
    if (access.session.scope.hasIdentityMismatch || !routeRef.current || submitting.current || confirmedNeedsRead.current || reconciliationNotice.current !== null || returnRead.current || draftConflictRef.current || loading || uncertain || admitted.status !== "ready" || admitted.access!.effectiveRole !== "admin" || project === null) return;
    const minutes = parseWarningDraft(draft);
    if (minutes === null) { setInvalid(true); return; }
    if (guard !== undefined && !guard.tryAcquire("settings")) return;
    submitting.current = true; setPending(true); setError(null); setWriteError(null); setNotice(null); setInvalid(false);
    retention.current?.(true);
    const lifetime = controller.current!;
    const operation: { controller: AbortController; dispatched: boolean; confirmed: boolean; receipt: Project | null; rejection: ApiError | null } = { controller: new AbortController(), dispatched: false, confirmed: false, receipt: null, rejection: null };
    admission.current = operation;
    const cancelPreparation = () => { if (!operation.dispatched) operation.controller.abort(); };
    const unsubscribePause = subscribeAuthPause(cancelPreparation);
    if (authRequestsPaused()) cancelPreparation();
    const signal = AbortSignal.any([lifetime.signal, operation.controller.signal, access.session.scope.mismatchSignal]);
    const operationGeneration = generation.current;
    const operationRoute = routeGeneration.current;
    const submittedDraftGeneration = draftGeneration.current;
    rejectedDraft.current = false;
    const ownership = admitted.access!.ownership;
    const expectedVersion = draftVersion.current ?? project.settings.version;
    // Publication belongs to this owner and is cancelled when a later operation
    // replaces it or the user/project lifetime ends.
    publication.current?.abort();
    const publish = (work: (signal: AbortSignal) => Promise<void>) => {
      const owner = new AbortController();
      publication.current = owner;
      const publicationSignal = AbortSignal.any([lifetime.signal, owner.signal, access.session.scope.signal]);
      void (async () => {
        try {
          do { await waitForPresentation(publicationSignal); } while (!canPresent());
          publicationSignal.throwIfAborted();
          await work(publicationSignal);
        } catch (failure) {
          const rejection = operation.rejection;
          if (!lifetime.signal.aborted && publication.current === owner && access.session.scope.hasIdentityMismatch && rejection !== null && rejection.kind === "server" && rejection.status !== null && rejection.status >= 400 && rejection.status < 500) setWriteError(rejection);
          else if (!publicationSignal.aborted && !isAbortError(failure)) setError(failure);
        } finally {
          if (publication.current === owner) {
            publication.current = null;
            if (!lifetime.signal.aborted) releaseResolvedRetention();
          }
        }
      })();
    };
    try {
      let fresh;
      let currentAccess;
      do {
        fresh = await waitForFreshAccess(signal, true);
        currentAccess = access.session.snapshot();
      } while (!signal.aborted && (currentAccess.refreshing || currentAccess.status === "ready" && currentAccess.access !== fresh));
      if (signal.aborted || !activeRef.current || !routeRef.current || operationRoute !== routeGeneration.current || access.session.scope.isInvalidated || access.session.scope.isProjectSuspended(projectId) || operationGeneration !== generation.current || projectRef.current?.settings.version !== project.settings.version) return;
      if (currentAccess.status !== "ready") return;
      if (fresh === null) return;
      if (fresh.effectiveRole !== "admin") { setNotice("permission"); return; }
      if (fresh.ownership.teamId !== ownership.teamId || fresh.ownership.version !== ownership.version) { setNotice("conflict"); return; }
      let saved: Project;
      try {
        saved = await abortable(saveProjectSettings(projectId, { version: expectedVersion, executionWarningMinutes: minutes }, signal, () => {
          if (!routeRef.current || operationRoute !== routeGeneration.current) throw new DOMException("The settings route changed.", "AbortError");
          operation.dispatched = true;
        }, { userId, onPrincipalMismatch: access.session.scope.principalMismatch, onConfirmed: value => { operation.confirmed = true; operation.receipt = value; }, onRejected: error => { operation.rejection = error; } }), signal);
      } catch (failure) {
        if (operation.receipt === null) throw operation.rejection ?? failure;
        saved = operation.receipt;
      }
      operation.confirmed = true;
      confirmedFloor.current = saved.settings.version;
      confirmedValue.current = String(saved.settings.executionWarningMinutes);
      confirmedEditGeneration.current = submittedDraftGeneration;
      if (!access.session.scope.hasIdentityMismatch) {
        if (draftGeneration.current === submittedDraftGeneration) draftVersion.current = null;
        else if (!draftConflictRef.current && (draftVersion.current === null || draftVersion.current === expectedVersion)) {
          // Later edits follow this confirmed snapshot; a newer external version
          // still conflicts when it is observed during publication or a read.
          draftVersion.current = saved.settings.version;
        }
      }
      if (routeRef.current && activeRef.current && !authRequestsPaused() && !access.session.scope.hasIdentityMismatch && !unavailableRef.current) setNotice("saved");
      confirmedNeedsRead.current = true; setAwaitingSavedRead(true);
      publish(async (publicationSignal) => {
        if (returnRead.current && routeRead.current?.status === "failed" && (revokedAccess.current || !unavailableRef.current)) {
          // Access was restored but the resource read failed. The receipt is
          // authoritative; keep the read error and require a successful retry.
          const latest = projectRef.current !== null && projectRef.current.settings.version > saved.settings.version ? projectRef.current : saved;
          projectRef.current = latest; setProject(latest); setUnavailableState(false); setNotice("saved");
          if (draftGeneration.current === submittedDraftGeneration || discardedDraftGeneration.current === draftGeneration.current && cancelledDraftGeneration.current !== draftGeneration.current) {
            const value = String(latest.settings.executionWarningMinutes);
            draftRef.current = value; setDraft(value);
          }
          return;
        }
        if (!unavailableRef.current) setNotice("saved");
        if (routeGeneration.current !== operationRoute || returnRead.current || unavailableRef.current && !revokedAccess.current) {
          returnRead.current = true; returnNotice.current = "saved"; setReturnReadRequired(true);
          await load(publicationSignal, "saved");
          return;
        }
        ++generation.current;
        if (readController.current !== null) {
          if (routeRead.current?.status === "pending") routeRead.current.status = "cancelled";
          readController.current.abort();
        }
        setLoading(false); setError(null);
        revokedAccess.current = false; setUnavailableState(false);
        const currentProject = projectRef.current;
        const latest = currentProject !== null && currentProject.settings.version > saved.settings.version ? currentProject : saved;
        projectRef.current = latest; setProject(latest);
        if (draftGeneration.current === submittedDraftGeneration || discardedDraftGeneration.current === draftGeneration.current && cancelledDraftGeneration.current !== draftGeneration.current) {
          draftVersion.current = null; draftConflictRef.current = false; setDraftConflict(false);
          const value = String(latest.settings.executionWarningMinutes);
          draftRef.current = value; setDraft(value);
        } else if (draftVersion.current !== null && draftVersion.current !== latest.settings.version) {
          draftConflictRef.current = true; setDraftConflict(true);
        }
        confirmedFloor.current = null; confirmedValue.current = null; confirmedEditGeneration.current = null;
        confirmedNeedsRead.current = false; setAwaitingSavedRead(false); setNotice("saved");
      });
    } catch (failure) {
      if (lifetime.signal.aborted || access.session.scope.isInvalidated) return;
      if (!operation.dispatched) {
        if (!signal.aborted && !isAbortError(failure)) publish(async () => { setError(failure); });
        return;
      }
      confirmedEditGeneration.current = submittedDraftGeneration;
      if (failure instanceof ApiError && failure.kind === "server" && failure.status !== null && failure.status >= 400 && failure.status < 500) rejectedDraft.current = true;
      if (failure instanceof ApiError && failure.kind === "server" && (failure.status === 409 || failure.status === 403)) {
        const resultNotice = failure.status === 409 ? "conflict" : "permission";
        reconciliationNotice.current = resultNotice; setReconciliationRequired(true); setWriteError(failure);
        if (returnRead.current) returnNotice.current = resultNotice;
        publish(async (publicationSignal) => { await load(publicationSignal, resultNotice); });
      } else if (failure instanceof ApiError && failure.kind === "server" && failure.status === 404) {
        publish(async () => { clearPrivate(); });
      } else if (failure instanceof ApiError && failure.kind === "server" && failure.status !== null && failure.status >= 400 && failure.status < 500) {
        publish(async (publicationSignal) => {
          setWriteError(failure);
          if (unavailableRef.current || returnRead.current || routeGeneration.current !== operationRoute) {
            returnRead.current = true; returnNotice.current = null; setReturnReadRequired(true);
            await load(publicationSignal);
          }
        });
      } else {
        // Cancellation after dispatch does not establish whether the write committed.
        setUncertainState(true);
        if (returnRead.current) returnNotice.current = "reconciled";
        publish(async (publicationSignal) => { await load(publicationSignal, "reconciled"); });
      }
    } finally {
      unsubscribePause();
      if (admission.current === operation) {
        admission.current = null;
        if (!lifetime.signal.aborted) { submitting.current = false; setPending(false); releaseResolvedRetention(); }
      }
    }
  };

  const change = (value: string) => {
    ++draftGeneration.current;
    discardedDraftGeneration.current = null; cancelledDraftGeneration.current = null;
    if (projectRef.current !== null && !draftConflictRef.current) {
      if (!returnRead.current && !confirmedNeedsRead.current && reconciliationNotice.current === null && value === String(projectRef.current.settings.executionWarningMinutes)) draftVersion.current = null;
      else draftVersion.current ??= confirmedNeedsRead.current && confirmedFloor.current !== null ? confirmedFloor.current : projectRef.current.settings.version;
    }
    draftRef.current = value; setDraft(value); setInvalid(false);
    if (!confirmedNeedsRead.current) setNotice(null);
    if (returnRead.current && reconciliationNotice.current === null && !confirmedNeedsRead.current) returnNotice.current = null;
    if (!returnRead.current && reconciliationNotice.current === null && !confirmedNeedsRead.current) setError(null);
    if (reconciliationNotice.current === null) setWriteError(null);
  };
  const cancel = () => {
    if (project === null || pending || uncertain) return;
    ++draftGeneration.current; discardedDraftGeneration.current = draftGeneration.current; cancelledDraftGeneration.current = draftGeneration.current;
    draftVersion.current = null; draftConflictRef.current = false; setDraftConflict(false);
    const value = String(project.settings.executionWarningMinutes);
    draftRef.current = value; setDraft(value); setInvalid(false);
    if (returnRead.current && reconciliationNotice.current === null && !confirmedNeedsRead.current) returnNotice.current = "cancelled";
    if (!returnRead.current && reconciliationNotice.current === null && !confirmedNeedsRead.current) setError(null);
    if (reconciliationNotice.current === null) setWriteError(null);
    if (!confirmedNeedsRead.current) setNotice("cancelled");
  };
  const retryAccessAndRead = () => {
    pendingSettingsRead.current = true;
    void access.session.revalidate().then(() => {
      const current = access.session.snapshot();
      if (!pendingSettingsRead.current || !activeRef.current || !routeRef.current || controller.current === null || access.session.scope.isInvalidated || current.status !== "ready" || current.refreshing) return;
      pendingSettingsRead.current = false;
      void load(controller.current.signal, noticeForRead(returnNotice.current));
    });
  };

  return {
    project: unavailable || access.status === "unavailable" ? null : project, role, draft, canSubmit: !access.session.scope.hasIdentityMismatch && access.status === "ready" && !awaitingSavedRead && !returnReadRequired && !returnRead.current && !draftConflict && !reconciliationRequired, loading: loading || access.status === "loading", pending, unavailable: unavailable || access.status === "unavailable", uncertain: !unavailable && access.status !== "unavailable" && uncertain, error: error ?? access.error, writeError: unavailable || access.status === "unavailable" ? null : writeError, reconciliation: !unavailable && access.status !== "unavailable" && reconciliationRequired ? reconciliationNotice.current : null, draftConflict, invalid, notice: unavailable || access.status === "unavailable" ? null : notice,
    dirty: project !== null && (draftVersion.current !== null || draft !== String(project.settings.executionWarningMinutes)),
    hasUnsavedDraft: project !== null && draft !== (confirmedNeedsRead.current && confirmedValue.current !== null ? confirmedValue.current : String(project.settings.executionWarningMinutes)),
    summaryPending: pending || awaitingSavedRead || returnReadRequired,
    change,
    cancel,
    retry: () => {
      if (access.session.scope.hasIdentityMismatch) return;
      if (submitting.current) { if (unavailableRef.current || access.session.snapshot().status === "unavailable") retryAccessAndRead(); return; }
      if ((returnRead.current || reconciliationNotice.current !== null || confirmedNeedsRead.current || uncertainRef.current) && !access.ready) {
        retryAccessAndRead();
      } else if (returnRead.current) {
        void load(controller.current!.signal, noticeForRead(returnNotice.current));
      } else if (reconciliationNotice.current !== null) {
        void load(controller.current!.signal, reconciliationNotice.current);
      } else if (confirmedNeedsRead.current) {
        if (access.ready) void load(controller.current!.signal, "saved");
        else void access.session.revalidate();
      } else if (writeError !== null) { setWriteError(null); void load(controller.current!.signal); }
      else if (error === null && project !== null && !uncertain) void access.session.revalidate();
      else { setWriteError(null); void load(controller.current!.signal, uncertain ? "reconciled" : null); }
    },
    save,
  };
};
