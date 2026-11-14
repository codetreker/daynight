import { NativeSelect, isNativeSelectPopupOpen } from '../../ui/native-select/NativeSelect';
import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { BotCreationUnknown, createBot, getBot, getBotDefaults, type Bot, type BotConfiguration, type BotDefaults, type CreateBotInput } from '../../api/bots';
import { ApiError, authRequestsPaused, isAbortError, subscribeAuthPause } from '../../api/client';
import type { WorkerAgent } from '../../api/types';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskCacheLifecycleChanged } from '../task-cache/project-cache';
import { useBotMessages } from './messages';
import { BotDirectoryBrowser } from './BotDirectoryBrowser';
import { useBotCreationModels } from './useBotCreationModels';
import { useCreationMessages } from './creation-messages';
import { confirmedBotCreations, forgetConfirmedBotCreation, pendingBotCreation, rememberBotCreation, rememberConfirmedBotCreation, subscribeConfirmedBotCreations } from './pending-creation';
import { WorkerReadonlyError } from '../../api/worker-readonly';
import './create-dialog.css';

/** The page retains an unresolved request when this form closes. It is never resubmitted. */
export function BotCreateForm({ enabled = true, unresolvedRequest, onUnresolvedRequestChange, onClose, onCreated }: {
  readonly enabled?: boolean;
  readonly unresolvedRequest: CreateBotInput | null;
  readonly onUnresolvedRequestChange: (input: CreateBotInput | null) => void;
  readonly onClose: () => void;
  readonly onCreated: (bot: Bot) => void;
}) {
  const scope = useTaskCacheScope(), m = useBotMessages(), c = useCreationMessages();
  const opener = useRef<Element | null>(null), nameInput = useRef<HTMLInputElement>(null), checkButton = useRef<HTMLButtonElement>(null);
  const defaultsRequest = useRef<AbortController | null>(null), operation = useRef<AbortController | null>(null);
  const publication = useRef<AbortController | null>(null), revision = useRef(0);
  const generation = useRef(0), composing = useRef(false), browseButton = useRef<HTMLButtonElement>(null), restoreBrowse = useRef(false);
  const defaultDirectories = useRef(new Map<string, string>()), lastConfigurations = useRef(new Map<string, BotConfiguration>());
  const [advanced, setAdvanced] = useState(false), [browsing, setBrowsing] = useState<{ workerId: string; workerName: string; path: string; defaultPath: string } | null>(null);
  const [model, setModel] = useState<string | null>(null), [effort, setEffort] = useState<string | null>(null);
  const [name, setName] = useState(''), [workerId, setWorkerId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null), [provider, setProvider] = useState<WorkerAgent | null>(null);
  const [defaults, setDefaults] = useState<BotDefaults | null>(null), [loading, setLoading] = useState(true);
  const [defaultsRevision, setDefaultsRevision] = useState(0);
  const [defaultsError, setDefaultsError] = useState<unknown>(null), [error, setError] = useState<unknown>(null);
  const [validation, setValidation] = useState<'name' | 'cwd' | null>(null), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false);
  const [confirmed, setConfirmed] = useState(() => confirmedBotCreations(scope));
  const unresolvedChange = useRef(onUnresolvedRequestChange); unresolvedChange.current = onUnresolvedRequestChange;
  useEffect(() => {
    const update = () => setConfirmed(confirmedBotCreations(scope));
    const unsubscribe = subscribeConfirmedBotCreations(scope, update); update();
    return unsubscribe;
  }, [scope]);
  const confirmedRequestId = unresolvedRequest !== null && confirmed.some(result => result.request.id === unresolvedRequest.id) ? unresolvedRequest.id : null;
  useEffect(() => {
    if (confirmedRequestId === null) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    void (async () => {
      try {
        while (!signal.aborted && !scope.isInvalidated) {
          try { await scope.ready(signal); }
          catch (cause) { if (!signal.aborted && authRequestsPaused() && isAbortError(cause) && !(cause instanceof TaskCacheLifecycleChanged && !cause.retryable)) continue; throw cause; }
          if (scope.hasIdentityMismatch) return;
          if (authRequestsPaused()) continue;
          if (!signal.aborted && pendingBotCreation(scope)?.id === confirmedRequestId && confirmedBotCreations(scope).some(result => result.request.id === confirmedRequestId)) unresolvedChange.current(null);
          return;
        }
      } catch (cause) { if (!signal.aborted && !isAbortError(cause)) setError(cause); }
    })();
    return () => controller.abort();
  }, [scope, confirmedRequestId]);
  const unknown = unresolvedRequest !== null && confirmedRequestId === null;
  const controlsEnabled = enabled && !scope.isInvalidated && !authRequestsPaused();
  const admitted = useRef(controlsEnabled); admitted.current = controlsEnabled;
  const selected = defaults?.workers.find(item => item.workerId === (workerId ?? defaults.workerId));
  const configuration = defaults?.workerId === (workerId ?? defaults?.workerId) ? defaults?.configuration : selected?.configuration;
  // A rejected combination still needs its previous target to offer a repair.
  const targetConfiguration = configuration ?? (selected ? lastConfigurations.current.get(selected.workerId) ?? selected.configuration : null);
  const selectedProvider = provider ?? targetConfiguration?.provider ?? null;
  const directory = cwd ?? targetConfiguration?.cwd ?? '';
  const validDirectory = cwd === null || cwd === '' || cwd.isWellFormed() && !/\p{Cc}/u.test(cwd) && new TextEncoder().encode(cwd).length <= 4096 && (selected?.platform === 'windows' ? /^[a-z]:[\\/]/i.test(cwd) || /^\\\\[^\\]+\\[^\\]+/.test(cwd) : cwd.startsWith('/'));
  const choices = { ...(cwd === null || cwd === '' ? {} : { cwd }), ...(provider === null ? {} : { provider }), ...(model === null ? {} : { model }), ...(effort === null ? {} : { reasoningEffort: effort }) };
  const invalidateDefaults = () => { ++generation.current; defaultsRequest.current?.abort(); setDefaultsRevision(value => value + 1); setLoading(true); setDefaultsError(null); setError(null); };
  const pinWorker = () => { if (selected) setWorkerId(selected.workerId); };
  useLayoutEffect(() => { if (browsing === null && restoreBrowse.current) { restoreBrowse.current = false; browseButton.current?.focus(); } }, [browsing]);
  useLayoutEffect(() => { if (unknown && !busy) checkButton.current?.focus(); }, [unknown, busy]);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    (unresolvedRequest === null ? nameInput.current : checkButton.current)?.focus();
  }, []);
  const close = () => {
    onClose();
    // Navigation unmounts the form without moving focus back into the list.
    if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
  };
  const loadDefaults = useCallback(async () => {
    defaultsRequest.current?.abort();
    const controller = new AbortController(), ticket = ++generation.current;
    defaultsRequest.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    setLoading(true); setDefaultsError(null);
    try {
      await scope.ready(signal);
      const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
      const currentChoices = { ...(cwd === null || cwd === '' ? {} : { cwd }), ...(provider === null ? {} : { provider }), ...(model === null ? {} : { model }), ...(effort === null ? {} : { reasoningEffort: effort }) };
      const next = Object.keys(currentChoices).length === 0 ? await getBotDefaults(workerId, signal, admission) : await getBotDefaults(workerId, signal, admission, currentChoices);
      await scope.ready(signal);
      if (signal.aborted || ticket !== generation.current) return;
      if (next.workerId && next.configuration) {
        lastConfigurations.current.set(next.workerId, next.configuration);
        if (cwd === null || cwd === '') defaultDirectories.current.set(next.workerId, next.configuration.cwd);
      }
      setDefaults(next); setLoading(false);
    } catch (cause) {
      if (signal.aborted || ticket !== generation.current || isAbortError(cause)) return;
      setDefaultsError(cause); setLoading(false);
    }
  }, [scope, workerId, cwd, provider, model, effort]);
  useEffect(() => {
    if (unknown || !controlsEnabled || !validDirectory) { setLoading(false); return; }
    void loadDefaults();
    return () => { ++generation.current; defaultsRequest.current?.abort(); };
  }, [loadDefaults, defaultsRevision, unknown, controlsEnabled, validDirectory]);
  useEffect(() => () => { const current = operation.current; operation.current = null; current?.abort(); publication.current?.abort(); defaultsRequest.current?.abort(); }, []);

  const availableProvider = selected?.providers.find(item => item.provider === selectedProvider)?.available ?? false;
  const canCreate = !loading && defaultsError === null && selected?.state === 'available' && configuration != null && availableProvider && validDirectory;
  const models = useBotCreationModels(advanced && !unknown && controlsEnabled && selected?.state === 'available' && validDirectory, selected?.workerId ?? null, selectedProvider, directory || null, model);
  const nativeModelDelegated = configuration?.model === null && configuration.selection?.modelSource === 'native';
  // Discovery fills only unresolved native values; server preferences and form
  // overrides remain authoritative, and observations never enter choices.
  const observedDefaults = models.value?.selectionError === null ? models.value.defaults : null;
  const observedModel = nativeModelDelegated ? observedDefaults?.model : undefined;
  const effectiveModel = model ?? configuration?.model ?? observedModel?.value ?? null;
  const modelOption = models.value?.models.find(option => option.id === effectiveModel || effectiveModel !== null && option.aliases.includes(effectiveModel));
  const observedModelValue = observedDefaults?.model.value;
  const sameObservedModel = effectiveModel !== null && observedModelValue != null
    && (effectiveModel === observedModelValue || modelOption?.id === observedModelValue || modelOption?.aliases.includes(observedModelValue));
  const observedEffort = configuration?.reasoningEffort === null && configuration.selection?.reasoningEffortSource === 'native' && sameObservedModel ? observedDefaults?.reasoningEffort : undefined;
  const modelSource = model !== null ? 'explicit' : configuration?.model != null ? configuration.selection?.modelSource : observedModel?.source ?? configuration?.selection?.modelSource;
  const effortSource = effort !== null ? 'explicit' : configuration?.reasoningEffort != null ? configuration.selection?.reasoningEffortSource : observedEffort?.source ?? configuration?.selection?.reasoningEffortSource;
  const visibleModels = models.value?.models.filter(option => !option.hidden);
  const efforts = modelOption?.reasoningEfforts;
  const changeWorker = (value: string) => {
    revision.current++; invalidateDefaults(); setWorkerId(value === '' ? null : value); setCwd(null); setProvider(null); setModel(null); setEffort(null); setValidation(null); setBrowsing(null);
  };
  const changeCwd = (value: string | null) => { revision.current++; invalidateDefaults(); if (value) pinWorker(); setCwd(value); setValidation(null); };
  const changeProvider = (value: string) => { revision.current++; invalidateDefaults(); if (value) pinWorker(); setProvider(value === '' ? null : value as WorkerAgent); setModel(null); setEffort(null); };
  const changeModel = (value: string) => { revision.current++; invalidateDefaults(); if (value) pinWorker(); setModel(value || null); setEffort(null); };
  const changeEffort = (value: string) => { revision.current++; invalidateDefaults(); if (value) pinWorker(); setEffort(value || null); };
  const reset = () => { revision.current++; invalidateDefaults(); setWorkerId(null); setCwd(null); setProvider(null); setModel(null); setEffort(null); setValidation(null); };
  const returnFromBrowse = () => { restoreBrowse.current = true; setBrowsing(null); };
  const publish = (input: CreateBotInput, bot: Bot, submittedRevision: number, location: string, operationPaused: boolean) => {
    rememberConfirmedBotCreation(scope, input, bot);
    publication.current?.abort();
    const controller = new AbortController(); publication.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    let paused = operationPaused || authRequestsPaused();
    const unsubscribe = subscribeAuthPause(() => { paused = true; });
    void scope.ready(signal).then(() => {
      if (signal.aborted || publication.current !== controller || authRequestsPaused() || scope.isInvalidated) return;
      onUnresolvedRequestChange(null);
      if (!paused && revision.current === submittedRevision && window.location.href === location) { forgetConfirmedBotCreation(scope, input.id); onCreated(bot); }
    }).catch(cause => {
      if (!signal.aborted && !isAbortError(cause)) setError(cause);
    }).finally(() => { unsubscribe(); if (publication.current === controller) publication.current = null; });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (operation.current !== null || composing.current || unresolvedRequest !== null || !canCreate || !controlsEnabled || authRequestsPaused() || scope.isInvalidated) return;
    const trimmed = name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (!trimmed.isWellFormed() || [...trimmed].length < 1 || [...trimmed].length > 40 || /\p{Cc}/u.test(trimmed)) { setValidation('name'); nameInput.current?.focus(); return; }
    const explicitCwd = cwd === null || cwd === '' ? undefined : cwd;
    if (explicitCwd !== undefined && (!explicitCwd.isWellFormed() || /\p{Cc}/u.test(explicitCwd) || new TextEncoder().encode(explicitCwd).length > 4096 || !(selected?.platform === 'windows' ? /^[a-z]:[\\/]/i.test(explicitCwd) || /^\\\\[^\\]+\\[^\\]+/.test(explicitCwd) : explicitCwd.startsWith('/')))) { setValidation('cwd'); return; }
    const overrides = { ...(workerId === null ? {} : { workerId }), ...choices };
    const input: CreateBotInput = { id: crypto.randomUUID(), name: trimmed, ...(Object.keys(overrides).length ? { overrides } : {}) };
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    const submittedRevision = revision.current, location = window.location.href;
    let dispatched = false, remembered = false, operationPaused = false;
    publication.current?.abort();
    operation.current = controller; setBusy(true); setChecking(false); setError(null); setValidation(null);
    const unsubscribe = subscribeAuthPause(() => { operationPaused = true; if (!dispatched) controller.abort(); });
    void (async () => {
      try {
        await scope.ready(signal);
        if (signal.aborted || !admitted.current || authRequestsPaused() || scope.isInvalidated) return;
        // Persist the identity before dispatch; a lost response must never produce a new POST.
        onUnresolvedRequestChange(input); remembered = true;
        const bot = await createBot(input, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, onDispatch: () => { dispatched = true; } });
        rememberConfirmedBotCreation(scope, input, bot);
        if (!signal.aborted) publish(input, bot, submittedRevision, location, operationPaused);
      } catch (cause) {
        if (cause instanceof BotCreationUnknown) { if (operation.current === controller && !scope.isInvalidated) setError(cause); return; }
        if (remembered && (!dispatched || !isAbortError(cause)) && pendingBotCreation(scope)?.id === input.id) {
          if (operation.current === controller) onUnresolvedRequestChange(null);
          else rememberBotCreation(scope, null);
        }
        if (operation.current === controller && !signal.aborted && !isAbortError(cause)) setError(cause);
      } finally { unsubscribe(); if (operation.current === controller) { operation.current = null; setBusy(false); } }
    })();
  };
  const check = () => {
    if (operation.current || unresolvedRequest === null || !enabled || authRequestsPaused() || scope.isInvalidated) return;
    const input = unresolvedRequest, controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    const submittedRevision = revision.current, location = window.location.href;
    operation.current = controller; setBusy(true); setChecking(true); setError(null);
    let operationPaused = false;
    const unsubscribe = subscribeAuthPause(() => { operationPaused = true; controller.abort(); });
    void (async () => {
      try {
        await scope.ready(signal);
        const bot = await getBot(input.id, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
        rememberConfirmedBotCreation(scope, input, bot);
        if (!signal.aborted) publish(input, bot, submittedRevision, location, operationPaused);
      } catch (cause) {
        if (operation.current === controller && !signal.aborted && !isAbortError(cause)) setError(cause);
      } finally { unsubscribe(); if (operation.current === controller) { operation.current = null; setBusy(false); } }
    })();
  };
  const detail = error instanceof BotCreationUnknown ? error.cause : error;
  const reason = !loading && defaultsError === null && !canCreate ? defaults?.reason ?? selected?.reason : null;
  const agentName = (value: string | null | undefined) => value === 'codex' ? 'Codex' : value === 'claude' ? 'Claude Code' : value === 'copilot' ? 'Copilot' : c.unknownValue;
  const sourceValue = (value: string | null | undefined, source: keyof typeof c.sources | undefined) => `${value ?? (source === 'native' ? c.nativeValue : c.unknownValue)} · ${c.sources[source ?? 'unknown']}`;
  const modelSummary = sourceValue(effectiveModel, modelSource);
  const effortSummary = sourceValue(effort ?? configuration?.reasoningEffort ?? observedEffort?.value, effortSource);
  const sources = [...new Set([modelSource ?? 'unknown', effortSource ?? 'unknown'] as const)].map(source => c.sources[source]).join(' / ');
  const effectiveDescription = `${selected?.machine.name ?? ''} · ${agentName(selectedProvider)} · ${workerId === null && Object.keys(choices).length === 0 ? c.defaultConfiguration : c.customConfiguration} · ${sources}`;
  const configurationError = defaultsError instanceof ApiError && defaultsError.serverMessage ? defaultsError.serverMessage : m.defaultsError;
  const capabilityError = models.error instanceof WorkerReadonlyError ? `${c.modelError} (${models.error.code})` : models.error ? c.modelError : null;
  if (browsing !== null) return <BotDirectoryBrowser workerId={browsing.workerId} workerName={browsing.workerName} initialPath={browsing.path} defaultPath={browsing.defaultPath} enabled={controlsEnabled}
    onCancel={returnFromBrowse} onSelect={path => { if (!controlsEnabled || selected?.workerId !== browsing.workerId) return; setWorkerId(browsing.workerId); changeCwd(path); returnFromBrowse(); }} />;
  return <form className="bot-create-form" aria-labelledby="bot-create-title" onSubmit={submit} onKeyDown={event => {
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229)) { event.preventDefault(); return; }
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
    // Leave the native cancellation intact while protecting the outer dialog.
    if (isNativeSelectPopupOpen(event.target)) { event.stopPropagation(); return; }
    event.preventDefault(); event.stopPropagation();
    if (!busy) close();
  }}>
      <header className="bot-create-header"><h2 id="bot-create-title">{m.createTitle}</h2><AccountRefreshNotice /><button className="close-button" type="button" aria-label={m.closeCreate} disabled={busy} onClick={close}>×</button></header>
      <div className="bot-create-body">
        {!unknown ? <>
          <div className="field"><label htmlFor="bot-name">{m.name}</label><input id="bot-name" ref={nameInput} value={name} onChange={event => { revision.current++; setName(event.target.value); setValidation(null); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} required autoComplete="off" disabled={busy} aria-invalid={validation === 'name'} /></div>
          <details className="bot-create-summary-details"><summary className="bot-create-summary" aria-label={c.configurationDetails}><span>{selected ? effectiveDescription : '\u00a0'}</span></summary>
            {selected && <div className="bot-create-effective"><p>{selected.machine.name}</p><p>{directory}</p><p>{agentName(selectedProvider)}</p><p>{c.model}: {modelSummary}</p><p>{c.effort}: {effortSummary}</p></div>}
          </details>
          <details className="bot-create-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary onClick={event => { event.preventDefault(); setAdvanced(value => !value); }}>{m.advanced}</summary>
            <div className="field"><label htmlFor="bot-worker">{m.worker}</label><NativeSelect density="form" layout="fill" touchMode="responsive" id="bot-worker" value={workerId ?? ''} disabled={busy || defaults === null} onChange={event => changeWorker(event.target.value)}><option value="">{m.automatic}{selected ? ` · ${selected.machine.name}` : ''}</option>{defaults?.workers.map(item => <option key={item.workerId} value={item.workerId}>{item.machine.name}{item.state === 'available' ? '' : ` · ${m.reason(item.state)}`}</option>)}</NativeSelect></div>
            <div className="field"><label htmlFor="bot-cwd">{m.cwd}</label><div className="bot-create-directory"><input id="bot-cwd" value={directory} disabled={busy || selected?.state !== 'available'} onChange={event => changeCwd(event.target.value)} autoComplete="off" spellCheck={false} aria-invalid={validation === 'cwd' || !validDirectory} /><button ref={browseButton} className="button" type="button" disabled={busy || !controlsEnabled || loading || selected?.state !== 'available' || !directory || !validDirectory} onClick={() => { if (!selected || !controlsEnabled) return; setBrowsing({ workerId: selected.workerId, workerName: selected.machine.name, path: directory, defaultPath: defaultDirectories.current.get(selected.workerId) ?? selected.configuration?.cwd ?? directory }); }}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 7V5h6l2 3h10v11H3Z" /></svg>{c.browse}</button></div><button className="bot-create-default-action" type="button" disabled={busy || !cwd} onClick={() => changeCwd(null)}>{c.defaultDirectory}</button></div>
            <div className="field"><label htmlFor="bot-agent">{m.agent}</label><NativeSelect density="form" layout="fill" touchMode="responsive" id="bot-agent" value={provider ?? ''} disabled={busy || selected?.state !== 'available'} onChange={event => changeProvider(event.target.value)}><option value="">{c.defaultValue} · {agentName(configuration?.provider)}</option>{selected?.providers.map(item => <option key={item.provider} value={item.provider} disabled={!item.available}>{agentName(item.provider)}{item.available ? '' : ` · ${item.reason}`}</option>)}</NativeSelect></div>
            <div className="bot-create-model-row">
              <div className="field"><label htmlFor="bot-model">{c.model}</label><NativeSelect density="form" layout="fill" touchMode="responsive" id="bot-model" value={model ?? ''} disabled={busy || models.value === null && model === null} onChange={event => changeModel(event.target.value)}><option value="">{c.defaultValue} · {modelSummary}</option>{model !== null && !visibleModels?.some(option => option.id === model) && <option value={model}>{model}</option>}{visibleModels?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</NativeSelect></div>
              <div className="field"><label htmlFor="bot-effort">{c.effort}</label><NativeSelect density="form" layout="fill" touchMode="responsive" id="bot-effort" value={effort ?? ''} disabled={busy || !efforts?.length && effort === null} onChange={event => changeEffort(event.target.value)}><option value="">{c.defaultValue} · {effortSummary}</option>{effort !== null && !efforts?.includes(effort) && <option value={effort}>{effort}</option>}{efforts?.map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect></div>
            </div>
            <div className="bot-create-capabilities">
              {models.value !== null && !models.busy && !efforts?.length && <p className="bot-create-field-hint">{modelOption ? c.noEfforts : c.unknownEfforts}</p>}
              {capabilityError && <div className="notice error" role="alert"><p>{capabilityError}</p><button className="button" type="button" disabled={!controlsEnabled || models.busy} onClick={() => void models.reload()}>{m.retry}</button></div>}
              {models.value?.selectionError && (configuration == null || nativeModelDelegated) && <p className="notice error" role="alert">{models.value.selectionError.message}</p>}
            </div>
            <button className="bot-create-default-action" type="button" disabled={busy} onClick={reset}>{c.resetAll}</button>
          </details>
          {confirmed.map(result => <div className="notice" role="status" key={result.request.id}><p>{c.confirmedCreation} <code>{result.request.id}</code></p><button className="button" type="button" disabled={!controlsEnabled || busy} onClick={() => {
            if (authRequestsPaused() || scope.isInvalidated) return;
            publication.current?.abort(); forgetConfirmedBotCreation(scope, result.request.id); if (unresolvedRequest?.id === result.request.id) onUnresolvedRequestChange(null); onCreated(result.bot);
          }}>{c.openCreated}</button></div>)}
          {defaultsError !== null && <div className="notice error" role="alert"><p>{configurationError}</p><button className="button" type="button" disabled={!controlsEnabled} onClick={() => void loadDefaults()}>{m.retry}</button></div>}
          {reason && <div className="notice error" role="alert"><p>{m.reason(reason)}</p><button className="button" type="button" disabled={!controlsEnabled} onClick={() => void loadDefaults()}>{m.retry}</button></div>}
          {(validation || !validDirectory) && <p className="notice error" role="alert">{validation === 'name' ? m.invalidName : m.invalidCwd}</p>}
        </> : <div className="notice" role="status"><p>{busy ? checking ? m.checking : m.creating : m.unknown}</p><code>{unresolvedRequest.id}</code></div>}
        {detail !== null && !(error instanceof BotCreationUnknown) && <div className="notice error" role="alert"><p>{detail instanceof ApiError && detail.serverMessage ? detail.serverMessage : unknown ? m.notConfirmed : m.createError}</p>{detail instanceof ApiError && detail.requestId && <p>{m.requestId}: <code>{detail.requestId}</code></p>}</div>}
      </div>
      <footer className="bot-create-actions"><button className="button" type="button" disabled={busy} onClick={close}>{unknown ? m.close : m.cancel}</button>{unknown ? <button ref={checkButton} className="button primary" type="button" disabled={busy || !controlsEnabled} onClick={check}>{busy ? checking ? m.checking : m.creating : m.checkCreation}</button> : <button className="button primary" type="submit" disabled={busy || unresolvedRequest !== null || !controlsEnabled || !canCreate}>{busy ? m.creating : m.create}</button>}</footer>
  </form>;
}
