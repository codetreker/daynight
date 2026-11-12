import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isAbortError } from "../../api/client";
import { listTeams, type Team } from "../../api/teams";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { useTeamForeground } from "./useTeamForeground";
import type { TeamPreference } from "./useTeamPreference";

type List = { readonly items: readonly Team[]; readonly cursor: string | null; readonly status: "loading" | "ready" | "error"; readonly more: boolean; readonly moreError: unknown; readonly error: unknown };
const initial: List = { items: [], cursor: null, status: "loading", more: false, moreError: null, error: null };
type ListOperation = { readonly kind: "initial" | "refresh" | "more" | "revalidate"; readonly cursor: string | null };
const sameTeam = (a: Team, b: Team) => a.id === b.id && a.kind === b.kind && a.name === b.name && a.version === b.version && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.membership.teamId === b.membership.teamId && a.membership.userId === b.membership.userId && a.membership.role === b.membership.role && a.membership.version === b.membership.version && a.membership.createdAt === b.membership.createdAt && a.membership.updatedAt === b.membership.updatedAt;
const TeamsContext = createContext<ReturnType<typeof useTeamsState> | null>(null);

const useTeamsState = (preference: TeamPreference, admission: TaskCacheScope, admissionBlocked: boolean) => {
  const [list, setList] = useState<List>(initial);
  const listSnapshot = useRef(list);
  const pageDepth = useRef(0);
  const listRequest = useRef<{ controller: AbortController; operation: ListOperation } | null>(null);
  const interrupted = useRef<ListOperation | null>(null);
  const listGeneration = useRef(0);
  const blocked = useRef(admissionBlocked); blocked.current = admissionBlocked;
  const publishList = useCallback((next: List) => { listSnapshot.current = next; setList(next); }, []);
  const load = useCallback(async (operation: ListOperation, revalidateAfter = false) => {
    if (admission.isInvalidated) return;
    if (blocked.current) {
      interrupted.current = operation;
      return;
    }
    listRequest.current?.controller.abort();
    const controller = new AbortController(); listRequest.current = { controller, operation };
    const signal = AbortSignal.any([controller.signal, admission.signal]);
    const generation = ++listGeneration.current;
    if (operation.kind === "initial" || operation.kind === "refresh") { pageDepth.current = 0; publishList(initial); }
    else if (operation.kind === "more") publishList({ ...listSnapshot.current, more: true, moreError: null });
    const current = () => !signal.aborted && !blocked.current && !admission.isInvalidated && generation === listGeneration.current;
    try {
      let cursor = operation.cursor;
      let pages = 0;
      // A revalidation replaces the prefix atomically; partial pages never reach consumers.
      const targetDepth = operation.kind === "revalidate" ? pageDepth.current : 1;
      const items: Team[] = [];
      do {
        await admission.ready(signal);
        const page = await listTeams(cursor, admission.userId, signal, admission.principalMismatch);
        await admission.ready(signal);
        if (!current()) return;
        items.push(...page.items.filter((item) => !items.some((old) => old.id === item.id)));
        cursor = page.nextCursor;
        pages++;
      } while (operation.kind === "revalidate" && pages < targetDepth && cursor !== null);
      if (!current()) return;
      const previous = listSnapshot.current;
      const nextItems = operation.kind === "more" ? [...previous.items, ...items.filter((item) => !previous.items.some((old) => old.id === item.id))] : items;
      pageDepth.current = operation.kind === "more" ? pageDepth.current + 1 : pages;
      const same = previous.cursor === cursor && previous.items.length === nextItems.length && previous.items.every((item, index) => sameTeam(item, nextItems[index]!));
      if (!same || previous.status !== "ready" || previous.more || operation.kind !== "revalidate" && previous.moreError !== null || operation.kind !== "more" && previous.error !== null) {
        publishList({ items: same ? previous.items : nextItems, cursor, status: "ready", more: false, moreError: operation.kind === "revalidate" && cursor === previous.cursor ? previous.moreError : null, error: operation.kind === "more" ? previous.error : null });
      }
    } catch (error) {
      if (signal.aborted || admission.isInvalidated || isAbortError(error)) return;
      try { await admission.ready(signal); } catch { return; }
      if (!current()) return;
      const previous = listSnapshot.current;
      if (operation.kind === "more") publishList({ ...previous, more: false, moreError: error });
      else if (operation.kind === "revalidate") publishList({ ...previous, more: false, error });
      else publishList({ ...initial, status: "error", error });
    } finally {
      if (listRequest.current?.controller === controller) {
        // Admission can close before the effect cleanup aborts this request.
        if (blocked.current && !admission.isInvalidated && generation === listGeneration.current && interrupted.current === null) interrupted.current = operation;
        listRequest.current = null;
        // A continuation can interrupt a reread; verify the retained prefix even if it failed.
        if (revalidateAfter && current()) void load({ kind: "revalidate", cursor: null });
      }
    }
  }, [admission, publishList]);
  useEffect(() => {
    if (!admissionBlocked) {
      const operation = interrupted.current;
      interrupted.current = null;
      if (operation !== null) void load(operation, operation.kind === "more");
      else void load({ kind: pageDepth.current === 0 ? "initial" : "revalidate", cursor: null });
    }
    return () => {
      ++listGeneration.current;
      if (listRequest.current !== null) {
        if (interrupted.current === null) interrupted.current = listRequest.current.operation;
        listRequest.current.controller.abort();
        listRequest.current = null;
      }
    };
  }, [load, admissionBlocked]);
  useTeamForeground(!admissionBlocked, () => { void load({ kind: "revalidate", cursor: null }); });
  return { list, detail: preference.detail, visibilityTeamId: preference.visibilityTeamId, forgetUnavailable: preference.forgetUnavailable, leaveTeam: preference.leaveTeam, refreshList: () => { void load({ kind: "refresh", cursor: null }); }, revalidateList: () => { void load({ kind: "revalidate", cursor: null }); }, loadMore: () => { if (list.cursor !== null && (listRequest.current === null || listRequest.current.operation.kind === "revalidate")) void load({ kind: "more", cursor: list.cursor }, listRequest.current?.operation.kind === "revalidate"); }, refreshDetail: preference.retry, acceptTeam: preference.acceptTeam };
};
export const TeamsProvider = ({ preference, admission, admissionBlocked, children }: { readonly preference: TeamPreference; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly children: ReactNode }) => {
  const state = useTeamsState(preference, admission, admissionBlocked);
  return <TeamsContext.Provider value={state}>{children}</TeamsContext.Provider>;
};
export const useTeams = () => { const state = useContext(TeamsContext); if (state === null) throw new Error("Team browsing requires a TeamsProvider."); return state; };
