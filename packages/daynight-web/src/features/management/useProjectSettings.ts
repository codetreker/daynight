import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useProjectAccess } from "../projects/ProjectAccess";
import { ApiError, isAbortError } from "../../api/client";
import { getProject, isExecutionWarningMinutes, saveProjectSettings } from "../../api/project-settings";
import type { Project } from "../../api/types";

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

export const useProjectSettings = (projectId: string, userId: string, onRoute: boolean, active: boolean, onRetentionChange?: (retain: boolean) => void) => {
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
  const admission = useRef<{ readonly controller: AbortController; dispatched: boolean } | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const activityWaiters = useRef(new Set<() => void>());
  const lastReadRoute = useRef(-1);
  const lastAttemptedReadRoute = useRef(-1);
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
      if (activeRef.current && routeRef.current) return;
    }
  };

  useEffect(() => {
    if (!onRoute && admission.current !== null && !admission.current.dispatched) admission.current.controller.abort();
  }, [onRoute]);

  const setUncertainState = (value: boolean) => { uncertainRef.current = value; setUncertain(value); };
  const releaseResolvedRetention = () => {
    if (!submitting.current && !returnRead.current && !confirmedNeedsRead.current && reconciliationNotice.current === null && !uncertainRef.current) retention.current?.(false);
  };
  const clearPrivate = () => {
    projectRef.current = null; draftRef.current = "";
    setProject(null); setDraft(""); setUncertainState(false); setUnavailable(true);
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
    lastAttemptedReadRoute.current = route;
    // Every re-entry read, including retries and access recovery, uses the
    // same route/version guards and preserves edits made while it is pending.
    const returning = returnRead.current;
    const preserveDraft = !submitting.current && (returning || confirmedNeedsRead.current || reconciliationNotice.current !== null);
    const preserveError = returning || confirmedNeedsRead.current || reconciliationNotice.current !== null;
    const originalDraft = draftGeneration.current;
    const wasDirty = projectRef.current !== null && draftRef.current !== String(projectRef.current.settings.executionWarningMinutes)
      && (confirmedEditGeneration.current === null || draftGeneration.current !== confirmedEditGeneration.current);
    const currentRoute = () => routeGeneration.current === route && (!returning || activeRef.current && routeRef.current);
    if (!returning) setLoading(true);
    if (!preserveError) setError(null);
    try {
      const [saved] = await Promise.all([getProject(projectId, signal), access.session.revalidate()]);
      const admitted = await access.session.waitForFreshAccess(signal);
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current || !currentRoute()) return;
      if (admitted === null) { pendingSettingsRead.current = true; return; }
      if (confirmedFloor.current !== null && saved.settings.version < confirmedFloor.current) throw new Error("Project settings read is older than the confirmed save");
      if (projectRef.current !== null && saved.settings.version < projectRef.current.settings.version) throw new Error("Project settings read is older than the displayed settings");
      pendingSettingsRead.current = false;
      confirmedFloor.current = null;
      if (activeRef.current && routeRef.current) {
        lastReadRoute.current = routeGeneration.current;
        returnRead.current = false; setReturnReadRequired(false);
      }
      projectRef.current = saved; setProject(saved);
      const keepDraft = preserveDraft && discardedDraftGeneration.current !== draftGeneration.current && (wasDirty || draftGeneration.current !== originalDraft);
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
      setUnavailable(false); setUncertainState(false);
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
      releaseResolvedRetention();
    } catch (failure) {
      if (signal.aborted || current !== generation.current || isAbortError(failure) || !currentRoute()) return;
      try { await access.session.scope.ready(signal); } catch { return; }
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current || !currentRoute()) return;
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 403)) clearPrivate();
      else setError(failure);
    } finally {
      if (readController.current === read) readController.current = null;
      if (!returning && !signal.aborted && current === generation.current) setLoading(false);
    }
  };

  useEffect(() => access.session.scope.subscribe((event) => {
    if (event.projectId !== projectId || !event.accessRevoked) return;
    ++generation.current; readController.current?.abort();
    admission.current?.controller.abort(); retention.current?.(false);
    returnRead.current = false; setReturnReadRequired(false); confirmedFloor.current = null;
    reconciliationNotice.current = null; setReconciliationRequired(false);
    confirmedNeedsRead.current = false; confirmedEditGeneration.current = null;
    setAwaitingSavedRead(false); setUncertainState(false); setNotice(null);
    draftVersion.current = null; draftConflictRef.current = false; setDraftConflict(false);
    setWriteError(null);
    reloadAfterRevocation.current = true;
    projectRef.current = null; draftRef.current = "";
    setProject(null); setDraft(""); setUnavailable(true); setLoading(false); setError(null);
  }), [projectId, access.session]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    void load(active.signal);
    return () => { active.abort(); readController.current?.abort(); confirmedNeedsRead.current = false; pendingSettingsRead.current = false; ++generation.current; };
  }, [projectId, userId]);
  useEffect(() => {
    if (!access.ready || controller.current === null || submitting.current) return;
    if (returnRead.current && (!onRoute || !active || readController.current !== null)) return;
    if (confirmedNeedsRead.current) {
      if (!confirmedReadInFlight.current) {
        confirmedReadInFlight.current = true; reloadAfterRevocation.current = false;
        void load(controller.current.signal, "saved").finally(() => { confirmedReadInFlight.current = false; });
      }
    } else if (reloadAfterRevocation.current || pendingSettingsRead.current) {
      reloadAfterRevocation.current = false; pendingSettingsRead.current = false;
      void load(controller.current.signal, noticeForRead(returnRead.current ? returnNotice.current : null));
    }
  }, [access.ready, unavailable, access.session, awaitingSavedRead, pending, onRoute, active]);
  useEffect(() => {
    if (!onRoute || !active || !returnRead.current || admission.current !== null || readController.current !== null || controller.current === null || lastAttemptedReadRoute.current === routeGeneration.current) return;
    retention.current?.(true);
    setReturnReadRequired(true);
    void load(controller.current.signal, noticeForRead(returnNotice.current));
  }, [onRoute, active, pending]);

  const save = async () => {
    const admitted = access.session.snapshot();
    if (!routeRef.current || submitting.current || confirmedNeedsRead.current || reconciliationNotice.current !== null || returnRead.current || draftConflictRef.current || loading || uncertain || admitted.status !== "ready" || admitted.access!.effectiveRole !== "admin" || project === null) return;
    const minutes = parseWarningDraft(draft);
    if (minutes === null) { setInvalid(true); return; }
    submitting.current = true; setPending(true); setError(null); setWriteError(null); setNotice(null); setInvalid(false);
    retention.current?.(true);
    const lifetime = controller.current!;
    const operation = { controller: new AbortController(), dispatched: false };
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
      do { await waitForPresentation(signal); } while (!routeRef.current || !activeRef.current);
      if (signal.aborted || access.session.scope.isInvalidated) return;
      resultNotice = "saved";
      confirmedFloor.current = saved.settings.version;
      confirmedEditGeneration.current = draftGeneration.current;
      draftVersion.current = null;
      const currentAccess = access.session.snapshot();
      if (currentAccess.status !== "ready" || currentAccess.refreshing) { confirmedNeedsRead.current = true; setAwaitingSavedRead(true); setNotice("saved"); return; }
      ++generation.current; readController.current?.abort();
      setLoading(false); setError(null);
      const freshlyAdmitted = currentAccess.status === "ready" && !currentAccess.refreshing;
      reloadAfterRevocation.current = !freshlyAdmitted;
      if (freshlyAdmitted) setUnavailable(false);
      draftVersion.current = null; confirmedEditGeneration.current = null; draftConflictRef.current = false; setDraftConflict(false);
      projectRef.current = saved;
      const value = String(saved.settings.executionWarningMinutes);
      draftRef.current = value; setProject(saved); setDraft(value); setNotice("saved");
    } catch (failure) {
      if (signal.aborted || isAbortError(failure)) return;
      try { if (operation.dispatched) { do { await waitForPresentation(signal); } while (!routeRef.current || !activeRef.current); } else await access.session.scope.ready(signal); } catch { return; }
      if (signal.aborted || access.session.scope.isInvalidated) return;
      if (!operation.dispatched) { setError(failure); return; }
      if (failure instanceof ApiError && failure.kind === "server" && failure.status === 404) clearPrivate();
      else if (failure instanceof ApiError && failure.kind === "server" && (failure.status === 409 || failure.status === 403)) {
        resultNotice = failure.status === 409 ? "conflict" : "permission";
        reconciliationNotice.current = resultNotice; setReconciliationRequired(true); setWriteError(failure);
        if (returnRead.current) returnNotice.current = resultNotice;
        await load(signal, resultNotice);
      } else if (failure instanceof ApiError && failure.kind === "server" && failure.status !== null && failure.status >= 400 && failure.status < 500) setWriteError(failure);
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
            if (!activeRef.current || !routeRef.current) continue;
            const route = routeGeneration.current;
            if (route !== operationRoute && lastReadRoute.current !== route) {
              returnRead.current = true; returnNotice.current = noticeForRead(resultNotice); setReturnReadRequired(true);
              if (lastAttemptedReadRoute.current !== route) await load(signal, noticeForRead(resultNotice));
              if (!activeRef.current || !routeRef.current || routeGeneration.current !== route) continue;
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
      if (!confirmedNeedsRead.current && value === String(projectRef.current.settings.executionWarningMinutes)) draftVersion.current = null;
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

  return {
    project: unavailable || access.status === "unavailable" ? null : project, role, draft, canSubmit: access.status === "ready" && !awaitingSavedRead && !returnReadRequired && !returnRead.current && !draftConflict && !reconciliationRequired, loading: loading || access.status === "loading", pending, unavailable: unavailable || access.status === "unavailable", uncertain, error: error ?? access.error, writeError, reconciliation: reconciliationRequired ? reconciliationNotice.current : null, draftConflict, invalid, notice,
    dirty: project !== null && draft !== String(project.settings.executionWarningMinutes),
    change,
    cancel,
    retry: () => {
      if (submitting.current) return;
      if (returnRead.current) {
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
