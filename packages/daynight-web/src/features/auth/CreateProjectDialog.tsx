import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createProject, ProjectCreationUnknown } from "../../api/auth";
import { ApiError, isAbortError, listProjects } from "../../api/client";
import type { Project } from "../../api/types";
import { useI18n } from "../../i18n/LocaleProvider";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import { useBodyScrollLock } from "../../app/useBodyScrollLock";

export const CreateProjectDialog = ({ userId, onIdentityMismatch, onClose, onCreated }: { readonly userId: string; readonly onIdentityMismatch: () => void; readonly onClose: () => void; readonly onCreated: (project: Project) => void }) => {
  const { messages: { auth: { createProject: m }, common } } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [check, setCheck] = useState<{ status: "idle" | "loading" | "ready" | "error"; items: readonly Project[]; nextCursor: string | null }>({ status: "idle", items: [], nextCursor: null });
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
    active.current = controller;
    setCheck((previous) => ({ status: "loading", items: cursor === null ? [] : previous.items, nextCursor: cursor }));
    void listProjects(cursor === null ? { limit: 50 } : { limit: 50, cursor }, controller.signal, { userId, onPrincipalMismatch: onIdentityMismatch }).then((page) => {
      if (!controller.signal.aborted) setCheck((previous) => ({ status: "ready", items: cursor === null ? page.items : [...previous.items, ...page.items], nextCursor: page.nextCursor }));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && !isAbortError(cause)) setCheck((previous) => ({ ...previous, status: "error" }));
    }).finally(() => { if (active.current === controller) active.current = null; });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (active.current !== null || unknown) return;
    const data = new FormData(event.currentTarget);
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError(null);
    void Promise.resolve().then(() => createProject({ name: String(data.get("name")), repoUrl: String(data.get("repoUrl")), expectedUserId: userId }, controller.signal, onIdentityMismatch)).then((project) => {
      if (!controller.signal.aborted) onCreated(project);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && !isAbortError(cause)) { setError(cause); setBusy(false); }
    }).finally(() => { if (active.current === controller) active.current = null; });
  };
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="create-project-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}><header className="dialog-header"><h2 id="create-project-title">{m.title}</h2><LanguageSelector /><button className="close-button" type="button" aria-label={m.close} disabled={busy} onClick={onClose}>×</button></header><div className="dialog-body"><p>{m.intro}</p>
      <div className="field"><label htmlFor="project-name">{m.name} <span className="required">*</span></label><input ref={name} id="project-name" name="name" required autoComplete="off" disabled={busy} /></div>
      <div className="field"><label htmlFor="project-repository">{m.repository} <span className="required">*</span></label><input id="project-repository" name="repoUrl" required type="text" autoComplete="off" placeholder="https://github.com/team/project" disabled={busy} /><p className="hint">{m.repositoryHint}</p></div>
      {error !== null && <div className="notice error" role="alert"><p>{unknown ? m.unknown : m.error}</p>{errorDetail instanceof ApiError && errorDetail.requestId !== null && <p>{common.requestId}<code>{errorDetail.requestId}</code></p>}</div>}
      {unknown && check.status !== "idle" && <section aria-label={m.observedProjects}>
        <h3>{m.observedProjects}</h3>
        {check.items.length > 0 && <ul>{check.items.map((item) => <li key={item.id}><a href={`/projects/${item.id}`}>{item.name}</a> <code>{item.id}</code> <span>{item.repoUrl}</span></li>)}</ul>}
        {check.status === "loading" ? <p>{m.checking}</p> : check.status === "error" ? <p role="alert">{m.checkFailed}</p> : check.items.length === 0 ? <p>{m.noProjects}</p> : null}
        {check.nextCursor !== null && check.status !== "loading" && <button className="button" type="button" onClick={() => checkProjects(check.nextCursor)}>{m.loadMore}</button>}
      </section>}
    </div><footer className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={check.status === "loading"} onClick={() => checkProjects(null)}>{m.checkProjects}</button> : <button className="button primary" type="submit" disabled={busy}>{busy ? m.busy : m.submit}</button>}</footer></form>
  </dialog>;
};
