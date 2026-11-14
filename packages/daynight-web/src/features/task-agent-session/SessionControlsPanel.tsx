import { operationErrorMessage, operationErrorText } from './operation-error';
import { NativeSelect, type NativeSelectProps } from '../../ui/native-select/NativeSelect';
import { useEffect, useId, useRef, useState } from 'react';
import type { SessionControls, SessionSetting } from '../../../../daynight/src/session/controls';
import type { SessionState } from './state';
import type { SessionSettingIntent } from './client';
import { useSessionMessages } from './messages';
import { operationPresentation, type SessionOperationProgress } from './operation-presentation';
import { useSessionControlMessages } from './controls-messages';

export type ControlsView = 'model' | 'permissions' | 'commands' | null;
export function SessionControlsPanel({ controls, state, intents, operationProgress = new Map(), view, disabled, nativeSelectTouchMode, onClose, onSelect, onRefresh }: {
  readonly nativeSelectTouchMode?: NativeSelectProps['touchMode'];
  readonly controls: SessionControls | undefined; readonly state: SessionState;
  readonly operationProgress?: SessionOperationProgress;
  readonly intents: ReadonlyMap<string, SessionSettingIntent>; readonly view: ControlsView; readonly disabled: boolean;
  readonly onClose: () => void; readonly onSelect: ((id: string, value: string, revision: string) => Promise<void>) | undefined;
  readonly onRefresh: (() => Promise<void>) | undefined;
}) {
  const controlMessages = useSessionControlMessages(state.snapshot?.identity.provider);
  const m = useSessionMessages(), id = useId(), panel = useRef<HTMLDivElement>(null);
  const [failureCause, setFailure] = useState<string | Error | null>(null), [busy, setBusy] = useState(false);
  const failure = operationErrorMessage(failureCause, state.operations, m.operationFailed);
  const inFlight = useRef(false);
  useEffect(() => {
    if (view !== 'model' && view !== 'permissions') return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.closest('.session-composer')?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [view, onClose]);
  if (view !== 'model' && view !== 'permissions') return null;
  const settings = controls?.settings.filter(setting => view === 'model' ? setting.category !== 'permission' : setting.category === 'permission') ?? [];
  async function select(setting: SessionSetting, value: string) {
    if (disabled || inFlight.current || !controls || !setting.mutable || value === setting.value || !setting.options.some(option => option.value === value) || !onSelect) return;
    inFlight.current = true; setBusy(true); setFailure(null);
    try { await onSelect(setting.id, value, controls.revision); }
    catch (error) { setFailure(error instanceof Error ? error : m.failure); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function refresh() {
    if (disabled || inFlight.current || !onRefresh) return;
    inFlight.current = true; setBusy(true); setFailure(null);
    try { await onRefresh(); } catch (error) { setFailure(error instanceof Error ? error : m.failure); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div ref={panel} className="session-controls-panel" aria-label={view === 'model' ? m.modelSettings : m.permissionSettings}>
    <div className="session-controls-heading"><strong>{view === 'model' ? m.modelSettings : m.permissionSettings}</strong><button className="inline-link" type="button" onClick={onClose}>{m.close}</button></div>
    {controls?.settingsError ? <p className="session-error" role="alert">{controls.settingsError}</p> : null}
    {settings.length === 0 ? <p className="session-control-note">{controls ? m.noSettings : m.controlsUnavailable}</p> : null}
    {settings.map(setting => {
      const intent = intents.get(setting.id), operation = intent && state.operations.get(intent.operationId);
      const pending = operation && !['confirmed', 'failed', 'rejected', 'expired'].includes(operation.state);
      const receipt = operation && operationPresentation(operation, operationProgress);
      const actualOption = setting.options.find(option => option.value === setting.value);
      const actual = actualOption ? controlMessages.optionLabel(setting, actualOption) : setting.value ?? m.unavailableValue;
      const description = controlMessages.settingDescription(setting);
      const value = setting.value ?? '';
      const failed = operation && ['failed', 'rejected', 'expired'].includes(operation.state);
      return <div className="session-control-setting" key={setting.id} data-setting-state={pending ? 'pending' : undefined}>
        <label htmlFor={`${id}-${setting.id}`}>{controlMessages.settingLabel(setting)}</label>
        <NativeSelect density="form" layout="fill" touchMode={nativeSelectTouchMode} pending={Boolean(pending)} id={`${id}-${setting.id}`} value={value} disabled={disabled || busy || !setting.mutable || !onSelect} onChange={event => void select(setting, event.target.value)}>
          {!setting.options.some(option => option.value === value) ? <option value={value}>{value || m.unavailableValue}</option> : null}
          {setting.options.map(option => <option key={option.value} value={option.value}>{controlMessages.optionLabel(setting, option)}</option>)}
        </NativeSelect>
        {pending && receipt === 'unknown' ? <p className="session-control-note" role="status">{m.settingUnknown} {m.currentValue}: {actual}</p> : null}
        {failed ? <p className="session-error" role="alert">{operationErrorText(operation.error?.message ?? '', m.operationFailed)}</p> : null}
        {description ? <p className="session-control-note">{description}</p> : null}
        {setting.scope === 'next_turn' ? <p className="session-control-note">{m.nextTurnSetting}</p> : null}
      </div>;
    })}
    <div className="session-controls-foot"><small>{m.providerConfirmed}</small><button type="button" className="inline-link" disabled={disabled || busy || !onRefresh} onClick={() => void refresh()}>{busy ? m.checking : m.refreshControls}</button></div>
    {failure ? <p className="session-error" role="alert">{failure}</p> : null}
  </div>;
}
