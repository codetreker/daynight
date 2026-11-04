import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { canonicalId } from "../../api/validation";
import type { TeamRef } from "../../api/auth-types";
import { getTeam, type Team } from "../../api/teams";
import { replaceRoute } from "../../app/router";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

type Detail = { readonly id: string; readonly status: "loading" | "ready" | "error"; readonly team?: TeamRef; readonly error?: unknown; readonly storageError?: boolean };
type State = { readonly key: string | null; readonly detail: Detail };
type PendingSave = { readonly team: TeamRef; readonly replaces: string | null };
export type TeamPreference = ReturnType<typeof useTeamPreference>;
const PreferenceContext = createContext<TeamPreference | null>(null);

export const TeamPreferenceProvider = ({ personal, routeKey, admission, blocked, preserveOnRevalidation = false, guardUnavailable, children }: { readonly personal: TeamRef; readonly routeKey: string | null; readonly admission: TaskCacheScope; readonly blocked: boolean; readonly preserveOnRevalidation?: boolean; readonly guardUnavailable?: (teamId: string) => boolean; readonly children: ReactNode }) => {
  const preference = useTeamPreference(personal, routeKey, admission, blocked, preserveOnRevalidation, guardUnavailable);
  return createElement(PreferenceContext.Provider, { value: preference }, children);
};
export const useCurrentTeamPreference = () => {
  const preference = useContext(PreferenceContext);
  if (preference === null) throw new Error("Team preference requires a TeamPreferenceProvider.");
  return preference;
};

// The key is scoped to the authenticated user; localStorage is already origin-scoped.
export const teamPreferenceKey = (userId: string) => `daynight.selectedTeam:${userId}`;

export const useTeamPreference = (personal: TeamRef, routeKey: string | null, admission: TaskCacheScope, blocked: boolean, preserveOnRevalidation = false, guardUnavailable?: (teamId: string) => boolean) => {
  const [state, setState] = useState<State>(() => ({ key: null, detail: { id: personal.id, status: "ready", team: personal } }));
  const current = useRef<TeamRef>(personal);
  const pendingSave = useRef<PendingSave | null>(null);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const routeRef = useRef({ key: routeKey, blocked, epoch: 0, navigation: 0 });
  if (routeRef.current.key !== routeKey || routeRef.current.blocked !== blocked) routeRef.current = { key: routeKey, blocked, epoch: routeRef.current.epoch + 1, navigation: routeRef.current.navigation + (routeRef.current.key === routeKey ? 0 : 1) };
  const epoch = routeRef.current.epoch;
  const navigation = routeRef.current.navigation;
  const savedNavigation = useRef<number | null>(null);
  const verified = useRef<{ navigation: number; revision: number } | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const save = useCallback((team: TeamRef, replaces: string | null = null) => {
    if (replaces !== null && pendingSave.current !== null && pendingSave.current.team.id !== replaces && pendingSave.current.replaces !== replaces) return;
    try {
      const key = teamPreferenceKey(admission.userId);
      // Departure fallback and its retry only replace the departed Team's saved choice.
      if (replaces === null || window.localStorage.getItem(key) === replaces) window.localStorage.setItem(key, team.id);
      pendingSave.current = null;
      setSaveError(false);
    } catch {
      pendingSave.current = { team, replaces };
      setSaveError(true);
    }
  }, [admission.userId]);
  const retrySave = useCallback(() => { if (pendingSave.current !== null) save(pendingSave.current.team, pendingSave.current.replaces); }, [save]);
  useEffect(() => {
    if (routeKey === null || blocked) return;
    if (preserveOnRevalidation && verified.current?.navigation === navigation && verified.current.revision === revision) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const key = routeKey;
    const valid = () => !signal.aborted && !admission.isInvalidated && !blockedRef.current && routeRef.current.epoch === epoch;
    const install = (team: TeamRef) => {
      if (!valid()) return;
      current.current = team; verified.current = { navigation, revision };
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
          id = pendingSave.current.team.id; remembered = true; pending = true;
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
          if (guardUnavailable?.(id)) { fail(id, error); return; }
          try {
            const storageKey = teamPreferenceKey(admission.userId);
            const saved = window.localStorage.getItem(storageKey);
            const pendingSelection = pending || pendingSave.current?.team.id === id;
            if (!remembered && saved !== id && !pendingSelection) { fail(id, error); return; }
            if (remembered && !pendingSelection && saved !== id) { retry(); return; }
            if (saved === id) window.localStorage.removeItem(storageKey);
            if (pendingSelection) { pendingSave.current = { team: personal, replaces: null }; setSaveError(true); }
          }
          catch (storageError) { fail(id, storageError, true); return; }
          install(personal);
          if (key !== "default") replaceRoute("/projects");
        } else fail(id, error);
      }
    })();
    return () => controller.abort();
  }, [routeKey, epoch, navigation, blocked, revision, admission, personal.id, personal.kind, personal.name, save, retry, preserveOnRevalidation, guardUnavailable]);
  const acceptTeam = useCallback((team: Team) => {
    if (admission.isInvalidated || current.current.id !== team.id) return;
    current.current = team;
    setState((previous) => previous.detail.id === team.id && previous.detail.status === "ready"
      ? { ...previous, detail: { id: team.id, status: "ready", team } } : previous);
  }, [admission]);
  const forgetUnavailable = useCallback((id: string): "forgotten" | "changed" | "storage_error" => {
    if (admission.isInvalidated || current.current.id !== id) return "changed";
    try {
      const key = teamPreferenceKey(admission.userId), saved = window.localStorage.getItem(key);
      const pending = pendingSave.current?.team.id === id;
      if (saved !== id && !pending) return "changed";
      if (saved === id) window.localStorage.removeItem(key);
      if (pending) { pendingSave.current = { team: personal, replaces: null }; setSaveError(true); }
      return "forgotten";
    } catch { return "storage_error"; }
  }, [admission, personal]);
  const leaveTeam = useCallback((id: string) => {
    const key = routeRef.current.key;
    if (admission.isInvalidated || current.current.id !== id || key !== null && key !== "default" && key !== id) return;
    current.current = personal;
    if (pendingSave.current?.team.id === id) pendingSave.current = null;
    save(personal, id);
    if (key === "default") retry();
  }, [admission, personal, save, retry]);
  const detail: Detail = routeKey === null ? { id: current.current.id, status: "ready", team: current.current } : state.key !== routeKey ? { id: routeKey === "default" ? current.current.id : routeKey, status: "loading" } : state.detail;
  return { detail, retry, saveError, retrySave, acceptTeam, forgetUnavailable, leaveTeam };
};
