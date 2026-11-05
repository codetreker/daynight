import { useRef, useState, useLayoutEffect, useEffect, useId, useCallback, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { SessionComposerPresentation } from './session-presentation-slots';
import type { SessionDraft, SessionSettingIntent } from './client';
import type { SessionNativeCommand } from '../../../../daynight/src/session/controls';
import { SessionControlsPanel, type ControlsView } from './SessionControlsPanel';
import { SessionActivity } from './SessionActivity';
import '../../styles/session-composer.css';
import type { SessionState } from './state';
import { sessionCancelGate, sessionSendGate, sessionRespondGate, hasPendingOperation, sessionControlGate, hasPendingControls } from './state';
import { sessionNativeLabels, useSessionMessages } from './messages';

type CommandIntent = { readonly id: string; readonly name: string; readonly sessionId: string | undefined };
const parseCommand = (text: string) => /^\/([^\s]+)(?:\s([\s\S]*))?$/u.exec(text.trimStart());
function classifySubmission(text: string, commands: readonly SessionNativeCommand[], intent: CommandIntent | null) {
  const parsed = parseCommand(text), matches = commands.filter(command => command.name === parsed?.[1]);
  if (!intent && matches.length === 0) return { kind: 'message' } as const;
  const command = matches.length === 1 ? matches[0] : undefined;
  if (!command || intent && command.id !== intent.id) return { kind: 'invalid' } as const;
  return { kind: 'command', command, args: parsed?.[2] ?? '' } as const;
}

export function SessionComposer({ state, connected, sessionNoticeOwned = false, statusDescriptionId, authPaused = false, active = true, suppressKeyboardHint = false, draft, onDraftChange, onSend, onCancel, settingIntents = new Map(), onUpdateSetting, onExecuteCommand, onRefreshControls, presentation, inputRef: suppliedInputRef }: {
  readonly presentation?: SessionComposerPresentation; readonly inputRef?: RefObject<HTMLTextAreaElement | null>;
  readonly sessionNoticeOwned?: boolean; readonly statusDescriptionId?: string;
  readonly state: SessionState; readonly connected: boolean; readonly authPaused?: boolean; readonly active?: boolean; readonly suppressKeyboardHint?: boolean;
  readonly draft?: SessionDraft; readonly onDraftChange?: (text: string) => void;
  readonly settingIntents?: ReadonlyMap<string, SessionSettingIntent>;
  readonly onUpdateSetting?: (id: string, value: string, revision: string) => Promise<void>;
  readonly onExecuteCommand?: (id: string, args: string, revision: string, draftText?: string) => Promise<void>;
  readonly onRefreshControls?: () => Promise<void>;
  readonly onSend: (text: string) => Promise<void>; readonly onCancel: () => Promise<void>;
}) {
  const m = useSessionMessages(), menuId = useId();
  const [controlView, setControlView] = useState<ControlsView>(null);
  const [keyboardHint, setKeyboardHint] = useState({ hovered: false, focused: false, dismissed: false });
  const keyboardHintVisible = active && !suppressKeyboardHint && !keyboardHint.dismissed && (keyboardHint.hovered || keyboardHint.focused);
  useEffect(() => {
    if (!keyboardHintVisible) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopPropagation();
      setKeyboardHint(current => ({ ...current, dismissed: true }));
    };
    // A hovered hint can be visible while keyboard focus is outside the composer.
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [keyboardHintVisible]);
  const [commandIndex, setCommandIndex] = useState(0), [commandsDismissed, dismissCommands] = useState(false);
  const [candidateExplicit, setCandidateExplicit] = useState(false);
  const commandHighlightSource = useRef<'keyboard' | 'pointer'>('keyboard');
  const commandPointer = useRef<{ x: number; y: number } | null>(null);
  const commandAnchor = useRef<{ id: string; top: number } | null>(null);
  const commandIntent = useRef<CommandIntent | null>(null);
  const [commandPending, setCommandPending] = useState(false), [refreshing, setRefreshing] = useState(false);
  const commandInFlight = useRef(false);

  const [localText, setLocalText] = useState('');
  const localRevision = useRef(0);
  const text = draft?.text ?? localText;
  const localInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = suppliedInputRef ?? localInputRef;
  const formRef = useRef<HTMLFormElement>(null);
  const commandBodyRef = useRef<HTMLDivElement>(null);
  const focusCleanups = useRef(new Set<() => void>());
  useEffect(() => () => { for (const cleanup of focusCleanups.current) cleanup(); focusCleanups.current.clear(); }, []);
  const activeRef = useRef(active); activeRef.current = active;
  const setText = (value: string) => { if (parseCommand(value)?.[1] !== commandIntent.current?.name) commandIntent.current = null; setCommandIndex(0); setCandidateExplicit(false); dismissCommands(false); currentText.current = value; localRevision.current++; if (onDraftChange) onDraftChange(value); else setLocalText(value); };
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
    let frame: number | null = null;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const next = input.getBoundingClientRect().width;
      if (next !== width) {
        width = next;
        // Changing the observed height during delivery can trigger a resize loop.
        if (frame === null) frame = requestAnimationFrame(() => { frame = null; resize(); });
      }
    });
    observer?.observe(input);
    return () => { observer?.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [text, active]);
  useLayoutEffect(() => {
    if (!active) return;
    const form = formRef.current!, surface = form.querySelector<HTMLElement>('.session-composer-surface')!, input = inputRef.current!;
    const footer = form.querySelector<HTMLElement>('.session-composer-footer')!;
    const reserveInput = () => {
      const style = getComputedStyle(surface), field = getComputedStyle(input), actions = getComputedStyle(footer);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      const error = surface.querySelector<HTMLElement>('.session-error');
      const errorStyle = error ? getComputedStyle(error) : null;
      const minimum = pixels(field.minHeight) + footer.offsetHeight + pixels(actions.marginTop) + pixels(style.paddingTop) + pixels(style.paddingBottom) + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth) + (error ? error.offsetHeight + pixels(errorStyle!.marginTop) : 0);
      surface.style.minHeight = `${minimum}px`;
    };
    reserveInput();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reserveInput);
    observer?.observe(surface); observer?.observe(footer);
    return () => observer?.disconnect();
  }, [active, error]);
  const snapshot = state.snapshot;
  const controls = snapshot?.controls;
  const intent = commandIntent.current?.sessionId === snapshot?.sessionId && commandIntent.current?.name === parseCommand(text)?.[1] ? commandIntent.current : null;
  useLayoutEffect(() => { commandIntent.current = intent; }, [text, snapshot?.sessionId, intent]);
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
  const submission = classifySubmission(text, commands, intent);
  // Snapshots reconstruct controls; only catalog changes invalidate keyboard selection.
  const catalogSignature = JSON.stringify(controls ? [controls.revision, controls.commandsError, controls.commands.map(command => [command.id, command.name, command.description, command.argumentHint, command.available])] : null);
  useLayoutEffect(() => { setCommandIndex(0); setCandidateExplicit(false); commandHighlightSource.current = 'keyboard'; commandAnchor.current = null; commandPointer.current = null; }, [text, catalogSignature, showCommands, controlView, active]);
  const controlsAllowed = !authPaused && !pending && !commandPending && sessionControlGate(state, connected);
  const closeControls = useCallback(() => { setControlView(null); dismissCommands(true); inputRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!active || !showCommands) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !formRef.current?.contains(event.target)) {
        setControlView(null); dismissCommands(true);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [active, showCommands]);
  useEffect(() => {
    if (!active || !showCommands || suppressKeyboardHint) return;
    const owner = formRef.current?.closest('.task-agent-session') ?? formRef.current;
    const dismiss = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Escape' || key.defaultPrevented) return;
      // IME owns the key's default action; outer Session layers must not close.
      key.stopPropagation();
      if (key.isComposing || key.keyCode === 229 || composing.current) return;
      key.preventDefault(); closeControls();
    };
    owner?.addEventListener('keydown', dismiss);
    return () => owner?.removeEventListener('keydown', dismiss);
  }, [active, showCommands, suppressKeyboardHint, closeControls]);
  useLayoutEffect(() => {
    if (!active || !showCommands) return;
    const body = commandBodyRef.current;
    if (!body) return;
    const menu = body.parentElement!, heading = menu.querySelector<HTMLElement>('.session-command-heading')!;
    const reserveHeading = () => {
      const frame = getComputedStyle(menu), title = getComputedStyle(heading);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      menu.style.setProperty('--session-command-min-height', `${heading.offsetHeight + pixels(getComputedStyle(body).minHeight) + pixels(title.marginTop) + pixels(title.marginBottom) + pixels(frame.paddingTop) + pixels(frame.paddingBottom) + pixels(frame.borderTopWidth) + pixels(frame.borderBottomWidth)}px`);
    };
    reserveHeading();
    const list = body.querySelector<HTMLElement>('[role="listbox"]');
    const anchor = commandAnchor.current;
    commandAnchor.current = null;
    if (list && (anchor || commandHighlightSource.current === 'keyboard')) {
      list.style.paddingTop = '';
      list.style.paddingBottom = '';
    }
    if (anchor && list) {
      const target = document.getElementById(anchor.id);
      if (target && body.contains(target)) {
        const desired = target.offsetTop - anchor.top;
        // At either scroll boundary, temporary space keeps the pointer's target
        // stationary. Keyboard navigation removes that space before revealing.
        if (desired < 0) list.style.paddingTop = `${-desired}px`;
        body.scrollTop = Math.max(0, desired);
        if (desired > body.scrollTop) {
          list.style.paddingBottom = `${desired - body.scrollTop}px`;
          body.scrollTop = desired;
        }
      }
    }
    const reveal = () => {
      if (commandHighlightSource.current === 'pointer') return;
      const selected = body.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected) return;
      const top = selected.offsetTop, bottom = top + selected.offsetHeight;
      // The positioned catalog owns these unscaled offsets; never scroll an ancestor.
      if (top < body.scrollTop || selected.offsetHeight > body.clientHeight) body.scrollTop = top;
      else if (bottom > body.scrollTop + body.clientHeight) body.scrollTop = bottom - body.clientHeight;
    };
    reveal();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    observer?.observe(body);
    const headingObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reserveHeading);
    headingObserver?.observe(heading);
    return () => { observer?.disconnect(); headingObserver?.disconnect(); };
  }, [active, showCommands, selectedIndex, candidateExplicit, text, controls]);
  function highlightCommand(event: React.PointerEvent<HTMLButtonElement>, index: number) {
    if (event.pointerType === 'touch') return;
    const previous = commandPointer.current;
    commandPointer.current = { x: event.clientX, y: event.clientY };
    // Expanding a row can move another row under an otherwise stationary pointer.
    if (previous?.x === event.clientX && previous.y === event.clientY) return;
    commandHighlightSource.current = 'pointer';
    if (index === selectedIndex) return;
    const body = commandBodyRef.current;
    if (!body) return;
    commandAnchor.current = { id: event.currentTarget.id, top: event.currentTarget.offsetTop - body.scrollTop };
    setCommandIndex(index);
  }
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
    const matches = commands.filter(candidate => candidate.name === command.name);
    if (!command.available || matches.length !== 1 || matches[0]?.id !== command.id) { setError(m.commandUnavailable); return; }
    if (command.argumentHint && command.id !== '$model' && command.id !== '$permissions') {
      setText(`/${command.name} `); commandIntent.current = { id: command.id, name: command.name, sessionId: snapshot?.sessionId }; setControlView(null); dismissCommands(true); inputRef.current?.focus({ preventScroll: true });
    } else void executeCommand(command, '');
  }
  const sendReady = sessionSendGate(state, connected);
  const sendAllowed = sendReady && !authPaused;
  const cancelReady = sessionCancelGate(state, connected);
  const interruptRequested = interruptedTurn !== null && snapshot?.currentTurnId === interruptedTurn;
  const cancelAllowed = cancelReady && !authPaused && !interruptRequested;
  const latest = useRef({ sendAllowed, pending, cancelAllowed, cancelling }); latest.current = { sendAllowed, pending, cancelAllowed, cancelling };
  let notice: string | null = null;
  if (sessionNoticeOwned) notice = null;
  else if (!connected || state.recoveryRequired || !snapshot?.synchronized) notice = m.sessionSynchronizing;
  else if (hasPendingControls(state)) notice = m.settingPending;
  else if (hasPendingOperation(state, 'execute_command')) notice = m.operationUnknown;
  else if (hasPendingOperation(state, 'send_message')) notice = m.operationUnknown;
  else if (snapshot.initialInputState === 'unknown') notice = m.initialUnknown;
  else if (snapshot.initialInputState === 'failed') notice = m.initialFailed;
  else if (!['not_required', 'provider_accepted', 'confirmed'].includes(snapshot.initialInputState)) notice = m.initialPending;
  else if (snapshot.activity === 'working' && !snapshot.capabilities.steer) notice = m.noSteer;
  else if (snapshot.activity === 'waiting_input' && state.entries.some(entry => entry.kind === 'interaction' && entry.interaction.state === 'pending' && sessionRespondGate(state, connected && !authPaused, entry.interaction))) notice = null;
  else if (!sendReady) notice = m.readOnly;
  useLayoutEffect(() => {
    if (!active) return;
    const form = formRef.current!, section = form.closest('.task-agent-session');
    const taskBody = form.closest<HTMLElement>('.task-detail-body');
    const standalone = form.closest<HTMLElement>('.test-session-shell .content');
    const owner = taskBody ?? standalone;
    if (!section || !owner) return;
    const tabs = taskBody?.querySelector<HTMLElement>('.task-detail-tabs');
    const reserve = () => {
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      const outerHeight = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return element.offsetHeight + pixels(style.marginTop) + pixels(style.marginBottom);
      };
      const style = getComputedStyle(form);
      let required = pixels(style.paddingTop) + pixels(style.paddingBottom);
      for (const child of form.children) {
        if (!(child instanceof HTMLElement)) continue;
        const childStyle = getComputedStyle(child);
        required += (child.matches('.session-composer-surface, .session-command-menu') ? pixels(childStyle.minHeight) : child.offsetHeight) + pixels(childStyle.marginTop) + pixels(childStyle.marginBottom);
      }
      for (const child of section.children) {
        if (child instanceof HTMLElement && child !== form && !child.classList.contains('session-timeline-shell')) required += outerHeight(child);
      }
      if (tabs) required += outerHeight(tabs);
      if (standalone) {
        const page = section.parentElement!;
        for (const child of page.children) if (child instanceof HTMLElement && child !== section) required += outerHeight(child);
        const frame = getComputedStyle(standalone), session = getComputedStyle(section);
        required += pixels(frame.paddingTop) + pixels(frame.paddingBottom) + pixels(session.borderTopWidth) + pixels(session.borderBottomWidth);
      }
      owner.style.setProperty('--session-composer-space', `${Math.ceil(required)}px`);
    };
    reserve();
    // Surrounding metadata yields space to measured controls and remains scrollable.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reserve);
    observer?.observe(form);
    for (const child of section.children) observer?.observe(child);
    if (tabs) observer?.observe(tabs);
    for (const child of form.querySelectorAll('.session-composer-surface, .session-composer-footer, .session-command-heading')) observer?.observe(child);
    if (standalone) for (const child of section.parentElement!.children) if (child !== section) observer?.observe(child);
    return () => { observer?.disconnect(); owner.style.removeProperty('--session-composer-space'); };
  }, [active, showCommands, controlView, text, error, notice]);
  async function send() {
    const currentIntent = commandIntent.current?.sessionId === snapshot?.sessionId && commandIntent.current?.name === parseCommand(currentText.current)?.[1] ? commandIntent.current : null;
    const currentSubmission = classifySubmission(currentText.current, commands, currentIntent);
    if (currentSubmission.kind === 'invalid') { setError(m.commandUnavailable); return; }
    if (currentSubmission.kind === 'command') {
      await executeCommand(currentSubmission.command, currentSubmission.args); return;
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
  const input = <textarea aria-describedby={statusDescriptionId} ref={inputRef} aria-controls={showCommands ? `${menuId}-commands` : undefined} aria-activedescendant={showCommands && matchingCommands.length ? `${menuId}-command-${selectedIndex}` : undefined} aria-label={m.message} placeholder={m.placeholder} rows={1} value={text} onChange={(event) => { currentText.current = event.target.value; setText(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
      if (event.key === 'Tab' && event.shiftKey) {
        // Remove candidates before the browser and outer focus boundaries compute Tab order.
        if (showCommands) flushSync(() => { setControlView(null); dismissCommands(true); });
        return;
      }
      if (showCommands && matchingCommands.length && !authPaused) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); commandHighlightSource.current = 'keyboard'; commandAnchor.current = null; setCandidateExplicit(true); setCommandIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matchingCommands.length) % matchingCommands.length); return; }
        if ((event.key === 'Enter' && !event.shiftKey && candidateExplicit) || event.key === 'Tab') { event.preventDefault(); chooseCommand(matchingCommands[selectedIndex]!); return; }
      }
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault(); void send();
    }} />;
  const settings = <div className="session-controls-toolbar" aria-label={m.title}>
        <button type="button" className="session-control-trigger" aria-label={m.model} data-pending={modelPending || undefined} aria-expanded={controlView === 'model'} onClick={() => { setControlView(controlView === 'model' ? null : 'model'); dismissCommands(true); }}>{modelLabel}<span aria-hidden="true"> ▾</span></button>
        <button type="button" className="session-control-trigger" aria-label={sessionNativeLabels.permissions} lang="en" data-pending={permissionPending || undefined} aria-expanded={controlView === 'permissions'} onClick={() => { setControlView(controlView === 'permissions' ? null : 'permissions'); dismissCommands(true); }}>{sessionNativeLabels.permissions}<span aria-hidden="true"> ▾</span></button>
        <button type="button" className="session-control-trigger" aria-label={m.commands} aria-expanded={showCommands} onClick={() => { setControlView(showCommands ? null : 'commands'); dismissCommands(showCommands); inputRef.current?.focus({ preventScroll: true }); }}>/</button>
      </div>;
  const activity = <SessionActivity suppressStatus={sessionNoticeOwned} snapshot={snapshot} connected={connected} active={active} commandPending={commandPending || hasPendingOperation(state, 'execute_command')} interruptRequested={interruptRequested} interruptPending={cancelling || hasPendingOperation(state, 'cancel')} interruptAllowed={cancelAllowed} onInterrupt={() => void cancel()} />;
  const submit = <div className="session-actions" data-hint-open={keyboardHintVisible || undefined} onMouseEnter={() => setKeyboardHint(current => ({ ...current, hovered: true, dismissed: false }))} onMouseLeave={() => setKeyboardHint(current => ({ ...current, hovered: false }))} onFocus={() => setKeyboardHint(current => ({ ...current, focused: true, dismissed: false }))} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardHint(current => ({ ...current, focused: false })); }}><button className="button button-primary" type="submit" aria-describedby={`${menuId}-keyboard`} title={authPaused ? m.checkingIdentity : undefined} disabled={!(submission.kind !== 'message' ? commandSendAllowed : sendAllowed) || pending || commandPending || !text.trim()}><span lang="en">{pending ? sessionNativeLabels.pending : commandPending ? sessionNativeLabels.executingCommand : snapshot?.activity === 'working' ? sessionNativeLabels.steer : sessionNativeLabels.send}</span></button><span id={`${menuId}-keyboard`} className="session-composer-keyboard" role="tooltip">{m.keyboard} · /</span></div>;
  return <form ref={formRef} className="session-composer session-composer-adaptive" onSubmit={(event) => { event.preventDefault(); void send(); }} onKeyDown={event => {
    if (event.key !== 'Escape' || !(controlView || showCommands)) return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
    event.preventDefault(); closeControls();
  }}>
    <SessionControlsPanel controls={controls} state={state} intents={settingIntents} view={controlView} disabled={!controlsAllowed} onClose={closeControls} onSelect={onUpdateSetting} onRefresh={onRefreshControls} />
    {showCommands ? <div className="session-command-menu">
      <div className="session-command-heading"><strong>{m.nativeCommands}</strong><div className="session-command-actions"><button type="button" className="inline-link" disabled={!controlsAllowed || refreshing || !onRefreshControls} aria-busy={refreshing} onClick={() => void refreshCommands()}>{refreshing ? m.refreshingCommands : controls?.commandsError ? m.reloadCommands : m.refreshCommands}</button><button type="button" className="inline-link session-command-close" onClick={closeControls}>{m.close}</button></div></div>
      <div className="session-command-body" ref={commandBodyRef}>
      {controls?.commandsError ? <p className="session-error" role="alert">{controls.commandsError}</p> : null}
      {!controls ? <p className="session-control-note">{m.controlsUnavailable}</p> : null}
      {matchingCommands.length ? <div role="listbox" id={`${menuId}-commands`} aria-label={m.nativeCommands}>{matchingCommands.map((command, index) => <button key={command.id} id={`${menuId}-command-${index}`} type="button" role="option" aria-selected={index === selectedIndex} disabled={!command.available || authPaused || !connected || pending || commandPending} onPointerMove={event => highlightCommand(event, index)} onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)}><strong>/{command.name}</strong><span>{command.description}</span>{index === selectedIndex && command.argumentHint ? <small>{command.argumentHint}</small> : null}</button>)}</div> : <p className="session-control-note">{m.noCommands}</p>}
      </div>
    </div> : null}
    {notice ? <p className="session-notice" role="status">{notice}</p> : null}
    <div className="session-composer-surface">
    {input}
    {presentation?.renderAttachments ? <div className="session-composer-attachments">{presentation.renderAttachments({ text, inputRef, setText, snapshot, active, connected, authPaused })}</div> : null}
    <div className="session-composer-footer">
      {presentation?.renderFooter ? presentation.renderFooter({ settings, activity, submit }) : <>{settings}{activity}{submit}</>}
    </div>
    {error ? <p className="session-error" role="alert">{error}</p> : null}
    </div>
  </form>;
}
