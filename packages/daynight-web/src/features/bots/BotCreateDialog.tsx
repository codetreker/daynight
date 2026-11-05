import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { BotCreationUnknown, createBot, getBot, getBotDefaults, type Bot, type BotDefaults, type CreateBotInput } from '../../api/bots';
import { ApiError, isAbortError } from '../../api/client';
import type { WorkerAgent } from '../../api/types';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useBotMessages } from './messages';
import './create-dialog.css';

/** The page retains an unresolved request when this dialog closes. It is never resubmitted. */
export function BotCreateDialog({ unresolvedRequest, onUnresolvedRequestChange, onClose, onCreated }: {
  readonly unresolvedRequest: CreateBotInput | null;
  readonly onUnresolvedRequestChange: (input: CreateBotInput | null) => void;
  readonly onClose: () => void;
  readonly onCreated: (bot: Bot) => void;
}) {
  const scope = useTaskCacheScope(), m = useBotMessages();
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const defaultsRequest = useRef<AbortController | null>(null), operation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [name, setName] = useState(''), [workerId, setWorkerId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null), [provider, setProvider] = useState<WorkerAgent | null>(null);
  const [defaults, setDefaults] = useState<BotDefaults | null>(null), [loading, setLoading] = useState(true);
  const [defaultsError, setDefaultsError] = useState<unknown>(null), [error, setError] = useState<unknown>(null);
  const [validation, setValidation] = useState<'name' | 'cwd' | null>(null), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false);
  const unknown = unresolvedRequest !== null;
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const opener = document.activeElement, modal = dialog.current!;
    modal.showModal();
    if (unresolvedRequest === null) nameInput.current?.focus();
    return () => { modal.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  const loadDefaults = useCallback(async () => {
    defaultsRequest.current?.abort();
    const controller = new AbortController(), ticket = ++generation.current;
    defaultsRequest.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    setLoading(true); setDefaultsError(null);
    try {
      await scope.ready(signal);
      const next = await getBotDefaults(workerId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
      await scope.ready(signal);
      if (signal.aborted || ticket !== generation.current) return;
      setDefaults(next); setLoading(false);
    } catch (cause) {
      if (signal.aborted || ticket !== generation.current || isAbortError(cause)) return;
      setDefaultsError(cause); setLoading(false);
    }
  }, [scope, workerId]);
  useEffect(() => {
    if (unknown) { setLoading(false); return; }
    void loadDefaults();
    return () => { ++generation.current; defaultsRequest.current?.abort(); };
  }, [loadDefaults, unknown]);
  useEffect(() => () => { operation.current?.abort(); defaultsRequest.current?.abort(); }, []);

  const selected = defaults?.workers.find(item => item.workerId === (workerId ?? defaults.workerId));
  const configuration = loading ? null : defaults?.configuration;
  const selectedProvider = provider ?? configuration?.provider ?? '';
  const availableProvider = selected?.providers.find(item => item.provider === selectedProvider)?.available ?? false;
  const directory = cwd ?? configuration?.cwd ?? '';
  const unresolvedDefault = configuration == null && !(provider !== null && availableProvider && defaults?.reason?.startsWith('provider_')) && !(cwd !== null && cwd !== '' && defaults?.reason === 'invalid_cwd');
  const canCreate = !loading && defaultsError === null && selected?.state === 'available' && !unresolvedDefault && (selectedProvider === '' || availableProvider);
  const changeWorker = (value: string) => {
    ++generation.current; defaultsRequest.current?.abort(); setLoading(true);
    setWorkerId(value === '' ? null : value); setCwd(null); setProvider(null); setValidation(null); setError(null);
  };
  const finish = (bot: Bot) => { onUnresolvedRequestChange(null); onCreated(bot); };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (operation.current !== null || unknown || !canCreate || scope.isInvalidated) return;
    const trimmed = name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (!trimmed.isWellFormed() || [...trimmed].length < 1 || [...trimmed].length > 40 || /\p{Cc}/u.test(trimmed)) { setValidation('name'); nameInput.current?.focus(); return; }
    const explicitCwd = cwd === null || cwd === '' ? undefined : cwd;
    if (explicitCwd !== undefined && (!explicitCwd.isWellFormed() || /\p{Cc}/u.test(explicitCwd) || new TextEncoder().encode(explicitCwd).length > 4096 || !(selected?.platform === 'windows' ? /^[a-z]:[\\/]/i.test(explicitCwd) || /^\\\\[^\\]+\\[^\\]+/.test(explicitCwd) : explicitCwd.startsWith('/')))) { setValidation('cwd'); return; }
    const overrides = { ...(workerId === null ? {} : { workerId }), ...(explicitCwd === undefined ? {} : { cwd: explicitCwd }), ...(provider === null ? {} : { provider }) };
    const input: CreateBotInput = { id: crypto.randomUUID(), name: trimmed, ...(Object.keys(overrides).length ? { overrides } : {}) };
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    operation.current = controller; setBusy(true); setChecking(false); setError(null); setValidation(null);
    void (async () => {
      try {
        await scope.ready(signal);
        if (signal.aborted) return;
        // Persist the identity before dispatch; closing/navigation cannot turn a lost response into a new POST.
        onUnresolvedRequestChange(input);
        const bot = await createBot(input, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
        await scope.ready(signal);
        if (!signal.aborted) finish(bot);
      } catch (cause) {
        if (signal.aborted || isAbortError(cause)) return;
        if (!(cause instanceof BotCreationUnknown)) onUnresolvedRequestChange(null);
        setError(cause);
      } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
    })();
  };
  const check = () => {
    if (operation.current || unresolvedRequest === null || scope.isInvalidated) return;
    const input = unresolvedRequest, controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    operation.current = controller; setBusy(true); setChecking(true); setError(null);
    void (async () => {
      try {
        await scope.ready(signal);
        const bot = await getBot(input.id, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
        await scope.ready(signal);
        if (!signal.aborted) finish(bot);
      } catch (cause) {
        if (signal.aborted || isAbortError(cause)) return;
        setError(cause);
      } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
    })();
  };
  const detail = error instanceof BotCreationUnknown ? error.cause : error;
  const reason = !loading && defaultsError === null && !canCreate ? defaults?.reason ?? selected?.reason : null;
  return <dialog ref={dialog} className="auth-dialog bot-create-dialog" aria-labelledby="bot-create-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <header className="dialog-header"><h2 id="bot-create-title">{m.createTitle}</h2><button className="close-button" type="button" aria-label={m.closeCreate} disabled={busy} onClick={onClose}>×</button></header>
      <div className="dialog-body">
        {!unknown ? <>
          <div className="field"><label htmlFor="bot-name">{m.name}</label><input id="bot-name" ref={nameInput} value={name} onChange={event => { setName(event.target.value); setValidation(null); }} required autoComplete="off" disabled={busy} aria-invalid={validation === 'name'} /></div>
          {selected && <p className="bot-create-host">{m.host} <strong>{selected.machine.name}</strong></p>}
          <details className="bot-create-advanced"><summary>{m.advanced}</summary>
            <div className="field"><label htmlFor="bot-worker">{m.worker}</label><select id="bot-worker" value={workerId ?? ''} disabled={busy || defaults === null} onChange={event => changeWorker(event.target.value)}><option value="">{m.automatic}</option>{defaults?.workers.map(item => <option key={item.workerId} value={item.workerId}>{item.machine.name}{item.state === 'available' ? '' : ` · ${m.reason(item.state)}`}</option>)}</select></div>
            <div className="field"><label htmlFor="bot-cwd">{m.cwd}</label><input id="bot-cwd" value={directory} disabled={busy || loading || selected?.state !== 'available'} onChange={event => { setCwd(event.target.value); setValidation(null); }} autoComplete="off" spellCheck={false} aria-invalid={validation === 'cwd'} /></div>
            <div className="field"><label htmlFor="bot-agent">{m.agent}</label><select id="bot-agent" value={selectedProvider} disabled={busy || loading || selected?.state !== 'available'} onChange={event => setProvider(event.target.value === '' ? null : event.target.value as WorkerAgent)}><option value="">{m.defaultAgent}</option>{selected?.providers.map(item => <option key={item.provider} value={item.provider} disabled={!item.available}>{item.provider === 'claude' ? 'Claude Code' : item.provider === 'codex' ? 'Codex' : 'Copilot'}{item.available ? '' : ` · ${item.reason}`}</option>)}</select></div>
          </details>
          {loading && <p role="status">{m.loading}</p>}
          {defaultsError !== null && <div className="notice error" role="alert"><p>{m.defaultsError}</p><button className="button" type="button" onClick={() => void loadDefaults()}>{m.retry}</button></div>}
          {reason && <p className="notice error" role="alert">{m.reason(reason)}</p>}
          {validation && <p className="notice error" role="alert">{validation === 'name' ? m.invalidName : m.invalidCwd}</p>}
        </> : <div className="notice" role="status"><p>{busy ? checking ? m.checking : m.creating : m.unknown}</p><code>{unresolvedRequest.id}</code></div>}
        {detail !== null && !(error instanceof BotCreationUnknown) && <div className="notice error" role="alert"><p>{detail instanceof ApiError && detail.serverMessage ? detail.serverMessage : unknown ? m.notConfirmed : m.createError}</p>{detail instanceof ApiError && detail.requestId && <p>{m.requestId}: <code>{detail.requestId}</code></p>}</div>}
      </div>
      <footer className="dialog-footer"><button className="button" type="button" disabled={busy} onClick={onClose}>{unknown ? m.close : m.cancel}</button>{unknown ? <button className="button primary" type="button" disabled={busy} onClick={check}>{busy ? checking ? m.checking : m.creating : m.checkCreation}</button> : <button className="button primary" type="submit" disabled={busy || !canCreate}>{busy ? m.creating : m.create}</button>}</footer>
    </form>
  </dialog>;
}
