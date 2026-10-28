import { useRef, useState, useLayoutEffect, useEffect, useId } from 'react';
import type { SessionDraft, SessionSettingIntent } from './client';
import type { SessionNativeCommand } from '../../../../daynight/src/session/controls';
import { SessionControlsPanel, type ControlsView } from './SessionControlsPanel';
import { SessionActivity } from './SessionActivity';
import '../../styles/session-composer.css';
import type { SessionState } from './state';
import { sessionCancelGate, sessionSendGate, hasPendingOperation, sessionControlGate, hasPendingControls } from './state';
import { useSessionMessages } from './messages';

export function SessionComposer({ state, connected, authPaused = false, active = true, draft, onDraftChange, onSend, onCancel, settingIntents = new Map(), onUpdateSetting, onExecuteCommand, onRefreshControls }: {
  readonly state: SessionState; readonly connected: boolean; readonly authPaused?: boolean; readonly active?: boolean;
  readonly draft?: SessionDraft; readonly onDraftChange?: (text: string) => void;
  readonly settingIntents?: ReadonlyMap<string, SessionSettingIntent>;
  readonly onUpdateSetting?: (id: string, value: string, revision: string) => Promise<void>;
  readonly onExecuteCommand?: (id: string, args: string, revision: string, draftText?: string) => Promise<void>;
  readonly onRefreshControls?: () => Promise<void>;
  readonly onSend: (text: string) => Promise<void>; readonly onCancel: () => Promise<void>;
}) {
  const m = useSessionMessages(), menuId = useId();
  const [controlView, setControlView] = useState<ControlsView>(null);
  const [commandIndex, setCommandIndex] = useState(0), [commandsDismissed, dismissCommands] = useState(false);
  const [commandPending, setCommandPending] = useState(false), [refreshing, setRefreshing] = useState(false);
  const commandInFlight = useRef(false);

  const [localText, setLocalText] = useState('');
  const localRevision = useRef(0);
  const text = draft?.text ?? localText;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const focusCleanups = useRef(new Set<() => void>());
  useEffect(() => () => { for (const cleanup of focusCleanups.current) cleanup(); focusCleanups.current.clear(); }, []);
  const activeRef = useRef(active); activeRef.current = active;
  const setText = (value: string) => { setCommandIndex(0); dismissCommands(false); currentText.current = value; localRevision.current++; if (onDraftChange) onDraftChange(value); else setLocalText(value); };
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [interruptedTurn, setInterruptedTurn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorKind = useRef<'send' | 'cancel'>('send');
  const previousSubmission = useRef<SessionDraft['submission']>(null);
  useEffect(() => {
    const operationId = previousSubmission.current?.operationId;
    const operation = operationId ? state.operations.get(operationId) : undefined;
    if (errorKind.current === 'send' && operation && ['send_message', 'execute_command'].includes(operation.kind) && ['confirmed', 'provider_accepted'].includes(operation.state)) setError(null);
    previousSubmission.current = draft?.submission ?? null;
  }, [draft, state.operations]);
  const currentText = useRef(text); currentText.current = text;
  const composing = useRef(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !active) return;
    const resize = () => {
      input.style.height = 'auto';
      const style = getComputedStyle(input);
      const maximum = Number.parseFloat(style.maxHeight) || 180;
      const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
      input.style.height = `${Math.min(input.scrollHeight + border, maximum)}px`;
    };
    resize();
    let width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const next = input.getBoundingClientRect().width;
      if (next !== width) { width = next; resize(); }
    });
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [text, active]);
  const snapshot = state.snapshot;
  const controls = snapshot?.controls;
  const localCommands: SessionNativeCommand[] = [
    { id: '$model', name: 'model', description: m.modelSettings, argumentHint: null, available: true },
    { id: '$permissions', name: 'permissions', description: m.permissionSettings, argumentHint: null, available: true },
  ];
  const modelSetting = controls?.settings.find(setting => setting.category === 'model');
  const modelLabel = modelSetting?.options.find(option => option.value === modelSetting.value)?.label ?? modelSetting?.value ?? m.model;
  const modelPending = [...settingIntents.values()].some(intent => controls?.settings.find(setting => setting.id === intent.settingId)?.category !== 'permission' && ['unknown', 'accepted', 'offered', 'dispatching', 'provider_accepted'].includes(state.operations.get(intent.operationId)?.state ?? ''));
  const permissionPending = [...settingIntents.values()].some(intent => controls?.settings.find(setting => setting.id === intent.settingId)?.category === 'permission' && ['unknown', 'accepted', 'offered', 'dispatching', 'provider_accepted'].includes(state.operations.get(intent.operationId)?.state ?? ''));
  const commands = [...localCommands, ...(controls?.commands ?? []).filter(command => !['model', 'permissions'].includes(command.name))];
  const isCommand = text.trimStart().startsWith('/');
  const commandQuery = isCommand ? text.trimStart().slice(1) : '';
  const matchingCommands = commands.filter(command => command.name.startsWith(commandQuery));
  const showCommands = controlView === 'commands' || isCommand && !commandsDismissed && !/\s/u.test(commandQuery) && controlView === null;
  const selectedIndex = Math.min(commandIndex, Math.max(0, matchingCommands.length - 1));
  const controlsAllowed = !authPaused && !pending && !commandPending && sessionControlGate(state, connected);
  const closeControls = () => { setControlView(null); dismissCommands(true); inputRef.current?.focus({ preventScroll: true }); };
  async function refreshCommands() {
    if (!controlsAllowed || refreshing || !onRefreshControls) return;
    setRefreshing(true); setError(null);
    try { await onRefreshControls(); } catch (cause) { setError(cause instanceof Error ? cause.message : m.commandFailed); }
    finally { setRefreshing(false); }
  }
  async function executeCommand(command: SessionNativeCommand, args: string) {
    if (authPaused || !connected || pending || commandInFlight.current) return;
    if (command.id === '$model' || command.id === '$permissions') {
      if (args.trim()) { setError(m.commandUnavailable); return; }
      if (isCommand) setText('');
      setControlView(command.id === '$model' ? 'model' : 'permissions'); dismissCommands(true); return;
    }
    if (!controlsAllowed || !controls || !command.available || !onExecuteCommand) { setError(m.commandUnavailable); return; }
    const submitted = currentText.current, revision = localRevision.current;
    const commandDraft = submitted.trimStart().startsWith(`/${command.name}`);
    commandInFlight.current = true; setCommandPending(true); dismissCommands(true); setControlView(null); setError(null);
    try { await onExecuteCommand(command.id, args, controls.revision, commandDraft ? submitted : undefined); if (commandDraft && !draft && revision === localRevision.current) setText(''); }
    catch (cause) { errorKind.current = 'send'; setError(cause instanceof Error ? cause.message : m.commandFailed); }
    finally { commandInFlight.current = false; setCommandPending(false); }
  }
  function chooseCommand(command: SessionNativeCommand) {
    if (authPaused || !connected || pending || commandPending) return;
    if (command.argumentHint && command.id !== '$model' && command.id !== '$permissions') {
      setText(`/${command.name} `); setControlView(null); dismissCommands(true); inputRef.current?.focus({ preventScroll: true });
    } else void executeCommand(command, '');
  }
  const sendReady = sessionSendGate(state, connected);
  const sendAllowed = sendReady && !authPaused;
  const cancelReady = sessionCancelGate(state, connected);
  const interruptRequested = interruptedTurn !== null && snapshot?.currentTurnId === interruptedTurn;
  const cancelAllowed = cancelReady && !authPaused && !interruptRequested;
  const latest = useRef({ sendAllowed, pending, cancelAllowed, cancelling }); latest.current = { sendAllowed, pending, cancelAllowed, cancelling };
  let notice: string | null = null;
  if (!connected || state.recoveryRequired || !snapshot?.synchronized) notice = m.synchronizing;
  else if (hasPendingControls(state)) notice = m.settingPending;
  else if (hasPendingOperation(state, 'execute_command')) notice = m.operationUnknown;
  else if (hasPendingOperation(state, 'send_message')) notice = m.operationUnknown;
  else if (snapshot.initialInputState === 'unknown') notice = m.initialUnknown;
  else if (snapshot.initialInputState === 'failed') notice = m.initialFailed;
  else if (!['not_required', 'provider_accepted', 'confirmed'].includes(snapshot.initialInputState)) notice = m.initialPending;
  else if (snapshot.activity === 'working' && !snapshot.capabilities.steer) notice = m.noSteer;
  else if (!sendReady) notice = m.readOnly;
  async function send() {
    if (currentText.current.trimStart().startsWith('/')) {
      const match = /^\/([^\s]+)(?:\s([\s\S]*))?$/u.exec(currentText.current.trimStart());
      const matching = commands.filter(command => command.name === match?.[1]);
      const command = matching.length === 1 ? matching[0] : undefined;
      if (!command) { setError(controls?.commandsError ?? m.commandUnavailable); return; }
      await executeCommand(command, match?.[2] ?? ''); return;
    }
    if (!latest.current.sendAllowed || latest.current.pending || commandInFlight.current || !currentText.current.trim()) return;
    const submitted = currentText.current;
    const revision = localRevision.current;
    const input = inputRef.current, form = formRef.current;
    const owner = document.activeElement;
    let focusOwned = owner === input || owner instanceof HTMLButtonElement && owner.type === 'submit' && form?.contains(owner) === true;
    const trackFocus = (event: FocusEvent) => { if (event.target !== input && event.target !== owner) focusOwned = false; };
    document.addEventListener('focusin', trackFocus);
    const stopTracking = () => document.removeEventListener('focusin', trackFocus);
    focusCleanups.current.add(stopTracking);
    let accepted = false;
    setPending(true); latest.current.pending = true; setError(null);
    try { await onSend(submitted.trim()); accepted = true; if (!draft && localRevision.current === revision) setText(''); }
    catch (cause) { errorKind.current = 'send'; setError(cause instanceof Error ? cause.message : m.failure); }
    finally {
      stopTracking(); focusCleanups.current.delete(stopTracking);
      setPending(false); latest.current.pending = false;
      if (accepted && focusOwned && activeRef.current && input?.isConnected && !document.hidden && !input.closest('[hidden], [inert]')) input.focus({ preventScroll: true });
    }
  }
  async function cancel() {
    if (!latest.current.cancelAllowed || latest.current.cancelling) return;
    setCancelling(true); latest.current.cancelling = true; setError(null);
    const turnId = snapshot?.currentTurnId ?? null;
    try { await onCancel(); setInterruptedTurn(turnId); } catch (cause) { errorKind.current = 'cancel'; setError(cause instanceof Error ? cause.message : m.failure); }
    finally { setCancelling(false); latest.current.cancelling = false; }
  }
  const commandSendAllowed = !authPaused && connected && !pending && !commandPending && (commands.some(command => command.id.startsWith('$') && `/${command.name}` === text.trim()) || controlsAllowed);
  return <form ref={formRef} className="session-composer session-composer-adaptive" onSubmit={(event) => { event.preventDefault(); void send(); }} onKeyDown={event => { if (event.key === 'Escape' && (controlView || showCommands)) { event.preventDefault(); event.stopPropagation(); closeControls(); } }}>
    <SessionControlsPanel controls={controls} state={state} intents={settingIntents} view={controlView} disabled={!controlsAllowed} onClose={closeControls} onSelect={onUpdateSetting} onRefresh={onRefreshControls} />
    {showCommands ? <div className="session-command-menu">
      {controls?.commandsError ? <p className="session-error" role="alert">{controls.commandsError}</p> : null}
      <div className="session-command-heading"><strong>{m.nativeCommands}</strong><button type="button" className="inline-link" disabled={!controlsAllowed || refreshing || !onRefreshControls} onClick={() => void refreshCommands()}>{refreshing ? m.checking : m.retryCommands}</button></div>
      {!controls ? <p className="session-control-note">{m.controlsUnavailable}</p> : null}
      {matchingCommands.length ? <div role="listbox" id={`${menuId}-commands`} aria-label={m.nativeCommands}>{matchingCommands.map((command, index) => <button key={command.id} id={`${menuId}-command-${index}`} type="button" role="option" aria-selected={index === selectedIndex} disabled={!command.available || authPaused || !connected || pending || commandPending} onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)}><strong>/{command.name}</strong><span>{command.description}</span>{command.argumentHint ? <small>{command.argumentHint}</small> : null}</button>)}</div> : <p className="session-control-note">{m.noCommands}</p>}
    </div> : null}
    {notice ? <p className="session-notice" role="status">{notice}</p> : null}
    <textarea ref={inputRef} aria-controls={showCommands ? `${menuId}-commands` : undefined} aria-activedescendant={showCommands && matchingCommands.length ? `${menuId}-command-${selectedIndex}` : undefined} aria-label={m.message} placeholder={m.placeholder} rows={1} value={text} onChange={(event) => { currentText.current = event.target.value; setText(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
      if (showCommands && matchingCommands.length && !authPaused) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matchingCommands.length) % matchingCommands.length); return; }
        if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); chooseCommand(matchingCommands[selectedIndex]!); return; }
      }
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault(); void send();
    }} />
    <div className="session-composer-footer">
      <div className="session-controls-toolbar" aria-label={m.title}>
        <button type="button" className="session-control-trigger" aria-label={m.model} data-pending={modelPending || undefined} aria-expanded={controlView === 'model'} onClick={() => { setControlView(controlView === 'model' ? null : 'model'); dismissCommands(true); }}>{modelLabel}<span aria-hidden="true"> ▾</span></button>
        <button type="button" className="session-control-trigger" aria-label={m.permissions} data-pending={permissionPending || undefined} aria-expanded={controlView === 'permissions'} onClick={() => { setControlView(controlView === 'permissions' ? null : 'permissions'); dismissCommands(true); }}>{m.permissions}<span aria-hidden="true"> ▾</span></button>
        <button type="button" className="session-control-trigger" aria-label={m.commands} aria-expanded={showCommands} onClick={() => { setControlView(showCommands ? null : 'commands'); dismissCommands(showCommands); inputRef.current?.focus({ preventScroll: true }); }}>/</button>
      </div>
      <div className="session-actions"><button className="button button-primary" type="submit" title={authPaused ? m.checkingIdentity : undefined} disabled={!(isCommand ? commandSendAllowed : sendAllowed) || pending || commandPending || !text.trim()}>{pending ? m.pending : commandPending ? m.executingCommand : snapshot?.activity === 'working' ? m.steer : m.send}</button></div>
    </div>
    <SessionActivity snapshot={snapshot} connected={connected} active={active} commandPending={commandPending || hasPendingOperation(state, 'execute_command')} interruptRequested={interruptRequested} interruptPending={cancelling || hasPendingOperation(state, 'cancel')} interruptAllowed={cancelAllowed} onInterrupt={() => void cancel()} />
    <small className="session-composer-keyboard">{m.keyboard} · /</small>
    {error ? <p className="session-error" role="alert">{error}</p> : null}
  </form>;
}
