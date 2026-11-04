import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isAbortError } from "../../api/client";
import type { TeamRef } from "../../api/auth-types";
import { getTeam, listTeams, type Team } from "../../api/teams";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

type List = { readonly items: readonly Team[]; readonly cursor: string | null; readonly status: "loading" | "ready" | "error"; readonly more: boolean; readonly moreError: unknown; readonly error: unknown };
type Detail = { readonly id: string; readonly epoch: number; readonly status: "loading" | "ready" | "error"; readonly team?: TeamRef; readonly error?: unknown };
const initial: List = { items: [], cursor: null, status: "loading", more: false, moreError: null, error: null };
const TeamsContext = createContext<ReturnType<typeof useTeamsState> | null>(null);

const useTeamsState = (personalTeam: TeamRef, selectedId: string, admission: TaskCacheScope, admissionBlocked: boolean) => {
  const [list, setList] = useState<List>(initial);
  const [detail, setDetail] = useState<Detail>({ id: selectedId, epoch: 0, status: "loading" });
  const selection = useRef({ id: selectedId, epoch: 0 });
  if (selection.current.id !== selectedId) selection.current = { id: selectedId, epoch: selection.current.epoch + 1 };
  const epoch = selection.current.epoch;
  const listRequest = useRef<AbortController | null>(null);
  const listGeneration = useRef(0);
  const blocked = useRef(admissionBlocked); blocked.current = admissionBlocked;
  const [revision, setRevision] = useState(0);
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
  useEffect(() => {
    if (selectedId === personalTeam.id || admissionBlocked) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    setDetail({ id: selectedId, epoch, status: "loading" });
    void (async () => {
      try {
        await admission.ready(signal);
        const team = await getTeam(selectedId, admission.userId, signal, admission.principalMismatch);
        await admission.ready(signal);
        if (!signal.aborted && !blocked.current && selection.current.epoch === epoch) setDetail({ id: selectedId, epoch, status: "ready", team });
      } catch (error) {
        if (signal.aborted || admission.isInvalidated || isAbortError(error)) return;
        try { await admission.ready(signal); } catch { return; }
        if (!signal.aborted && !blocked.current && selection.current.epoch === epoch) setDetail({ id: selectedId, epoch, status: "error", error });
      }
    })();
    return () => controller.abort();
  }, [selectedId, personalTeam.id, admission, admissionBlocked, revision, epoch]);
  return { list, detail: selectedId === personalTeam.id ? { id: selectedId, status: "ready" as const, team: personalTeam } : detail.epoch === epoch ? detail : { id: selectedId, epoch, status: "loading" as const }, refreshList: () => { void load(null); }, loadMore: () => { if (list.cursor !== null && listRequest.current === null) void load(list.cursor); }, refreshDetail: () => setRevision((value) => value + 1) };
};
export const TeamsProvider = ({ personalTeam, selectedId, admission, admissionBlocked, children }: { readonly personalTeam: TeamRef; readonly selectedId: string; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly children: ReactNode }) => {
  const state = useTeamsState(personalTeam, selectedId, admission, admissionBlocked);
  return <TeamsContext.Provider value={state}>{children}</TeamsContext.Provider>;
};
export const useTeams = () => { const state = useContext(TeamsContext); if (state === null) throw new Error("Team browsing requires a TeamsProvider."); return state; };
