import { useEffect, useRef, useState } from "react";
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

export const useProjectSettings = (projectId: string, userId: string) => {
  const [project, setProject] = useState<Project | null>(null);
  const access = useProjectAccess(projectId);
  const role = access.status === "ready" ? access.access!.effectiveRole : null;
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice>(null);
  const [awaitingSavedRead, setAwaitingSavedRead] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const reloadAfterRevocation = useRef(false);
  const confirmedNeedsRead = useRef(false);
  const pendingSettingsRead = useRef(false);
  const confirmedReadInFlight = useRef(false);
  const generation = useRef(0);
  const submitting = useRef(false);
  const projectRef = useRef(project);
  projectRef.current = project;

  const clearPrivate = () => { setProject(null); setDraft(""); setUncertain(false); setUnavailable(true); };
  const load = async (lifetime: AbortSignal, nextNotice: SettingsNotice = null) => {
    readController.current?.abort();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal]);
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      const [saved] = await Promise.all([getProject(projectId, signal), access.session.revalidate()]);
      const admitted = await access.session.waitForFreshAccess(signal);
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current) return;
      if (admitted === null) { pendingSettingsRead.current = true; return; }
      pendingSettingsRead.current = false;
      setProject(saved); setDraft(String(saved.settings.executionWarningMinutes));
      setUnavailable(false); setUncertain(false); setInvalid(false); setNotice(nextNotice);
      if (nextNotice === "saved") { confirmedNeedsRead.current = false; setAwaitingSavedRead(false); }
    } catch (failure) {
      if (signal.aborted || current !== generation.current || isAbortError(failure)) return;
      try { await access.session.scope.ready(signal); } catch { return; }
      if (signal.aborted || access.session.scope.isInvalidated || current !== generation.current) return;
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 403)) clearPrivate();
      else setError(failure);
    } finally {
      if (readController.current === read) readController.current = null;
      if (!signal.aborted && current === generation.current) setLoading(false);
    }
  };

  useEffect(() => access.session.scope.subscribe((event) => {
    if (event.projectId !== projectId || !event.accessRevoked) return;
    ++generation.current; readController.current?.abort();
    reloadAfterRevocation.current = true;
    setProject(null); setDraft(""); setUnavailable(true); setLoading(false); setError(null);
  }), [projectId, access.session]);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    void load(active.signal);
    return () => { active.abort(); readController.current?.abort(); confirmedNeedsRead.current = false; pendingSettingsRead.current = false; ++generation.current; };
  }, [projectId, userId]);
  useEffect(() => {
    if (!access.ready || controller.current === null) return;
    if (confirmedNeedsRead.current) {
      if (!confirmedReadInFlight.current) {
        confirmedReadInFlight.current = true; reloadAfterRevocation.current = false;
        void load(controller.current.signal, "saved").finally(() => { confirmedReadInFlight.current = false; });
      }
    } else if (reloadAfterRevocation.current || pendingSettingsRead.current) {
      reloadAfterRevocation.current = false; pendingSettingsRead.current = false;
      void load(controller.current.signal);
    }
  }, [access.ready, unavailable, access.session, awaitingSavedRead]);

  const save = async () => {
    const admitted = access.session.snapshot();
    if (submitting.current || confirmedNeedsRead.current || loading || uncertain || admitted.status !== "ready" || admitted.access!.effectiveRole !== "admin" || project === null) return;
    const minutes = parseWarningDraft(draft);
    if (minutes === null) { setInvalid(true); return; }
    submitting.current = true; setPending(true); setError(null); setNotice(null); setInvalid(false);
    const signal = controller.current!.signal;
    const operationGeneration = generation.current;
    const ownership = admitted.access!.ownership;
    let dispatched = false;
    try {
      const fresh = await access.session.waitForFreshAccess(signal, true);
      if (signal.aborted || access.session.scope.isInvalidated || operationGeneration !== generation.current || projectRef.current?.settings.version !== project.settings.version) return;
      if (fresh === null) return;
      if (fresh.effectiveRole !== "admin") { setNotice("permission"); return; }
      if (fresh.ownership.teamId !== ownership.teamId || fresh.ownership.version !== ownership.version) { setNotice("conflict"); return; }
      dispatched = true;
      const saved = await saveProjectSettings(projectId, { version: project.settings.version, executionWarningMinutes: minutes }, signal);
      await access.session.scope.ready(signal);
      if (signal.aborted || access.session.scope.isInvalidated) return;
      await access.session.waitForFreshAccess(signal);
      if (signal.aborted || access.session.scope.isInvalidated) return;
      const currentAccess = access.session.snapshot();
      if (currentAccess.status !== "ready" || currentAccess.refreshing) { confirmedNeedsRead.current = true; setAwaitingSavedRead(true); setNotice("saved"); return; }
      ++generation.current; readController.current?.abort();
      setLoading(false); setError(null);
      const freshlyAdmitted = currentAccess.status === "ready" && !currentAccess.refreshing;
      reloadAfterRevocation.current = !freshlyAdmitted;
      if (freshlyAdmitted) setUnavailable(false);
      setProject(saved); setDraft(String(saved.settings.executionWarningMinutes)); setNotice("saved");
    } catch (failure) {
      if (signal.aborted || isAbortError(failure)) return;
      try { await access.session.scope.ready(signal); } catch { return; }
      if (signal.aborted || access.session.scope.isInvalidated) return;
      if (!dispatched) { setError(failure); return; }
      if (failure instanceof ApiError && failure.kind === "server" && failure.status === 404) clearPrivate();
      else if (failure instanceof ApiError && failure.kind === "server" && (failure.status === 409 || failure.status === 403)) {
        await load(signal, failure.status === 409 ? "conflict" : "permission");
      } else if (failure instanceof ApiError && failure.kind === "server" && failure.status !== null && failure.status >= 400 && failure.status < 500) setError(failure);
      else {
        // A missing success response cannot prove whether the transaction committed.
        setUncertain(true);
        await load(signal, "reconciled");
      }
    } finally { if (!signal.aborted) { submitting.current = false; setPending(false); } }
  };

  return {
    project: unavailable || access.status === "unavailable" ? null : project, role, draft, canSubmit: !awaitingSavedRead, loading: loading || access.status === "loading", pending, unavailable: unavailable || access.status === "unavailable", uncertain, error: error ?? access.error, invalid, notice,
    dirty: project !== null && draft !== String(project.settings.executionWarningMinutes),
    change: (value: string) => { setDraft(value); setInvalid(false); setNotice(null); setError(null); },
    cancel: () => { if (project !== null && !pending && !uncertain) { setDraft(String(project.settings.executionWarningMinutes)); setInvalid(false); setError(null); setNotice("cancelled"); } },
    retry: () => {
      if (submitting.current) return;
      if (confirmedNeedsRead.current) {
        if (access.ready) void load(controller.current!.signal, "saved");
        else void access.session.revalidate();
      } else if (error === null && project !== null && !uncertain) void access.session.revalidate();
      else void load(controller.current!.signal, uncertain ? "reconciled" : null);
    },
    save,
  };
};
