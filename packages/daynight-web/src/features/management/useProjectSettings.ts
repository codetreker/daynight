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
  const role = access.ready ? access.access!.effectiveRole : null;
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice>(null);
  const controller = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const reloadAfterRevocation = useRef(false);
  const generation = useRef(0);
  const submitting = useRef(false);

  const clearPrivate = () => { setProject(null); setDraft(""); setUncertain(false); setUnavailable(true); };
  const load = async (lifetime: AbortSignal, nextNotice: SettingsNotice = null) => {
    readController.current?.abort();
    const read = new AbortController(); readController.current = read;
    const signal = AbortSignal.any([lifetime, read.signal, access.session.scope.signal]);
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      const [saved] = await Promise.all([getProject(projectId, signal), access.session.revalidate()]);
      if (signal.aborted || current !== generation.current || access.session.snapshot().status === "unavailable") return;
      setProject(saved); setDraft(String(saved.settings.executionWarningMinutes));
      setUnavailable(false); setUncertain(false); setInvalid(false); setNotice(nextNotice);
    } catch (failure) {
      if (signal.aborted || current !== generation.current || isAbortError(failure)) return;
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
    return () => { active.abort(); readController.current?.abort(); ++generation.current; };
  }, [projectId, userId]);
  useEffect(() => {
    if (!access.ready || !reloadAfterRevocation.current || controller.current === null) return;
    reloadAfterRevocation.current = false;
    void load(controller.current.signal);
  }, [access.ready, unavailable, access.session]);

  const save = async () => {
    const admitted = access.session.snapshot();
    if (submitting.current || loading || uncertain || admitted.status !== "ready" || admitted.refreshing || admitted.access!.effectiveRole !== "admin" || project === null) return;
    const minutes = parseWarningDraft(draft);
    if (minutes === null) { setInvalid(true); return; }
    submitting.current = true; setPending(true); setError(null); setNotice(null); setInvalid(false);
    const signal = controller.current!.signal;
    try {
      const saved = await saveProjectSettings(projectId, { version: project.settings.version, executionWarningMinutes: minutes }, signal);
      if (signal.aborted) return;
      ++generation.current; readController.current?.abort();
      setLoading(false); setError(null);
      const currentAccess = access.session.snapshot();
      const freshlyAdmitted = currentAccess.status === "ready" && !currentAccess.refreshing;
      reloadAfterRevocation.current = !freshlyAdmitted;
      if (freshlyAdmitted) setUnavailable(false);
      setProject(saved); setDraft(String(saved.settings.executionWarningMinutes)); setNotice("saved");
    } catch (failure) {
      if (signal.aborted || isAbortError(failure)) return;
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
    project: unavailable || access.status === "unavailable" ? null : project, role, draft, loading: loading || access.status === "loading", pending, unavailable: unavailable || access.status === "unavailable", uncertain, error: error ?? access.error, invalid, notice,
    dirty: project !== null && draft !== String(project.settings.executionWarningMinutes),
    change: (value: string) => { setDraft(value); setInvalid(false); setNotice(null); setError(null); },
    cancel: () => { if (project !== null && !pending && !uncertain) { setDraft(String(project.settings.executionWarningMinutes)); setInvalid(false); setError(null); setNotice("cancelled"); } },
    retry: () => {
      if (submitting.current) return;
      if (error === null && project !== null && !uncertain) void access.session.revalidate();
      else void load(controller.current!.signal, uncertain ? "reconciled" : null);
    },
    save,
  };
};
