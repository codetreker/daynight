import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createProject, ProjectCreationUnknown } from "../../api/auth";
import { ApiError, authRequestsPaused, isAbortError, listProjects, readAuthRequestGeneration, waitForAuthRequests } from "../../api/client";
import type { Project } from "../../api/types";
import { useI18n } from "../../i18n/LocaleProvider";
import { useBodyScrollLock } from "../../app/useBodyScrollLock";
import { browserNavigation } from "../../app/navigation";
import { isRetryableTaskCacheLifecycleChange, type TaskCacheScope } from "../task-cache/project-cache";
import { TaskCacheError } from "../task-cache/database";

const abortable = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
  if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
  signal.addEventListener("abort", abort, { once: true });
  promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
});

export const CreateProjectDialog = ({ userId, teamId, teamName, teamPersonal = true, admission, onIdentityMismatch, onClose, onPublished, onCreated }: { readonly userId: string; readonly teamId?: string; readonly teamName?: string; readonly teamPersonal?: boolean; readonly admission?: TaskCacheScope; readonly onIdentityMismatch: () => void; readonly onClose: () => void; readonly onPublished?: (project: Project) => void; readonly onCreated: (project: Project) => void }) => {
  const targetTeamId = useRef(teamId).current;
  const target = useRef({ name: teamName, personal: teamPersonal }).current;
  const { locale, messages: { auth: { createProject: m }, common } } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const checkActive = useRef<AbortController | null>(null);
  const publication = useRef<AbortController | null>(null);
  const retainedPublication = useRef<AbortController | null>(null);
  const receipts = useRef(new Set<Project>());
  const receiptGeneration = useRef<number | null>(null);
  const revision = useRef(0);
  const [draftRevision, setDraftRevision] = useState(0);
  const owner = useRef({ userId, admission, onPublished });
  const effectOwner = useRef({ userId, admission });
  owner.current = { userId, admission, onPublished };
  const [settled, setSettled] = useState<{ kind: "confirmed" | "unknown"; revision: number } | null>(null);
  const checkSnapshot = useRef<ReadonlyMap<string, string> | null>(null);
  const itemGenerations = useRef(new Map<string, ReadonlyMap<string, string>>());
  const loadedPages = useRef(0);
  const checkAction = useRef<() => void>(() => {});
  const restorePending = useRef(false);
  const restoring = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [publicationError, setPublicationError] = useState(false);
  const [confirmedProjects, setConfirmedProjects] = useState<readonly Project[]>([]);
  const [check, setCheck] = useState<{ status: "idle" | "loading" | "ready" | "error"; items: readonly Project[]; nextCursor: string | null; error: unknown }>({ status: "idle", items: [], nextCursor: null, error: null });
  const unknown = error instanceof ProjectCreationUnknown;
  const errorDetail = unknown ? error.cause : error;
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    name.current?.focus();
    return () => {
      if (element.open) element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; restorePending.current = false; active.current?.abort(); publication.current?.abort(); retainedPublication.current?.abort(); };
  }, []);
  useEffect(() => {
    if (effectOwner.current.userId !== userId || effectOwner.current.admission !== admission) {
      active.current = null; publication.current = null; retainedPublication.current = null; receipts.current.clear();
      setBusy(false); setSettled(null); setError(null); setPublicationError(false); setConfirmedProjects([]);
      effectOwner.current = { userId, admission };
    }
    return () => { active.current?.abort(); publication.current?.abort(); retainedPublication.current?.abort(); };
  }, [userId, admission]);
  useEffect(() => {
    if (admission === undefined) return;
    return admission.subscribeProjection((event) => {
      if (event.accessRestored) {
        if (itemGenerations.current.has(event.projectId)) {
          if (active.current === null) checkAction.current();
          else restorePending.current = true;
        }
        return;
      }
      if (!event.accessRevoked) return;
      const observed = itemGenerations.current.get(event.projectId);
      const remove = observed !== undefined && admission.projectionEventMatches(observed, event);
      const cancel = !(event.error instanceof TaskCacheError) && checkActive.current !== null && admission.projectionEventMatches(checkSnapshot.current, event);
      const resumeRestoration = cancel && restoring.current;
      if (cancel) { checkActive.current?.abort(); if (active.current === checkActive.current) active.current = null; checkActive.current = null; checkSnapshot.current = null; restoring.current = false; }
      if (remove || cancel || event.error instanceof TaskCacheError && admission.isProjectionDenied(event.projectId)) {
        setCheck((previous) => ({ ...previous, items: remove ? previous.items.filter((item) => item.id !== event.projectId) : previous.items,
          status: event.error instanceof TaskCacheError ? "error" : cancel ? "ready" : previous.status,
          error: event.error instanceof TaskCacheError ? event.error : previous.error }));
      }
      if (resumeRestoration) checkAction.current();
    });
  }, [admission]);
  const checkProjects = (cursor: string | null, preserve = false) => {
    if (!mounted.current) return;
    if (active.current !== null) {
      if (preserve || !restoring.current || checkActive.current !== active.current) return;
      restorePending.current = true;
      active.current.abort(); active.current = null; checkActive.current = null; checkSnapshot.current = null;
    }
    const controller = new AbortController();
    const signal = admission === undefined ? controller.signal : AbortSignal.any([controller.signal, admission.signal, admission.mismatchSignal]);
    active.current = controller;
    checkActive.current = controller;
    checkSnapshot.current = null;
    restoring.current = preserve;
    let preparationError: TaskCacheError | null = null;
    if (!preserve) setCheck((previous) => ({ status: "loading", items: cursor === null ? [] : previous.items, nextCursor: cursor, error: null }));
    void (async () => {
      try {
        const snapshot = admission === undefined ? new Map<string, string>() : await admission.prepareProjection(signal);
        if (signal.aborted || admission?.isInvalidated) return;
        checkSnapshot.current = snapshot;
        preparationError = admission?.projectionSnapshotError(snapshot) ?? null;
        if (admission?.projectionSnapshotHasDenials(snapshot)) {
          setCheck((previous) => ({ ...previous, items: previous.items.filter((item) => !admission.projectionSnapshotDenied(snapshot, item.id)),
            error: preparationError ?? previous.error }));
        }
        const pages: Project[] = [];
        let nextCursor = cursor, pageCount = 0;
        const limit = preserve ? Math.max(1, loadedPages.current) : 1;
        const cursors = new Set<string>();
        do {
          if (admission !== undefined) await admission.ready(signal);
          if (signal.aborted) return;
          if (preserve && nextCursor !== null) {
            if (cursors.has(nextCursor)) throw new ApiError('protocol');
            cursors.add(nextCursor);
          }
          const page = await listProjects({ limit: 50, ...(nextCursor === null ? {} : { cursor: nextCursor }), ...(targetTeamId === undefined ? {} : { teamId: targetTeamId }) }, signal, { userId, onPrincipalMismatch: onIdentityMismatch });
          if (preserve && page.nextCursor !== null && cursors.has(page.nextCursor)) throw new ApiError("protocol");
          pages.push(...page.items); nextCursor = page.nextCursor; pageCount++;
        } while (preserve && pageCount < limit && nextCursor !== null);
        if (admission !== undefined) await admission.ready(signal);
        if (!signal.aborted) {
          const visible = pages.filter((item) => admission?.projectionSnapshotDenied(snapshot, item.id) !== true);
          if (cursor === null && !preserve) itemGenerations.current.clear();
          for (const item of visible) if (preserve || !itemGenerations.current.has(item.id)) itemGenerations.current.set(item.id, snapshot);
          loadedPages.current = cursor !== null ? loadedPages.current + pageCount : pageCount;
          setCheck((previous) => {
            const failure = preparationError ?? admission?.projectionSnapshotError(snapshot) ?? (admission?.projectionSnapshotHasDenials(snapshot) ? previous.error : null);
            const retained = cursor === null && !preserve ? [] : previous.items.filter((item) => admission?.projectionSnapshotDenied(snapshot, item.id) !== true);
            const items = new Map<string, Project>();
            for (const item of preserve ? [...visible, ...retained] : [...retained, ...visible]) if (!items.has(item.id)) items.set(item.id, item);
            return { status: failure === null ? "ready" : "error", items: [...items.values()], nextCursor, error: failure };
          });
        }
      } catch (cause) {
        if (signal.aborted || isAbortError(cause)) return;
        try { if (admission !== undefined) await admission.ready(signal); } catch { return; }
        if (!signal.aborted) setCheck((previous) => ({ ...previous, status: "error", error: preparationError ?? cause }));
      } finally {
        if (active.current === controller) active.current = null;
        if (checkActive.current === controller) { checkActive.current = null; checkSnapshot.current = null; restoring.current = false; }
        if (mounted.current && restorePending.current && active.current === null) { restorePending.current = false; checkAction.current(); }
      }
    })();
  };
  checkAction.current = () => checkProjects(null, true);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (admission?.hasIdentityMismatch || active.current !== null || unknown || settled?.kind === "unknown" || settled?.kind === "confirmed" && settled.revision === revision.current) return;
    publication.current?.abort();
    publication.current = null;
    retainedPublication.current?.abort();
    const data = new FormData(event.currentTarget);
    const controller = new AbortController();
    const signal = admission === undefined ? controller.signal : AbortSignal.any([controller.signal, admission.signal, admission.mismatchSignal]);
    const submittedRevision = revision.current;
    const authGeneration = readAuthRequestGeneration();
    if (receiptGeneration.current !== authGeneration) { receipts.current.clear(); receiptGeneration.current = authGeneration; }
    const navigation = browserNavigation();
    const location = navigation.snapshot();
    let navigationChanged = navigation.decision() !== null;
    const unsubscribeNavigation = navigation.subscribeDecision(() => { navigationChanged = true; });
    let dispatched = false, publicationStarted = false;
    let receipt: Project | null = null, rejection: ApiError | null = null;
    active.current = controller;
    setBusy(true); setError(null); setSettled(null); setPublicationError(false);
    const owns = () => mounted.current && owner.current.userId === userId && owner.current.admission === admission;
    const belongs = () => owns() && readAuthRequestGeneration() === authGeneration;
    const readyToPublish = async (target: AbortSignal) => {
      do {
        try {
          if (admission === undefined) await waitForAuthRequests(target);
          else await admission.ready(target);
        } catch (cause) {
          if (isRetryableTaskCacheLifecycleChange(cause) && !target.aborted && !admission?.isInvalidated && authRequestsPaused() && belongs()) continue;
          throw cause;
        }
        target.throwIfAborted();
      } while (authRequestsPaused());
    };
    const publishReceipt = (project: Project) => {
      if (!receipts.current.delete(project)) return;
      setConfirmedProjects((previous) => [...previous, project]);
      owner.current.onPublished?.(project);
    };
    // Superseding a presentation cancels its destructive effects, but its receipt remains publishable.
    if (receipts.current.size > 0) {
      const retained = new AbortController();
      retainedPublication.current = retained;
      const retainedSignal = admission === undefined ? retained.signal : AbortSignal.any([retained.signal, admission.signal]);
      void (async () => {
        try {
          do { await readyToPublish(retainedSignal); } while (authRequestsPaused());
          if (!retainedSignal.aborted && !admission?.hasIdentityMismatch && belongs() && retainedPublication.current === retained) {
            for (const project of receipts.current) publishReceipt(project);
          }
        } catch (cause) {
          if (!retainedSignal.aborted && !isAbortError(cause) && belongs() && retainedPublication.current === retained) setPublicationError(true);
        } finally {
          if (retainedPublication.current === retained) retainedPublication.current = null;
        }
      })();
    }
    // Publication has its own lifetime: the local operation must settle even if admission never resumes.
    const publish = (result: { project: Project } | { error: unknown }) => {
      if (!belongs()) return;
      publicationStarted = true;
      const pending = new AbortController();
      publication.current = pending;
      const publicationSignal = admission === undefined ? pending.signal : AbortSignal.any([pending.signal, admission.signal]);
      void (async () => {
        try {
          do { await readyToPublish(publicationSignal); } while (authRequestsPaused());
          if (publicationSignal.aborted || admission?.hasIdentityMismatch || !belongs() || publication.current !== pending) return;
          if ("project" in result) {
            publishReceipt(result.project);
            if (revision.current === submittedRevision && navigation.snapshot() === location && !navigationChanged && navigation.decision() === null) onCreated(result.project);
          } else setError(result.error);
        } catch (cause) {
          if (belongs() && publication.current === pending && admission?.hasIdentityMismatch) {
            if ("project" in result) setPublicationError(true);
            else if (result.error instanceof ProjectCreationUnknown || result.error instanceof ApiError && result.error.kind === "server" && result.error.status !== null && result.error.status >= 400 && result.error.status < 500) setError(result.error);
          } else if (!publicationSignal.aborted && !isAbortError(cause) && belongs() && publication.current === pending) {
            if ("project" in result) setPublicationError(true);
            else setError(cause);
          }
        } finally {
          unsubscribeNavigation();
          if (publication.current === pending) publication.current = null;
        }
      })();
    };
    void (async () => {
      try {
        if (admission !== undefined) await admission.ready(signal);
        let project: Project;
        try {
          project = await abortable(createProject({ name: String(data.get("name")), repoUrl: String(data.get("repoUrl")), expectedUserId: userId, ...(targetTeamId === undefined ? {} : { teamId: targetTeamId }) }, signal, onIdentityMismatch, () => { dispatched = true; }, value => { receipt = value; }, error => { if (error.status !== null && error.status >= 400 && error.status < 500) rejection = error; }), signal);
        } catch (cause) {
          if (receipt === null) throw rejection ?? cause;
          project = receipt;
        }
        if (owns() && active.current === controller) {
          setSettled({ kind: "confirmed", revision: submittedRevision });
          receipts.current.add(project);
          publish({ project });
        }
      } catch (cause) {
        if (owns() && active.current === controller) {
          const result = cause instanceof ProjectCreationUnknown ? cause : dispatched && (signal.aborted || isAbortError(cause)) && !(cause instanceof ApiError && cause.kind === "server" && cause.status !== null && cause.status >= 400 && cause.status < 500) ? new ProjectCreationUnknown(cause) : cause;
          if (result instanceof ProjectCreationUnknown) {
            setSettled({ kind: "unknown", revision: submittedRevision });
            if (admission?.hasIdentityMismatch) setError(result);
          }
          if (admission?.hasIdentityMismatch && result instanceof ApiError && result.kind === "server" && result.status !== null && result.status >= 400 && result.status < 500) setError(result);
          if (result instanceof ProjectCreationUnknown || result instanceof ApiError && result.kind === "server" && result.status !== null && result.status >= 400 && result.status < 500 || !signal.aborted && !isAbortError(result)) publish({ error: result });
        }
      } finally {
        if (!publicationStarted) unsubscribeNavigation();
        if (active.current === controller) {
          active.current = null;
          if (owns()) setBusy(false);
        }
      }
    })();
  };
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="create-project-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit} onChange={() => { setDraftRevision(++revision.current); }}><header className="dialog-header"><h2 id="create-project-title">{target.personal ? m.title : locale === "zh-CN" ? "创建项目" : "Create project"}</h2><button className="close-button" type="button" aria-label={m.close} disabled={busy} onClick={onClose}>×</button></header><div className="dialog-body"><p>{target.personal ? m.intro : locale === "zh-CN" ? "Team 成员可以访问此项目，也可以单独管理项目权限。" : "Team members can access this project; project permissions can also be managed separately."}</p>
      {targetTeamId !== undefined && <p>{locale === "zh-CN" ? "创建到：" : "Create in: "}<strong>{target.personal ? (locale === "zh-CN" ? "个人" : "Personal") : target.name}</strong></p>}
      <div className="field"><label htmlFor="project-name">{m.name} <span className="required">*</span></label><input ref={name} id="project-name" name="name" required autoComplete="off" disabled={busy} /></div>
      <div className="field"><label htmlFor="project-repository">{m.repository} <span className="required">*</span></label><input id="project-repository" name="repoUrl" required type="text" autoComplete="off" placeholder="https://github.com/team/project" disabled={busy} /><p className="hint">{m.repositoryHint}</p></div>
      {confirmedProjects.map((project) => <div key={project.id} className="notice" role="status">{locale === "zh-CN" ? "项目已创建：" : "Project created: "}<a href={`/projects/${project.id}`}>{project.name}</a></div>)}
      {publicationError && <div className="notice error" role="alert">{locale === "zh-CN" ? "项目已创建，但无法显示创建结果。" : "The project was created, but its result could not be displayed."}</div>}
      {error !== null && <div className="notice error" role="alert"><p>{unknown ? m.unknown : m.error}</p>{errorDetail instanceof ApiError && errorDetail.requestId !== null && <p>{common.requestId}<code>{errorDetail.requestId}</code></p>}</div>}
      {unknown && check.status !== "idle" && <section aria-label={m.observedProjects}>
        <h3>{m.observedProjects}</h3>
        {check.items.length > 0 && <ul>{check.items.map((item) => <li key={item.id}><a href={`/projects/${item.id}`}>{item.name}</a> <code>{item.id}</code> <span>{item.repoUrl}</span></li>)}</ul>}
        {check.error instanceof TaskCacheError && check.status !== "error" && <div role="alert"><p>{m.checkFailed}</p></div>}
        {check.status === "loading" ? <p>{m.checking}</p> : check.status === "error" ? <div role="alert"><p>{m.checkFailed}</p>{check.error instanceof ApiError && check.error.requestId !== null && <p>{common.requestId}<code>{check.error.requestId}</code></p>}</div> : check.items.length === 0 ? <p>{m.noProjects}</p> : null}
        {check.nextCursor !== null && check.status !== "loading" && <button className="button" type="button" onClick={() => checkProjects(check.nextCursor)}>{m.loadMore}</button>}
      </section>}
    </div><footer className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={check.status === "loading" || admission?.hasIdentityMismatch} onClick={() => checkProjects(null)}>{m.checkProjects}</button> : <button className="button primary" type="submit" disabled={busy || admission?.hasIdentityMismatch || settled?.kind === "unknown" || settled?.kind === "confirmed" && settled.revision === draftRevision}>{busy ? m.busy : m.submit}</button>}</footer></form>
  </dialog>;
};
