import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useProjectAccess } from "../projects/ProjectAccess";
import { ApiError, isAbortError } from "../../api/client";
import { getProject, isExecutionWarningMinutes, saveProjectSettings } from "../../api/project-settings";
import type { Project } from "../../api/types";
import type { ProjectManagementGuard } from "./ProjectManagementGuard";

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
  const confirmedEditGeneration = useRef<number | null>(null);
  const draftRef = useRef(draft);
  const draftGeneration = useRef(0);
  const discardedDraftGeneration = useRef<number | null>(null);
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
    return activeRef.current && routeRef.current && !access.session.scope.isInvalidated
      && (!unavailableRef.current || revokedAccess.current && current.status === "ready")
      && !access.session.scope.isProjectSuspended(projectId) && current.status !== "unavailable"
      && (current.status !== "ready" || !current.refreshing);
  };
  const waitForPresentation = async (signal: AbortSignal) => {
    const lifetime = AbortSignal.any([signal, access.session.scope.signal]);
    while (true) {
      lifetime.throwIfAborted();
      if (!activeRef.current || !routeRef.current) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { activityWaiters.current.delete(resume); lifetime.removeEventListener("abort", abort); };
        const resume = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(lifetime.reason); };
        activityWaiters.current.add(resume);
        lifetime.addEventListener("abort", abort, { once: true });
      });
      await access.session.waitForFreshAccess(lifetime, true);
      lifetime.throwIfAborted();
      if (canPresent()) return;
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
    if (!submitting.current && !returnRead.current && !confirmedNeedsRead.current && reconciliationNotice.current === null && !uncertainRef.current) {
      guard?.release("settings");
      retention.current?.(false);
    }
  };
  const clearPrivateDraft = () => {
    ++draftGeneration.current; discardedDraftGeneration.current = draftGeneration.current;
    draftVersion.current = null; draftConflictRef.current = false; setDraftConflict(false);
    projectRef.current = null; draftRef.current = "";
    setProject(null); setDraft(""); setInvalid(false);
  };
  const clearPrivate = () => {
    revokedAccess.current = false;
    clearPrivateDraft(); setUncertainState(false); setUnavailableState(true);
    returnRead.current = false; setReturnReadRequired(false);
    confirmedNeedsRead.current = false; confirmedEditGeneration.current = null; confirmedFloor.current = null; setAwaitingSavedRead(false);
    reconciliationNotice.current = null; setReconciliationRequired(false); setWriteError(null);
    releaseResolvedRetention();
  };
  const load = async (lifetime: AbortSignal, nextNotice: SettingsNotice = null) => {
    readController.current?.abort();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal]);
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
      || (!submitting.current && (returning || confirmedNeedsRead.current || reconciliationNotice.current !== null));
    const preserveError = returning || confirmedNeedsRead.current || reconciliationNotice.current !== null;
    const originalDraft = draftGeneration.current;
    // During an unresolved read the version also records an edit back to the
    // old value, so retries cannot mistake it for an explicit cancellation.
    const hadDraftIntent = draftVersion.current !== null
      && (confirmedEditGeneration.current === null || draftGeneration.current !== confirmedEditGeneration.current);
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
      const [saved] = await Promise.all([abortable(getProject(projectId, signal), signal), abortable(access.session.revalidate(), signal)]);
      const admitted = await access.session.waitForFreshAccess(signal);
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current || !currentRoute()) { finishRead("cancelled"); return; }
      if (admitted === null) { pendingSettingsRead.current = true; finishRead("failed"); return; }
      if (confirmedFloor.current !== null && saved.settings.version < confirmedFloor.current) throw new Error("Project settings read is older than the confirmed save");
      if (projectRef.current !== null && saved.settings.version < projectRef.current.settings.version) throw new Error("Project settings read is older than the displayed settings");
      pendingSettingsRead.current = false;
      confirmedFloor.current = null;
      if (activeRef.current && routeRef.current) {
        returnRead.current = false; setReturnReadRequired(false);
      }
      projectRef.current = saved; setProject(saved);
      const keepDraft = preserveDraft && discardedDraftGeneration.current !== draftGeneration.current && (hadDraftIntent || draftGeneration.current !== originalDraft);
      if (!keepDraft) {
        discardedDraftGeneration.current = null;
        draftVersion.current = null;
        draftConflictRef.current = false; setDraftConflict(false);
        const value = String(saved.settings.executionWarningMinutes);
        draftRef.current = value; setDraft(value);
      } else if (draftRef.current === String(saved.settings.executionWarningMinutes)) {
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
      if (nextNotice === "saved") { confirmedNeedsRead.current = false; setAwaitingSavedRead(false); }
      confirmedEditGeneration.current = null;
      if (reconciliationNotice.current !== null && nextNotice === reconciliationNotice.current) {
        reconciliationNotice.current = null; setReconciliationRequired(false); setWriteError(null);
      }
      finishRead("succeeded");
      releaseResolvedRetention();
    } catch (failure) {
      if (signal.aborted || current !== generation.current || isAbortError(failure) || !currentRoute()) { finishRead("cancelled"); return; }
      try { await access.session.scope.ready(signal); } catch { return; }
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current || !currentRoute()) { finishRead("cancelled"); return; }
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 403)) {
        if (uncertainRef.current || reconciliationNotice.current !== null || confirmedNeedsRead.current) {
          revokedAccess.current = false;
          clearPrivateDraft(); setUnavailableState(true); setError(failure);
        } else clearPrivate();
      } else setError(failure);
      finishRead("failed");
    } finally {
      if (routeRead.current?.generation === current && routeRead.current.status === "pending") finishRead("cancelled");
      if (readController.current === read) readController.current = null;
      if (!returning && !signal.aborted && current === generation.current) setLoading(false);
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
    return () => { active.abort(); readController.current?.abort(); confirmedNeedsRead.current = false; pendingSettingsRead.current = false; ++generation.current; };
  }, [projectId, userId]);
  useEffect(() => {
    if (!access.ready || controller.current === null || submitting.current && !reloadAfterRevocation.current) return;
    if (returnRead.current && (!onRoute || !active || readController.current !== null)) return;
    if (confirmedNeedsRead.current) {
      if (!confirmedReadInFlight.current) {
        confirmedReadInFlight.current = true; reloadAfterRevocation.current = false; pendingSettingsRead.current = false;
        void load(controller.current.signal, "saved").finally(() => { confirmedReadInFlight.current = false; });
      }
    } else if (reloadAfterRevocation.current || pendingSettingsRead.current) {
      reloadAfterRevocation.current = false; pendingSettingsRead.current = false;
      void load(controller.current.signal, noticeForRead(returnRead.current ? returnNotice.current : null));
    }
  }, [access.ready, unavailable, access.session, awaitingSavedRead, pending, onRoute, active]);
  useEffect(() => {
    const prior = routeRead.current;
    if (!onRoute || !active || !returnRead.current || admission.current !== null || readController.current !== null || controller.current === null || prior?.route === routeGeneration.current && prior.status !== "cancelled") return;
    retention.current?.(true);
    setReturnReadRequired(true);
    void load(controller.current.signal, noticeForRead(returnNotice.current));
  }, [onRoute, active, pending]);

  const save = async () => {
    const admitted = access.session.snapshot();
    if (!routeRef.current || submitting.current || confirmedNeedsRead.current || reconciliationNotice.current !== null || returnRead.current || draftConflictRef.current || loading || uncertain || admitted.status !== "ready" || admitted.access!.effectiveRole !== "admin" || project === null) return;
    const minutes = parseWarningDraft(draft);
    if (minutes === null) { setInvalid(true); return; }
    if (guard !== undefined && !guard.tryAcquire("settings")) return;
    submitting.current = true; setPending(true); setError(null); setWriteError(null); setNotice(null); setInvalid(false);
    retention.current?.(true);
    const lifetime = controller.current!;
    const operation = { controller: new AbortController(), dispatched: false, confirmed: false };
    admission.current = operation;
    const signal = AbortSignal.any([lifetime.signal, operation.controller.signal]);
    const operationGeneration = generation.current;
    const operationRoute = routeGeneration.current;
    let resultNotice: SettingsNotice = null;
    const ownership = admitted.access!.ownership;
    const expectedVersion = draftVersion.current ?? project.settings.version;
    try {
      const fresh = await abortable(access.session.waitForFreshAccess(signal, true), signal);
      if (signal.aborted || !routeRef.current || operationRoute !== routeGeneration.current || access.session.scope.isInvalidated || operationGeneration !== generation.current || projectRef.current?.settings.version !== project.settings.version) return;
      if (fresh === null) return;
      if (fresh.effectiveRole !== "admin") { setNotice("permission"); return; }
      if (fresh.ownership.teamId !== ownership.teamId || fresh.ownership.version !== ownership.version) { setNotice("conflict"); return; }
      const saved = await saveProjectSettings(projectId, { version: expectedVersion, executionWarningMinutes: minutes }, signal, () => {
        if (!routeRef.current || operationRoute !== routeGeneration.current) throw new DOMException("The settings route changed.", "AbortError");
        operation.dispatched = true;
      });
      operation.confirmed = true;
      // A recovery read that started before this receipt cannot supersede it,
      // even while its publication is waiting for authorization.
      confirmedFloor.current = saved.settings.version;
      do { await waitForPresentation(signal); } while (!canPresent());
      if (signal.aborted || access.session.scope.isInvalidated) return;
      resultNotice = "saved";
      confirmedEditGeneration.current = draftGeneration.current;
      draftVersion.current = null;
      const currentAccess = access.session.snapshot();
      if (currentAccess.status !== "ready" || currentAccess.refreshing) { confirmedNeedsRead.current = true; setAwaitingSavedRead(true); setNotice("saved"); return; }
      ++generation.current;
      if (readController.current !== null) {
        if (routeRead.current?.status === "pending") routeRead.current.status = "cancelled";
        readController.current.abort();
      }
      setLoading(false);
      if (!(returnRead.current && routeRead.current?.route === routeGeneration.current && routeRead.current.status === "failed")) setError(null);
      const freshlyAdmitted = currentAccess.status === "ready" && !currentAccess.refreshing;
      reloadAfterRevocation.current = !freshlyAdmitted;
      if (freshlyAdmitted) { revokedAccess.current = false; setUnavailableState(false); }
      draftVersion.current = null; confirmedEditGeneration.current = null; draftConflictRef.current = false; setDraftConflict(false);
      const currentProject = projectRef.current;
      const latest = currentProject !== null && currentProject.settings.version > saved.settings.version ? currentProject : saved;
      projectRef.current = latest;
      const value = String(latest.settings.executionWarningMinutes);
      draftRef.current = value; setProject(latest); setDraft(value); setNotice("saved");
    } catch (failure) {
      if (signal.aborted || isAbortError(failure)) return;
      try { if (operation.dispatched) { do { await waitForPresentation(signal); } while (!canPresent()); } else await access.session.scope.ready(signal); } catch { return; }
      if (signal.aborted || access.session.scope.isInvalidated) return;
      if (!operation.dispatched) { setError(failure); return; }
      if (failure instanceof ApiError && failure.kind === "server" && failure.status === 404) clearPrivate();
      else if (failure instanceof ApiError && failure.kind === "server" && (failure.status === 409 || failure.status === 403)) {
        resultNotice = failure.status === 409 ? "conflict" : "permission";
        reconciliationNotice.current = resultNotice; setReconciliationRequired(true); setWriteError(failure);
        if (returnRead.current) returnNotice.current = resultNotice;
        await load(signal, resultNotice);
      } else if (failure instanceof ApiError && failure.kind === "server" && failure.status !== null && failure.status >= 400 && failure.status < 500) {
        setWriteError(failure);
        if (unavailableRef.current) {
          returnRead.current = true; returnNotice.current = null; setReturnReadRequired(true);
          await load(signal);
        }
      }
      else {
        // A missing success response cannot prove whether the transaction committed.
        setUncertainState(true);
        resultNotice = "reconciled";
        if (returnRead.current) returnNotice.current = resultNotice;
        await load(signal, "reconciled");
      }
    } finally {
      if (operation.dispatched && !signal.aborted && !access.session.scope.isInvalidated && (!activeRef.current || !routeRef.current || routeGeneration.current !== operationRoute)) {
        try {
          while (true) {
            await waitForPresentation(signal);
            if (!canPresent()) continue;
            const route = routeGeneration.current;
            if (route !== operationRoute && !(routeRead.current?.route === route && routeRead.current.status === "succeeded")) {
              returnRead.current = true; returnNotice.current = noticeForRead(resultNotice); setReturnReadRequired(true);
              if (routeRead.current?.route !== route || routeRead.current.status === "cancelled") await load(signal, noticeForRead(resultNotice));
              if (!canPresent() || routeGeneration.current !== route) continue;
            }
            break;
          }
        } catch { /* The owning scope was retired while the result was waiting. */ }
      }
      if (admission.current === operation) admission.current = null;
      if (!lifetime.signal.aborted) { submitting.current = false; setPending(false); releaseResolvedRetention(); }
    }
  };

  const change = (value: string) => {
    ++draftGeneration.current;
    discardedDraftGeneration.current = null;
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
    ++draftGeneration.current; discardedDraftGeneration.current = draftGeneration.current;
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
    project: unavailable || access.status === "unavailable" ? null : project, role, draft, canSubmit: access.status === "ready" && !awaitingSavedRead && !returnReadRequired && !returnRead.current && !draftConflict && !reconciliationRequired, loading: loading || access.status === "loading", pending, unavailable: unavailable || access.status === "unavailable", uncertain: !unavailable && access.status !== "unavailable" && uncertain, error: error ?? access.error, writeError: unavailable || access.status === "unavailable" ? null : writeError, reconciliation: !unavailable && access.status !== "unavailable" && reconciliationRequired ? reconciliationNotice.current : null, draftConflict, invalid, notice: unavailable || access.status === "unavailable" ? null : notice,
    dirty: project !== null && (draftVersion.current !== null || draft !== String(project.settings.executionWarningMinutes)),
    change,
    cancel,
    retry: () => {
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
