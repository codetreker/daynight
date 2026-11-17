import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../../../api/client";
import type { TeamMember } from "../../../api/teams";
import type { TaskCacheScope } from "../../task-cache/TaskCacheProvider";
import { useI18n } from "../../../i18n/LocaleProvider";
import { normalizeMemberQuery, useTeamMemberSearch } from "./useTeamMemberSearch";
import "./team-member-search.css";

export type MemberAdditionPresentation = {
  readonly targetId: string | null;
  readonly pending: boolean;
  readonly unknown: boolean;
  readonly checking: boolean;
  readonly error: unknown | null;
  readonly observed: boolean;
  readonly locked: boolean;
};

type Props = {
  readonly teamId: string;
  readonly admission: TaskCacheScope;
  readonly active: boolean;
  readonly admissionBlocked: boolean;
  readonly permissionReady: boolean;
  readonly permissionRevision: number;
  readonly getPermissionRevision: () => number | null;
  readonly onIdentityMismatch: () => void;
  readonly onPermissionChange: () => void;
  readonly members: readonly TeamMember[];
  readonly addition: MemberAdditionPresentation;
  readonly onAdd: (userId: string) => void;
  readonly onCheck: () => void;
};

const messages = (zh: boolean) => zh ? {
  label: "搜索并添加成员", placeholder: "搜索姓名或邮箱以添加成员", dialog: "搜索用户并添加到团队", heading: "搜索结果", addAs: "添加为成员", clear: "清空搜索", loading: "正在搜索…", failed: "暂时无法搜索用户", retry: "重试", empty: "未找到匹配的用户", hint: "试试其他姓名或邮箱。", more: "加载更多", moreFailed: "无法加载更多用户。", name: "未设置姓名", email: "未设置邮箱", account: "账号", add: "添加", joined: "已加入", pending: "添加中", waiting: "待核对", unknown: "添加结果未确认，请检查当前成员状态。", check: "检查当前状态", checking: "正在核对…", absent: "当前不是 Team 成员。", addFailed: "添加失败，请核对后重试。", missing: "账号已不可用，请重新搜索。", footer: "搜索已注册的 Daynight 用户", close: "关闭"
} : {
  label: "Search and add members", placeholder: "Search name or email to add members", dialog: "Search users and add to team", heading: "Search results", addAs: "Add as member", clear: "Clear search", loading: "Searching…", failed: "Unable to search users", retry: "Retry", empty: "No matching users", hint: "Try another name or email.", more: "Load more", moreFailed: "Unable to load more users.", name: "Name not set", email: "Email not set", account: "Account", add: "Add", joined: "Joined", pending: "Adding", waiting: "Check status", unknown: "The add result is unconfirmed. Check the current membership.", check: "Check current status", checking: "Checking…", absent: "Not currently a Team member.", addFailed: "Could not add this member. Check and try again.", missing: "This account is unavailable. Search again.", footer: "Search registered Daynight users", close: "Close"
};

const CandidateAvatar = ({ src, name }: { readonly src: string | null; readonly name: string }) => {
  const [failed, setFailed] = useState(false);
  return <span className="member-search-avatar" aria-hidden="true">{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : Array.from(name)[0] ?? "?"}</span>;
};

