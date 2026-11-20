import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { ApiError, isAbortError, waitForAuthRequests } from "../../api/client";
import { credentialDescriptionProblem, normalizeCredentialDescription, type CredentialDescriptionReceipt, type CredentialDescriptionUpdate } from "../../api/credential-description";
import { useI18n } from "../../i18n/LocaleProvider";
import { ManagementDialog } from "./ManagementDialog";
import { ManagementError } from "./feedback";
import type { CredentialPanel } from "./useCredentialPanel";
import "./credential-description.css";

export const descriptionMessages = (locale: string) => locale === "zh-CN" ? {
  title: "编辑描述", label: "描述", optional: "（选填）", hint: "单行，最多 100 字符。", placeholder: "例如：家里 NAS 的备份脚本", save: "保存", saving: "正在保存…", cancel: "取消",
  unicode: "请输入有效的单行文本。", multiline: "描述只能包含一行，请移除换行。", tooLong: "描述最多 100 个字符。", saved: "描述已更新。", unavailable: "此记录已不可用。", uncertain: "尚未确认保存结果。请先读取实际状态，核对后再保存。", conflict: "描述已被其他操作修改。请读取实际状态后重新核对。", read: "读取实际状态", observed: "已显示当前描述，草稿已保留。请核对后再次保存。", current: "当前描述", empty: "无描述", createUnknown: "可能已签发令牌，但未收到确认。请先读取实际状态；明文无法从列表恢复。", createObserved: "已读取当前令牌列表。请核对是否已签发，再决定是否重新创建。", tokensRefresh: "刷新令牌",
} : {
  title: "Edit description", label: "Description", optional: "(optional)", hint: "One line, up to 100 characters.", placeholder: "For example: NAS backup script", save: "Save", saving: "Saving…", cancel: "Cancel",
  unicode: "Enter valid single-line text.", multiline: "Descriptions must be one line. Remove line breaks.", tooLong: "Descriptions can contain up to 100 characters.", saved: "Description updated.", unavailable: "This record is no longer available.", uncertain: "The save result is unknown. Read the current state before saving again.", conflict: "The description changed elsewhere. Read the current state to review it.", read: "Read current state", observed: "The current description is shown and your draft is preserved. Review it before saving again.", current: "Current description", empty: "No description", createUnknown: "A token may have been issued without a confirmed response. Read the current state first; its secret cannot be recovered from the list.", createObserved: "The current token list is shown. Check whether a token was issued before creating another.", tokensRefresh: "Refresh tokens",
};

type DescribedCredential = { readonly id: string; readonly description: string | null; readonly lastUsedAt: string | null; readonly createdAt: string };
type Draft = { readonly value: string; readonly expected: string | null; readonly error: unknown; readonly problem: ReturnType<typeof credentialDescriptionProblem>; readonly recovery: "unknown" | "conflict" | "observed" | null };
type DescriptionTransport = (id: string, input: CredentialDescriptionUpdate, signal: AbortSignal, mismatch: () => void, dispatch?: () => void) => Promise<CredentialDescriptionReceipt>;
const refusal = (error: unknown) => error instanceof ApiError && error.kind === "server" && ((error.status !== null && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)) || error.writeOutcome === "not_committed");
export const credentialWriteRefused = refusal;

export const DescriptionField = ({ value, onChange, problem, onProblem, disabled = false, optional = false, id = "credential-description-input" }: {
  readonly value: string; readonly onChange: (value: string) => void; readonly problem: ReturnType<typeof credentialDescriptionProblem>; readonly onProblem: (value: ReturnType<typeof credentialDescriptionProblem>) => void; readonly disabled?: boolean; readonly optional?: boolean; readonly id?: string;
}) => {
  const { locale } = useI18n(), m = descriptionMessages(locale);
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const problem = credentialDescriptionProblem(event.clipboardData.getData("text"));
    if (problem === "multiline" || problem === "unicode") { event.preventDefault(); onProblem(problem); }
  };
  return <div className="field credential-description-field"><label htmlFor={id}>{m.label} {optional && <span className="muted">{m.optional}</span>}</label><input id={id} type="text" value={value} onChange={event => { onChange(event.currentTarget.value); onProblem(null); }} onPaste={paste} disabled={disabled} autoComplete="off" placeholder={m.placeholder} aria-invalid={problem !== null} aria-describedby={`${id}-hint${problem === null ? "" : ` ${id}-error`}`} /><p className="hint" id={`${id}-hint`}>{m.hint}</p>{problem !== null && <p className="notice error" role="alert" id={`${id}-error`}>{m[problem]}</p>}</div>;
};

