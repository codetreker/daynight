import { useEffect, useId, useRef, useState } from 'react';
import type { SessionControls, SessionSetting } from '../../../../daynight/src/session/controls';
import type { SessionState } from './state';
import type { SessionSettingIntent } from './client';
import { useSessionMessages } from './messages';

export type ControlsView = 'model' | 'permissions' | 'commands' | null;
export function SessionControlsPanel({ controls, state, intents, view, disabled, onClose, onSelect, onRefresh }: {
  readonly controls: SessionControls | undefined; readonly state: SessionState;
  readonly intents: ReadonlyMap<string, SessionSettingIntent>; readonly view: ControlsView; readonly disabled: boolean;
  readonly onClose: () => void; readonly onSelect: ((id: string, value: string, revision: string) => Promise<void>) | undefined;
  readonly onRefresh: (() => Promise<void>) | undefined;
}) {
  const m = useSessionMessages(), id = useId(), panel = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false);
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
    catch (error) { setFailure(error instanceof Error ? error.message : m.failure); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function refresh() {
    if (disabled || inFlight.current || !onRefresh) return;
    inFlight.current = true; setBusy(true); setFailure(null);
    try { await onRefresh(); } catch (error) { setFailure(error instanceof Error ? error.message : m.failure); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div ref={panel} className="session-controls-panel" aria-label={view === 'model' ? m.modelSettings : m.permissionSettings}>
    <div className="session-controls-heading"><strong>{view === 'model' ? m.modelSettings : m.permissionSettings}</strong><button className="inline-link" type="button" onClick={onClose}>{m.close}</button></div>
    {controls?.settingsError ? <p className="session-error" role="alert">{controls.settingsError}</p> : null}
    {settings.length === 0 ? <p className="session-control-note">{controls ? m.noSettings : m.controlsUnavailable}</p> : null}
    {settings.map(setting => {
      const intent = intents.get(setting.id), operation = intent && state.operations.get(intent.operationId);
      const pending = operation && !['confirmed', 'failed', 'rejected', 'expired'].includes(operation.state);
      const actual = setting.options.find(option => option.value === setting.value)?.label ?? setting.value ?? m.unavailableValue;
      const value = pending && intent ? intent.value : setting.value ?? '';
      const failed = operation && ['failed', 'rejected', 'expired'].includes(operation.state);
      return <div className="session-control-setting" key={setting.id} data-setting-state={pending ? 'pending' : undefined}>
        <label htmlFor={`${id}-${setting.id}`}>{setting.label}</label>
        <select id={`${id}-${setting.id}`} value={value} disabled={disabled || busy || !setting.mutable || !onSelect} onChange={event => void select(setting, event.target.value)}>
          {!setting.options.some(option => option.value === value) ? <option value={value}>{value || m.unavailableValue}</option> : null}
          {setting.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {pending ? <p className="session-control-note" role="status">{operation.state === 'unknown' ? m.settingUnknown : m.settingPending} {m.currentValue}: {actual}</p> : null}
        {failed ? <p className="session-error" role="alert">{operation.error?.message ?? m.failure}</p> : null}
        {setting.description ? <p className="session-control-note">{setting.description}</p> : null}
        {setting.scope === 'next_turn' ? <p className="session-control-note">{m.nextTurnSetting}</p> : null}
      </div>;
    })}
    <div className="session-controls-foot"><small>{m.providerConfirmed}</small><button type="button" className="inline-link" disabled={disabled || busy || !onRefresh} onClick={() => void refresh()}>{busy ? m.checking : m.refreshControls}</button></div>
    {failure ? <p className="session-error" role="alert">{failure}</p> : null}
  </div>;
}