export const TeamMemberSearch = (props: Props) => {
  const { locale } = useI18n(), m = messages(locale === "zh-CN");
  const search = useTeamMemberSearch(props);
  const [open, setOpen] = useState(false);
  const owner = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), popup = useRef<HTMLDivElement>(null);
  const seenError = useRef<unknown>(null), missingTarget = useRef<string | null>(null);
  if (seenError.current !== props.addition.error) {
    seenError.current = props.addition.error;
    missingTarget.current = props.addition.error instanceof ApiError && props.addition.error.code === "user_not_found" ? props.addition.targetId : null;
  }
  const popupId = useId();
  const present = open && normalizeMemberQuery(search.draft) !== "";
  const visible = present && props.active;
  useLayoutEffect(() => {
    if (!visible || !popup.current || !owner.current) return;
    const position = () => {
      if (!popup.current || !owner.current) return;
      const box = owner.current.getBoundingClientRect(), width = Math.min(box.width, window.innerWidth - 32);
      popup.current.style.width = `${Math.max(0, width)}px`;
      popup.current.style.left = `${Math.max(16, Math.min(box.left, window.innerWidth - width - 16))}px`;
      const below = window.innerHeight - box.bottom - 14, above = box.top - 14, useBelow = below >= 180 || below >= above;
      popup.current.style.maxHeight = `${Math.min(480, Math.max(120, useBelow ? below : above))}px`;
      popup.current.style.top = `${useBelow ? box.bottom + 7 : Math.max(8, box.top - 7 - popup.current.getBoundingClientRect().height)}px`;
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(owner.current); observer.observe(popup.current);
    window.addEventListener("resize", position); document.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true); };
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => { if (!owner.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    const focus = (event: FocusEvent) => { if (!owner.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", focus);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focus); };
  }, [visible]);
  const close = () => { input.current?.focus({ preventScroll: true }); setOpen(false); };
  const memberIds = new Set(props.members.map(member => member.userId));
  const content = present && <div ref={popup} id={popupId} className="member-search-popover" hidden={!props.active} role="dialog" aria-label={m.dialog} aria-modal="false" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div className="member-search-heading"><strong>{m.heading}</strong><span>{m.addAs}</span></div>
    <div className="member-search-results">
      {search.status === "loading" && <div className="member-search-state" role="status">{m.loading}</div>}
      {search.status === "error" && <div className="member-search-state" role="alert"><strong>{m.failed}</strong><button className="button" type="button" onClick={search.retry}>{m.retry}</button></div>}
      {search.status === "ready" && search.items.length === 0 && <div className="member-search-state"><strong>{m.empty}</strong><p>{m.hint}</p></div>}
      {search.items.length > 0 && <ul className="member-search-list">{search.items.map(candidate => {
        const name = candidate.profile.name ?? m.name, email = candidate.profile.email ?? m.email;
        const joined = memberIds.has(candidate.userId), own = props.addition.targetId === candidate.userId;
        const pending = own && props.addition.pending, unknown = own && props.addition.unknown;
        const missing = missingTarget.current === candidate.userId;
        const disabled = joined || missing || props.addition.locked || props.admissionBlocked || !props.permissionReady || !props.active;
        const action = joined ? m.joined : pending ? m.pending : unknown ? m.waiting : m.add;
        return <li className="member-search-item" key={candidate.userId}>
          <div className="member-search-row"><CandidateAvatar key={`${candidate.userId}:${candidate.profile.avatarUrl}`} src={candidate.profile.avatarUrl} name={candidate.profile.name ?? candidate.profile.email ?? "?"} />
            <div className="member-search-person"><div className="member-search-name">{name}</div><div className="member-search-email">{email}</div><details><summary>{m.account} {candidate.userId.slice(0, 8)}…</summary><code>{candidate.userId}</code></details></div>
            <button type="button" className={`member-search-add${joined || pending || unknown ? " is-disabled" : ""}`} aria-disabled={disabled || undefined} aria-label={`${action} ${name}, ${email}, ${m.account} ${candidate.userId}`} onPointerDown={event => { if (event.currentTarget !== document.activeElement) event.preventDefault(); }} onClick={() => { if (!disabled) props.onAdd(candidate.userId); }}>{action}</button>
          </div>
          {own && props.addition.error !== null && !unknown && <div className="member-search-feedback" role="alert">{missing ? m.missing : m.addFailed}</div>}
          {unknown && <div className="member-search-feedback" role="status"><p>{m.unknown}</p>{props.addition.observed && <p>{joined ? m.joined : m.absent}</p>}<button type="button" className="member-search-link" disabled={props.addition.checking || props.admissionBlocked || !props.active} onClick={props.onCheck}>{props.addition.checking ? m.checking : m.check}</button></div>}
        </li>;
      })}</ul>}
      {search.moreError && <p className="member-search-page-error" role="alert">{m.moreFailed}</p>}
      {search.nextCursor !== null && <button className="button member-search-more" type="button" disabled={search.moreLoading || props.admissionBlocked || !props.permissionReady} onClick={search.more}>{search.moreLoading ? m.loading : search.moreError ? m.retry : m.more}</button>}
    </div>
    <footer className="member-search-footer"><span>{m.footer}</span><span>Esc {m.close}</span></footer>
  </div>;
  return <div ref={owner} className="member-search-owner"><div className="member-search-field"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input ref={input} type="search" value={search.draft} aria-label={m.label} placeholder={m.placeholder} aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? popupId : undefined} onFocus={() => setOpen(true)} onChange={event => { missingTarget.current = null; search.setDraft(event.currentTarget.value); setOpen(true); }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { event.preventDefault(); setOpen(false); } else if (event.key === "Enter") event.preventDefault(); else if (event.key === "ArrowDown" && visible) { event.preventDefault(); popup.current?.querySelector<HTMLElement>("button:not(:disabled),summary")?.focus(); } }} />{search.draft !== "" && <button type="button" aria-label={m.clear} className="member-search-clear" onClick={() => { missingTarget.current = null; search.setDraft(""); input.current?.focus(); }}>×</button>}</div>{content && createPortal(content, document.body)}</div>;
};