export const useCredentialDescriptions = <T extends DescribedCredential>({ panel, userId, mismatch, transport, visible, name, onOpen }: {
  readonly panel: CredentialPanel<T>; readonly userId: string; readonly mismatch: () => void; readonly transport: DescriptionTransport; readonly visible: boolean; readonly name: (item: T) => string; readonly onOpen: () => void;
}) => {
  const { locale, format } = useI18n(), m = descriptionMessages(locale);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map());
  const [selected, setSelected] = useState<string | null>(null), [notice, setNotice] = useState<"saved" | "unavailable" | null>(null);
  const revision = useRef(0), restore = useRef<string | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const patch = (id: string, next: Partial<Draft>) => setDrafts(before => { const updated = new Map(before); const draft = before.get(id); if (draft) updated.set(id, { ...draft, ...next }); return updated; });
  const close = () => {
    if (panel.pending) return;
    ++revision.current; restore.current = selected; setSelected(null);
    if (selected !== null) setDrafts(before => {
      const state = before.get(selected)?.recovery;
      if (state === "unknown" || state === "conflict") return before;
      const next = new Map(before); next.delete(selected); return next;
    });
  };
  useEffect(() => {
    if (selected === null && restore.current !== null && visible && !panel.pending && !panel.loading) {
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-credential-description]")).find(button => button.dataset.credentialDescription === restore.current);
      if (target !== undefined) target.focus();
      restore.current = null;
    }
  }, [selected, visible, panel.items, panel.pending, panel.loading]);
  useEffect(() => {
    if (panel.items === null) return;
    const present = new Set(panel.items.map(item => item.id));
    const missing = Array.from(drafts.keys()).filter(id => !present.has(id));
    if (missing.length === 0) return;
    setDrafts(before => { const next = new Map(before); for (const id of missing) next.delete(id); return next; });
    if (selected !== null && !present.has(selected)) { ++revision.current; setSelected(null); setNotice("unavailable"); }
  }, [panel.items]);
  const reconcile = (id: string) => { void panel.read(items => {
    const actual = items.find(item => item.id === id);
    if (actual === undefined) {
      setDrafts(before => { const next = new Map(before); next.delete(id); return next; });
      if (selectedRef.current === id) { ++revision.current; setSelected(null); }
      setNotice("unavailable");
    } else patch(id, { expected: actual.description, recovery: "observed", error: null });
  }); };
  const save = async (id: string, draft: Draft) => {
    if (panel.busy() || draft.recovery === "unknown" || draft.recovery === "conflict" || !panel.items?.some(item => item.id === id)) return;
    const problem = credentialDescriptionProblem(draft.value);
    if (problem !== null || draft.problem !== null) { patch(id, { problem: problem ?? draft.problem }); return; }
    const instance = revision.current;
    await panel.write(async context => {
      patch(id, { error: null }); setNotice(null);
      try {
        const saved = await transport(id, { expectedUserId: userId, expectedDescription: draft.expected, description: normalizeCredentialDescription(draft.value) }, context.signal, mismatch, context.onDispatch);
        await waitForAuthRequests(context.signal);
        if (!context.current()) return;
        panel.setItems(items => items!.map(item => item.id === saved.id ? { ...item, description: saved.description } : item));
        setDrafts(before => { const next = new Map(before); next.delete(id); return next; }); setNotice("saved");
        if (revision.current === instance && selectedRef.current === id) { restore.current = id; setSelected(null); }
      } catch (failure) {
        try { await waitForAuthRequests(context.signal); } catch { return; }
        if (!context.current()) return;
        if (failure instanceof ApiError && failure.kind === "server" && failure.status === 404) {
          panel.setItems(items => items!.filter(item => item.id !== id)); setDrafts(before => { const next = new Map(before); next.delete(id); return next; });
          if (revision.current === instance && selectedRef.current === id) setSelected(null); setNotice("unavailable");
        } else if (refusal(failure) || (!context.dispatched() && isAbortError(failure))) patch(id, { error: isAbortError(failure) ? null : failure });
        else patch(id, { error: failure, recovery: failure instanceof ApiError && failure.status === 409 ? "conflict" : "unknown" });
      }
    }, dispatched => { if (dispatched) patch(id, { recovery: "unknown" }); });
  };
  const open = (item: T) => {
    if (panel.busy()) return;
    onOpen(); ++revision.current; setNotice(null); setSelected(item.id);
    setDrafts(before => { if (before.has(item.id)) return before; const next = new Map(before); next.set(item.id, { value: item.description ?? "", expected: item.description, error: null, problem: null, recovery: null }); return next; });
  };
  const title = (item: T) => `${name(item)} · ${format.dateTime(item.createdAt)} · ${item.id}`;
  const pencil = (item: T) => <button className="credential-description-edit" data-credential-description={item.id} type="button" disabled={panel.loading || panel.pending} aria-label={`${m.title}${locale === "zh-CN" ? "：" : ": "}${title(item)}`} onClick={() => open(item)}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m10.5 2.5 3 3M2 14l3.5-.8L14 4.7a1.4 1.4 0 0 0 0-2l-.7-.7a1.4 1.4 0 0 0-2 0L2.8 10.5 2 14Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg></button>;
  const label = (item: T) => <><div className="credential-name"><span className="person-name">{name(item)}</span>{item.description === null && pencil(item)}</div>{item.description !== null && <div className="credential-description-line"><span className="credential-description" title={item.description}>{item.description}</span>{pencil(item)}</div>}</>;
  const item = panel.items?.find(row => row.id === selected), draft = selected === null ? undefined : drafts.get(selected);
  const unresolved = draft?.recovery === "unknown" || draft?.recovery === "conflict";
  const editor = selected !== null && item !== undefined && draft !== undefined ? <ManagementDialog title={m.title} busy={panel.pending} suspended={!visible} preserveFocus onClose={close} footer={<><button className="button" type="button" disabled={panel.pending} onClick={close}>{m.cancel}</button>{unresolved ? <button className="button primary" type="button" disabled={panel.loading || panel.pending} onClick={() => reconcile(selected)}>{m.read}</button> : <button className="button primary" type="submit" form="credential-description-form" disabled={panel.loading || panel.pending}>{panel.pending ? m.saving : m.save}</button>}</>}>
    <p className="credential-description-target">{title(item)}</p><form id="credential-description-form" noValidate onSubmit={event => { event.preventDefault(); void save(selected, draft); }}><DescriptionField value={draft.value} onChange={value => patch(selected, { value })} problem={draft.problem} onProblem={problem => patch(selected, { problem })} disabled={panel.pending} />{draft.recovery !== null && <div className="notice warning" role="status">{draft.recovery === "unknown" ? m.uncertain : draft.recovery === "conflict" ? m.conflict : m.observed}{draft.recovery === "observed" && <p>{m.current}: <span className="credential-current-description">{draft.expected ?? m.empty}</span></p>}</div>}{draft.error !== null && <ManagementError error={draft.error} />}{panel.error !== null && <ManagementError error={panel.error} retry={() => reconcile(selected)} />}</form>
  </ManagementDialog> : null;
  const recovery = <>{notice !== null && <p className="notice" role="status">{m[notice]}</p>}{Array.from(drafts).filter(([id, value]) => id !== selected && (value.recovery === "unknown" || value.recovery === "conflict")).map(([id]) => { const row = panel.items?.find(item => item.id === id); return row === undefined ? null : <div className="notice warning" key={id}><p>{title(row)} · {m.uncertain}</p><button className="button" type="button" disabled={panel.loading || panel.pending} onClick={() => open(row)}>{m.title}</button><button className="button" type="button" disabled={panel.loading || panel.pending} onClick={() => reconcile(id)}>{m.read}</button></div>; })}</>;
  return { label, editor, recovery, close, selected, retained: drafts.size > 0 || selected !== null, unresolved: (id: string) => { const state = drafts.get(id)?.recovery; return state === "unknown" || state === "conflict"; } };
};
