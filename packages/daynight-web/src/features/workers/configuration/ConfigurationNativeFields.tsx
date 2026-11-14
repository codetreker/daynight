import type { WorkerConfigurationNative } from '../../../api/worker-configuration';
import type { WorkerAgent } from '../../../api/types';
import { useI18n } from '../../../i18n/LocaleProvider';
import { NativeSelect } from '../../../ui/native-select/NativeSelect';
import type { DraftIssue, NativeDraft, ProjectNativeDraft } from './model';

const agents = [{ value: 'codex', label: 'Codex' }, { value: 'copilot', label: 'Copilot' }, { value: 'claude', label: 'Claude Code' }] as const;
const AgentOptions = () => <>{agents.map(agent => <option value={agent.value} key={agent.value}>{agent.label}</option>)}</>;

export const ConfigurationFieldError = ({ issue, id, range }: { readonly issue: DraftIssue | undefined; readonly id: string; readonly range?: { readonly minimum: number; readonly maximum: number } }) => {
  const { messages: { workers: { configuration: m } }, format } = useI18n();
  return issue === undefined ? null : <p id={id} className="hint error">{issue === 'integer' ? m.invalidNumber : issue === 'args' ? m.invalidArgs : issue === 'model' ? m.invalidText : m.invalidField}{issue === 'integer' && range !== undefined && <> ({format.number(range.minimum)}–{format.number(range.maximum)})</>}</p>;
};

export const ConfigurationNativeFields = ({ value, onChange, disabled, errors }: {
  readonly value: NativeDraft;
  readonly onChange: (value: NativeDraft) => void;
  readonly disabled: boolean;
  readonly errors: Readonly<Record<string, DraftIssue>>;
}) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  return <>
    <div className="field"><label htmlFor="config-native-agent">{m.agent}</label><NativeSelect density="form" layout="fill" id="config-native-agent" value={value.agent} disabled={disabled} onChange={event => onChange({ agent: event.target.value as WorkerAgent, model: '', args: '[]' })}><AgentOptions /></NativeSelect></div>
    <div className="field"><label htmlFor="config-native-model">{m.model}</label><input id="config-native-model" value={value.model} placeholder={m.defaultModel} disabled={disabled} aria-invalid={errors['native.model'] !== undefined} aria-describedby={errors['native.model'] === undefined ? undefined : 'config-native-model-error'} onChange={event => onChange({ ...value, model: event.target.value })} autoComplete="off" /><ConfigurationFieldError issue={errors['native.model']} id="config-native-model-error" /></div>
    <div className="field full"><label htmlFor="config-native-args">{m.args}</label><textarea id="config-native-args" rows={3} value={value.args} disabled={disabled} spellCheck={false} aria-invalid={errors['native.args'] !== undefined} aria-describedby={`config-native-args-hint${errors['native.args'] === undefined ? '' : ' config-native-args-error'}`} onChange={event => onChange({ ...value, args: event.target.value })} /><p className="hint" id="config-native-args-hint">{m.argsHint}</p><ConfigurationFieldError issue={errors['native.args']} id="config-native-args-error" /></div>
  </>;
};

export const ConfigurationProjectNativeFields = ({ projectId, name, value, globalAgent, resolved, onChange, disabled, errors }: {
  readonly projectId: string;
  readonly name: string;
  readonly value: ProjectNativeDraft;
  readonly globalAgent: WorkerAgent;
  readonly resolved: WorkerConfigurationNative | null;
  readonly onChange: (value: ProjectNativeDraft) => void;
  readonly disabled: boolean;
  readonly errors: Readonly<Record<string, DraftIssue>>;
}) => {
  const { messages: { workers: { configuration: m } } } = useI18n();
  const prefix = `config-project-${projectId}`, key = `projects.${projectId}`;
  const differentAgent = value.agent !== 'inherit' && value.agent !== globalAgent;
  return <div className="config-grid">
    <div className="field"><label htmlFor={`${prefix}-agent`}>{m.agent}</label><NativeSelect density="form" layout="fill" id={`${prefix}-agent`} aria-label={`${name} · ${m.agent}`} value={value.agent} disabled={disabled} onChange={event => onChange({ ...value, agent: event.target.value as ProjectNativeDraft['agent'] })}><option value="inherit">{m.inheritGlobal}</option><AgentOptions /></NativeSelect></div>
    <div className="field"><label htmlFor={`${prefix}-model-mode`}>{m.model}</label><NativeSelect density="form" layout="fill" id={`${prefix}-model-mode`} aria-label={`${name} · ${m.model}`} aria-controls={`${prefix}-model`} value={value.modelMode} disabled={disabled} onChange={event => { const mode = event.target.value as ProjectNativeDraft['modelMode']; onChange({ ...value, modelMode: mode, ...(mode === 'custom' && resolved !== null ? { model: resolved.model === null ? '' : resolved.model } : {}) }); }}><option value="inherit">{m.inherit}</option><option value="default">{m.defaultModel}</option><option value="custom">{m.customModel}</option></NativeSelect>
      <input id={`${prefix}-model`} aria-label={`${name} · ${m.customModel}`} value={value.modelMode === 'custom' ? value.model : resolved?.model ?? ''} disabled={disabled || value.modelMode !== 'custom'} placeholder={m.defaultModel} aria-invalid={errors[`${key}.model`] !== undefined} aria-describedby={`${prefix}-model-resolved${errors[`${key}.model`] === undefined ? '' : ` ${prefix}-model-error`}`} autoComplete="off" onChange={event => onChange({ ...value, model: event.target.value })} /><p className="hint" id={`${prefix}-model-resolved`}>{m.resolved}: {resolved === null ? m.unavailableValue : resolved.model === null ? m.defaultModel : resolved.model}</p><ConfigurationFieldError issue={errors[`${key}.model`]} id={`${prefix}-model-error`} /></div>
    <div className="field full"><label htmlFor={`${prefix}-args-mode`}>{m.args}</label><NativeSelect density="form" layout="fill" id={`${prefix}-args-mode`} aria-label={`${name} · ${m.args}`} aria-controls={`${prefix}-args`} value={value.argsMode} disabled={disabled} onChange={event => { const mode = event.target.value as ProjectNativeDraft['argsMode']; onChange({ ...value, argsMode: mode, ...(mode === 'custom' && resolved !== null ? { args: JSON.stringify(resolved.args) } : {}) }); }}><option value="inherit">{m.inherit}</option><option value="clear">{m.clearArgs}</option><option value="custom">{m.customArgs}</option></NativeSelect>
      <textarea id={`${prefix}-args`} rows={3} spellCheck={false} placeholder={m.unavailableValue} aria-label={`${name} · ${m.customArgs}`} value={value.argsMode === 'custom' ? value.args : value.argsMode === 'clear' ? '[]' : resolved === null ? '' : JSON.stringify(resolved.args)} disabled={disabled || value.argsMode !== 'custom'} aria-invalid={errors[`${key}.args`] !== undefined} aria-describedby={`${prefix}-args-hint${errors[`${key}.args`] === undefined ? '' : ` ${prefix}-args-error`}`} onChange={event => onChange({ ...value, args: event.target.value })} /><p className="hint" id={`${prefix}-args-hint`}>{m.argsHint}</p><ConfigurationFieldError issue={errors[`${key}.args`]} id={`${prefix}-args-error`} /></div>
    {differentAgent && <p className="hint native-inheritance-note">{m.inheritanceNote}</p>}
  </div>;
};
