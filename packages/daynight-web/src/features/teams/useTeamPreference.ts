import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { canonicalId } from "../../api/validation";
import type { TeamRef } from "../../api/auth-types";
import { getTeam } from "../../api/teams";
import { replaceRoute } from "../../app/router";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

type Detail = { readonly id: string; readonly status: "loading" | "ready" | "error"; readonly team?: TeamRef; readonly error?: unknown; readonly storageError?: boolean };
type State = { readonly key: string | null; readonly detail: Detail };
export type TeamPreference = ReturnType<typeof useTeamPreference>;

// The key is scoped to the authenticated user; localStorage is already origin-scoped.
export const teamPreferenceKey = (userId: string) => `daynight.selectedTeam:${userId}`;

export const useTeamPreference = (personal: TeamRef, routeKey: string | null, admission: TaskCacheScope, blocked: boolean) => {
  const [state, setState] = useState<State>(() => ({ key: null, detail: { id: personal.id, status: "ready", team: personal } }));
  const current = useRef<TeamRef>(personal);
  const pendingSave = useRef<TeamRef | null>(null);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const routeRef = useRef({ key: routeKey, blocked, epoch: 0, navigation: 0 });
  if (routeRef.current.key !== routeKey || routeRef.current.blocked !== blocked) routeRef.current = { key: routeKey, blocked, epoch: routeRef.current.epoch + 1, navigation: routeRef.current.navigation + (routeRef.current.key === routeKey ? 0 : 1) };
  const epoch = routeRef.current.epoch;
  const navigation = routeRef.current.navigation;
  const savedNavigation = useRef<number | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const save = useCallback((team: TeamRef) => {
    try {
      window.localStorage.setItem(teamPreferenceKey(admission.userId), team.id);
      pendingSave.current = null;
      setSaveError(false);
    } catch {
      pendingSave.current = team;
      setSaveError(true);
    }
  }, [admission.userId]);
  const retrySave = useCallback(() => { if (pendingSave.current !== null) save(pendingSave.current); }, [save]);
  useEffect(() => {
    if (routeKey === null || blocked) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const key = routeKey;
    const valid = () => !signal.aborted && !admission.isInvalidated && !blockedRef.current && routeRef.current.epoch === epoch;
    const install = (team: TeamRef) => {
      if (!valid()) return;
      current.current = team;
      setState({ key, detail: { id: team.id, status: "ready", team } });
    };
    const fail = (id: string, error: unknown, storageError = false) => {
      if (valid()) setState({ key, detail: { id, status: "error", error, storageError } });
    };
    setState({ key, detail: { id: key === "default" ? current.current.id : key, status: "loading" } });
    void (async () => {
      let id: string;
      let remembered = false;
      let pending = false;
      if (key === "default") {
        if (pendingSave.current !== null) {
          id = pendingSave.current.id; remembered = true; pending = true;
        } else {
          let saved: string | null;
          try { saved = window.localStorage.getItem(teamPreferenceKey(admission.userId)); }
          catch (error) { fail(current.current.id, error, true); return; }
          if (saved === null) { install(personal); return; }
          const parsed = canonicalId(saved);
          if (parsed === null || parsed !== saved) { fail(current.current.id, new Error("Invalid saved Team ID"), true); return; }
          id = parsed; remembered = true;
        }
      } else {
        id = key;
        if (id === personal.id) { if (valid()) { install(personal); if (savedNavigation.current !== navigation) { save(personal); savedNavigation.current = navigation; } } return; }
      }
      try {
        await admission.ready(signal);
        const team = await getTeam(id, admission.userId, signal, admission.principalMismatch);
        await admission.ready(signal);
        if (!valid()) return;
        install(team);
        if (!remembered && savedNavigation.current !== navigation) { save(team); savedNavigation.current = navigation; }
      } catch (error) {
        if (!valid()) return;
        try { await admission.ready(signal); } catch { return; }
        if (!valid()) return;
        if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
          try {
            const storageKey = teamPreferenceKey(admission.userId);
            const saved = window.localStorage.getItem(storageKey);
            const pendingSelection = pending || pendingSave.current?.id === id;
            if (!remembered && saved !== id && !pendingSelection) { fail(id, error); return; }
            if (remembered && !pendingSelection && saved !== id) { retry(); return; }
            if (saved === id) window.localStorage.removeItem(storageKey);
            if (pendingSelection) { pendingSave.current = personal; setSaveError(true); }
          }
          catch (storageError) { fail(id, storageError, true); return; }
          install(personal);
          if (key !== "default") replaceRoute("/projects");
        } else fail(id, error);
      }
    })();
    return () => controller.abort();
  }, [routeKey, epoch, navigation, blocked, revision, admission, personal.id, personal.kind, personal.name, save, retry]);
  const detail: Detail = routeKey === null ? { id: current.current.id, status: "ready", team: current.current } : state.key !== routeKey ? { id: routeKey === "default" ? current.current.id : routeKey, status: "loading" } : state.detail;
  return { detail, retry, saveError, retrySave };
};
