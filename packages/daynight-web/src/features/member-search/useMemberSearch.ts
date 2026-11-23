import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, authRequestsPaused } from "../../api/client";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

// Unicode White_Space matches the server's query normalization; JS trim includes
// an additional BOM character and therefore cannot be used for this contract.
export const normalizeMemberQuery = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").replace(/[A-Z]/g, c => c.toLowerCase());

export type MemberCandidate = { readonly userId: string; readonly profile: { readonly name: string | null; readonly email: string | null; readonly avatarUrl: string | null } };
export type MemberCandidatePage = { readonly items: readonly MemberCandidate[]; readonly nextCursor: string | null };
export type MemberSearchState = MemberCandidatePage & { readonly status: "idle" | "loading" | "ready" | "error"; readonly moreLoading: boolean; readonly moreError: boolean };
export type MemberSearchOptions = {
  readonly resourceId: string;
  readonly search: (resourceId: string, userId: string, query: string, cursor: string | null, signal: AbortSignal, onIdentityMismatch: () => void) => Promise<MemberCandidatePage>;
  readonly admission: TaskCacheScope;
  readonly active: boolean;
  readonly admissionBlocked: boolean;
  readonly permissionReady: boolean;
  readonly permissionRevision: number;
  readonly getPermissionRevision: () => number | null;
  readonly onIdentityMismatch: () => void;
  readonly onPermissionChange: () => void;
};
const empty: MemberSearchState = { items: [], nextCursor: null, status: "idle", moreLoading: false, moreError: false };

export const useMemberSearch = (options: MemberSearchOptions) => {
  const latest = useRef(options); latest.current = options;
  const [draft, setDraftState] = useState("");
  const [state, setState] = useState<MemberSearchState>(empty);
  const draftRef = useRef(""), stateRef = useRef<MemberSearchState>(empty), generation = useRef(0);
  const request = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interrupted = useRef<string | null | undefined>(undefined);
  const observedPermission = useRef(options.permissionRevision);
  const scope = useRef({ resourceId: options.resourceId, admission: options.admission });
  const cursors = useRef(new Set<string>());
  const update = (next: MemberSearchState) => { stateRef.current = next; setState(next); };
  const cancel = () => { request.current?.abort(); request.current = null; if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const run = useCallback((cursor: string | null) => {
    const current = latest.current, query = normalizeMemberQuery(draftRef.current), revision = current.getPermissionRevision();
    if (!query || !current.active || current.admissionBlocked || !current.permissionReady || revision === null || authRequestsPaused() || current.admission.isInvalidated) { interrupted.current = cursor; return; }
    cancel();
    const controller = new AbortController(); request.current = controller;
    const signal = AbortSignal.any([controller.signal, current.admission.signal]);
    const epoch = generation.current, owner = current.admission, resource = current.resourceId;
    const valid = () => !signal.aborted && !owner.isInvalidated && latest.current.admission === owner && latest.current.resourceId === resource && latest.current.active && !latest.current.admissionBlocked && latest.current.permissionReady && !authRequestsPaused() && latest.current.getPermissionRevision() === revision && generation.current === epoch && normalizeMemberQuery(draftRef.current) === query && (cursor === null || stateRef.current.nextCursor === cursor);
    update(cursor === null ? { ...empty, status: "loading" } : { ...stateRef.current, moreLoading: true, moreError: false });
    void (async () => {
      try {
        await owner.ready(signal);
        if (!valid()) return;
        const page = await current.search(resource, owner.userId, query, cursor, signal, current.onIdentityMismatch);
        await owner.ready(signal);
        if (!valid()) return;
        const previous = cursor === null ? [] : stateRef.current.items;
        const ids = new Set(previous.map(item => item.userId));
        for (const item of page.items) { if (ids.has(item.userId)) throw new ApiError("protocol"); ids.add(item.userId); }
        if (page.nextCursor !== null && (page.items.length === 0 || page.nextCursor === cursor || cursors.current.has(page.nextCursor))) throw new ApiError("protocol");
        if (cursor !== null) cursors.current.add(cursor);
        update({ items: [...previous, ...page.items], nextCursor: page.nextCursor, status: "ready", moreLoading: false, moreError: false });
        interrupted.current = undefined;
      } catch (failure) {
        if (!valid()) return;
        if (failure instanceof ApiError && failure.kind === "server" && ((failure.status === 403 && failure.code === "forbidden") || (failure.status === 404 && failure.code === "not_found"))) latest.current.onPermissionChange();
        update(cursor === null ? { ...empty, status: "error" } : { ...stateRef.current, moreLoading: false, moreError: true });
        interrupted.current = undefined;
      } finally { if (request.current === controller) request.current = null; }
    })();
  }, []);
  const setDraft = (value: string) => {
    cancel(); ++generation.current; cursors.current.clear(); interrupted.current = undefined; draftRef.current = value; setDraftState(value);
    if (!normalizeMemberQuery(value)) { update(empty); return; }
    update({ ...empty, status: "loading" });
    timer.current = setTimeout(() => { timer.current = null; run(null); }, 250);
  };
  useLayoutEffect(() => {
    if (scope.current.resourceId === options.resourceId && scope.current.admission === options.admission) return;
    scope.current = { resourceId: options.resourceId, admission: options.admission };
    cancel(); ++generation.current; cursors.current.clear(); interrupted.current = undefined;
    draftRef.current = ""; setDraftState(""); update(empty);
  }, [options.resourceId, options.admission]);
  useEffect(() => {
    const eligible = options.active && !options.admissionBlocked && options.permissionReady && options.getPermissionRevision() !== null && !authRequestsPaused() && !options.admission.isInvalidated;
    const changed = observedPermission.current !== options.permissionRevision;
    observedPermission.current = options.permissionRevision;
    if (!eligible || changed) {
      if (request.current !== null || timer.current !== null || stateRef.current.status === "loading" || stateRef.current.moreLoading) {
        interrupted.current = stateRef.current.moreLoading ? stateRef.current.nextCursor : null;
        cancel();
      }
      if (!eligible) return;
    }
    if (interrupted.current !== undefined) { const cursor = interrupted.current; interrupted.current = undefined; run(cursor); }
  }, [options.active, options.admissionBlocked, options.permissionReady, options.permissionRevision, options.admission, options.getPermissionRevision, run]);
  useEffect(() => () => { cancel(); ++generation.current; }, [options.resourceId, options.admission]);
  return { draft, setDraft, ...state, retry: () => run(null), more: () => { if (stateRef.current.nextCursor !== null && !stateRef.current.moreLoading) run(stateRef.current.nextCursor); } };
};
