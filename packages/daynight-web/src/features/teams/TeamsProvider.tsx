import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isAbortError } from "../../api/client";
import { listTeams, type Team } from "../../api/teams";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import type { TeamPreference } from "./useTeamPreference";

type List = { readonly items: readonly Team[]; readonly cursor: string | null; readonly status: "loading" | "ready" | "error"; readonly more: boolean; readonly moreError: unknown; readonly error: unknown };
const initial: List = { items: [], cursor: null, status: "loading", more: false, moreError: null, error: null };
const TeamsContext = createContext<ReturnType<typeof useTeamsState> | null>(null);

const useTeamsState = (preference: TeamPreference, admission: TaskCacheScope, admissionBlocked: boolean) => {
  const [list, setList] = useState<List>(initial);
  const listRequest = useRef<AbortController | null>(null);
  const listGeneration = useRef(0);
  const blocked = useRef(admissionBlocked); blocked.current = admissionBlocked;
  const load = useCallback(async (cursor: string | null) => {
    if (blocked.current || admission.isInvalidated) return;
    listRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const generation = ++listGeneration.current;
    setList((previous) => cursor === null ? initial : { ...previous, more: true, moreError: null });
    try {
      await admission.ready(signal);
      const page = await listTeams(cursor, admission.userId, signal, admission.principalMismatch);
      await admission.ready(signal);
      if (signal.aborted || blocked.current || generation !== listGeneration.current) return;
      setList((previous) => blocked.current || admission.isInvalidated ? previous : ({ items: cursor === null ? page.items : [...previous.items, ...page.items.filter((item) => !previous.items.some((old) => old.id === item.id))], cursor: page.nextCursor, status: "ready", more: false, moreError: null, error: null }));
    } catch (error) {
      if (signal.aborted || admission.isInvalidated || isAbortError(error)) return;
      try { await admission.ready(signal); } catch { return; }
      if (signal.aborted || blocked.current || generation !== listGeneration.current) return;
      setList((previous) => blocked.current || admission.isInvalidated ? previous : cursor === null ? { ...initial, status: "error", error } : { ...previous, more: false, moreError: error });
    } finally { if (listRequest.current === controller) listRequest.current = null; }
  }, [admission]);
  useEffect(() => { if (!admissionBlocked) void load(null); return () => { ++listGeneration.current; listRequest.current?.abort(); listRequest.current = null; }; }, [load, admissionBlocked]);
  return { list, detail: preference.detail, forgetUnavailable: preference.forgetUnavailable, refreshList: () => { void load(null); }, loadMore: () => { if (list.cursor !== null && listRequest.current === null) void load(list.cursor); }, refreshDetail: preference.retry, acceptTeam: preference.acceptTeam };
};
export const TeamsProvider = ({ preference, admission, admissionBlocked, children }: { readonly preference: TeamPreference; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly children: ReactNode }) => {
  const state = useTeamsState(preference, admission, admissionBlocked);
  return <TeamsContext.Provider value={state}>{children}</TeamsContext.Provider>;
};
export const useTeams = () => { const state = useContext(TeamsContext); if (state === null) throw new Error("Team browsing requires a TeamsProvider."); return state; };
