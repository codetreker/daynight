import { useLayoutEffect, useRef } from 'react';
import type { WorkerConfigurationResource, WorkerControlMode } from '../../../api/worker-configuration';
import { useI18n } from '../../../i18n/LocaleProvider';
import { NativeSelect } from '../../../ui/native-select/NativeSelect';
import { ConfigurationFeedback } from './ConfigurationFeedback';

export const ConfigurationControlModeField = ({ resource, value, changed, disabled, onChange }: {
  readonly resource: WorkerConfigurationResource;
  readonly value: WorkerControlMode | null | undefined;
  readonly changed: boolean;
  readonly disabled: boolean;
  readonly onChange: (mode: WorkerControlMode) => void;
}) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  const select = useRef<HTMLSelectElement>(null);
  const supported = resource.controlModeSupported === true;
  const adoptionPending = supported && resource.desired?.value.agentControlMode === null;
  useLayoutEffect(() => {
    // React selects the first option for an unmatched value. Unadopted mode has
    // no selection; adding a placeholder would introduce a third option.
    if (value == null && select.current !== null) select.current.selectedIndex = -1;
  });
  return <div className="field">
    <label htmlFor="config-agentControlMode">{m.agentControlMode}</label>
    <NativeSelect density="form" layout="fill" ref={select} id="config-agentControlMode" value={value ?? ''} disabled={disabled || !supported}
      aria-describedby={`control-mode-detail feedback-agentControlMode${!supported || adoptionPending ? ' control-mode-availability' : ''}`}
      onChange={event => { if (event.target.value === 'herdr' || event.target.value === 'web') onChange(event.target.value); }}>
      <option value="herdr">herdr</option><option value="web">web</option>
    </NativeSelect>
    <p className="configuration-field-detail" id="control-mode-detail">{m.controlModeDetail}</p>
    {(!supported || adoptionPending) && <p className="configuration-field-detail" id="control-mode-availability">{supported ? m.controlModeAwaitingAdoption : m.controlModeUnsupported}</p>}
    <ConfigurationFeedback id="feedback-agentControlMode" resource={resource} kind="agentControlMode" expected={resource.desired?.value.agentControlMode ?? null} changed={changed} />
  </div>;
};
