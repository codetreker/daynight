import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createProject, ProjectCreationUnknown } from "../../api/auth";
import { ApiError, isAbortError, listProjects } from "../../api/client";
import type { Project } from "../../api/types";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import { useBodyScrollLock } from "../../app/useBodyScrollLock";
import type { TaskCacheScope } from "../task-cache/project-cache";

export const CreateProjectDialog = ({ userId, teamId, teamName, teamPersonal = true, admission, onIdentityMismatch, onClose, onCreated }: { readonly userId: string; readonly teamId?: string; readonly teamName?: string; readonly teamPersonal?: boolean; readonly admission?: TaskCacheScope; readonly onIdentityMismatch: () => void; readonly onClose: () => void; readonly onCreated: (project: Project) => void }) => {
  const targetTeamId = useRef(teamId).current;
  const target = useRef({ name: teamName, personal: teamPersonal }).current;
  const { locale, messages: { auth: { createProject: m }, common } } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [check, setCheck] = useState<{ status: "idle" | "loading" | "ready" | "error"; items: readonly Project[]; nextCursor: string | null; error: unknown }>({ status: "idle", items: [], nextCursor: null, error: null });
  const unknown = error instanceof ProjectCreationUnknown;
  const errorDetail = unknown ? error.cause : error;
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    dialog.current!.showModal();
    name.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => () => active.current?.abort(), []);
  const checkProjects = (cursor: string | null) => {
    if (active.current !== null) return;
    const controller = new AbortController();
    const signal = admission === undefined ? controller.signal : AbortSignal.any([controller.signal, admission.signal]);
    active.current = controller;
    setCheck((previous) => ({ status: "loading", items: cursor === null ? [] : previous.items, nextCursor: cursor, error: null }));
    void (async () => {
      try {
        if (admission !== undefined) await admission.ready(signal);
        const page = await listProjects({ limit: 50, ...(cursor === null ? {} : { cursor }), ...(targetTeamId === undefined ? {} : { teamId: targetTeamId }) }, signal, { userId, onPrincipalMismatch: onIdentityMismatch });
        if (admission !== undefined) await admission.ready(signal);
        if (!signal.aborted) setCheck((previous) => ({ status: "ready", items: cursor === null ? page.items : [...previous.items, ...page.items], nextCursor: page.nextCursor, error: null }));
      } catch (cause) {
        if (signal.aborted || isAbortError(cause)) return;
        try { if (admission !== undefined) await admission.ready(signal); } catch { return; }
        if (!signal.aborted) setCheck((previous) => ({ ...previous, status: "error", error: cause }));
      } finally { if (active.current === controller) active.current = null; }
    })();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (active.current !== null || unknown) return;
    const data = new FormData(event.currentTarget);
    const controller = new AbortController();
    const signal = admission === undefined ? controller.signal : AbortSignal.any([controller.signal, admission.signal]);
    active.current = controller;
    setBusy(true); setError(null);
    void (async () => {
      try {
        if (admission !== undefined) await admission.ready(signal);
        const project = await createProject({ name: String(data.get("name")), repoUrl: String(data.get("repoUrl")), expectedUserId: userId, ...(targetTeamId === undefined ? {} : { teamId: targetTeamId }) }, signal, onIdentityMismatch);
        if (admission !== undefined) await admission.ready(signal);
        if (!signal.aborted) onCreated(project);
      } catch (cause) {
        if (signal.aborted || isAbortError(cause)) return;
        try { if (admission !== undefined) await admission.ready(signal); } catch { return; }
        if (!signal.aborted) { setError(cause); setBusy(false); }
      } finally { if (active.current === controller) active.current = null; }
    })();
  };
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="create-project-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}><header className="dialog-header"><h2 id="create-project-title">{target.personal ? m.title : locale === "zh-CN" ? "创建项目" : "Create project"}</h2><LanguageSelector /><button className="close-button" type="button" aria-label={m.close} disabled={busy} onClick={onClose}>×</button></header><div className="dialog-body"><p>{target.personal ? m.intro : locale === "zh-CN" ? "Team 成员可以访问此项目，也可以单独管理项目权限。" : "Team members can access this project; project permissions can also be managed separately."}</p>
      {targetTeamId !== undefined && <p>{locale === "zh-CN" ? "创建到：" : "Create in: "}<strong>{target.personal ? (locale === "zh-CN" ? "个人" : "Personal") : target.name}</strong></p>}
      <div className="field"><label htmlFor="project-name">{m.name} <span className="required">*</span></label><input ref={name} id="project-name" name="name" required autoComplete="off" disabled={busy} /></div>
      <div className="field"><label htmlFor="project-repository">{m.repository} <span className="required">*</span></label><input id="project-repository" name="repoUrl" required type="text" autoComplete="off" placeholder="https://github.com/team/project" disabled={busy} /><p className="hint">{m.repositoryHint}</p></div>
      {error !== null && <div className="notice error" role="alert"><p>{unknown ? m.unknown : m.error}</p>{errorDetail instanceof ApiError && errorDetail.requestId !== null && <p>{common.requestId}<code>{errorDetail.requestId}</code></p>}</div>}
      {unknown && check.status !== "idle" && <section aria-label={m.observedProjects}>
        <h3>{m.observedProjects}</h3>
        {check.items.length > 0 && <ul>{check.items.map((item) => <li key={item.id}><a href={`/projects/${item.id}`}>{item.name}</a> <code>{item.id}</code> <span>{item.repoUrl}</span></li>)}</ul>}
        {check.status === "loading" ? <p>{m.checking}</p> : check.status === "error" ? <div role="alert"><p>{m.checkFailed}</p>{check.error instanceof ApiError && check.error.requestId !== null && <p>{common.requestId}<code>{check.error.requestId}</code></p>}</div> : check.items.length === 0 ? <p>{m.noProjects}</p> : null}
        {check.nextCursor !== null && check.status !== "loading" && <button className="button" type="button" onClick={() => checkProjects(check.nextCursor)}>{m.loadMore}</button>}
      </section>}
    </div><footer className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={check.status === "loading"} onClick={() => checkProjects(null)}>{m.checkProjects}</button> : <button className="button primary" type="submit" disabled={busy}>{busy ? m.busy : m.submit}</button>}</footer></form>
  </dialog>;
};
