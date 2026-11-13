import type { WorkerConfigurationResource } from '../../../api/worker-configuration';
import type { Tool, ToolPathChoice, ToolPathTelemetry } from '../../../api/worker-tool-paths';
import { useI18n } from '../../../i18n/LocaleProvider';
import { WorkerToolPathDetails } from '../WorkerToolPathDetails';
import type { ConfigurationDraft, ParsedConfigurationDraft } from './model';

const tools: readonly Tool[] = ['codex', 'copilot', 'herdr'];
const names = { codex: 'Codex', copilot: 'Copilot', herdr: 'Herdr' };

export const ConfigurationToolPathsFields = ({ resource, value, telemetry, online, disabled, changed, errors, onChange }: {
  readonly resource: WorkerConfigurationResource;
  readonly value: ConfigurationDraft['toolPaths'];
  readonly telemetry: ToolPathTelemetry | undefined;
  readonly online: boolean | null;
  readonly disabled: boolean;
  readonly changed: Readonly<Record<Tool, boolean>>;
  readonly errors: ParsedConfigurationDraft['errors'];
  readonly onChange: (tool: Tool, choice: ToolPathChoice) => void;
}) => {
  const { messages: { workers: { configuration: { toolPaths: m } } } } = useI18n();
  const unavailable = resource.toolPathsSupported !== true ? m.unsupportedService : telemetry === undefined ? m.unsupportedWorker : null;
  return <details className="panel config-panel configuration-tool-paths">
    <summary>{m.title}</summary>
    <div className="panel-body">
      <p className="configuration-field-detail" id="config-tool-paths-detail">{m.detail}</p>
      {unavailable !== null && <p className="configuration-field-detail" id="config-tool-paths-unavailable">{unavailable}</p>}
      {tools.map(tool => {
        const choice = value?.[tool], id = `config-toolPaths-${tool}`, error = errors[`toolPaths.${tool}`];
        const description = ['config-tool-paths-detail', ...(unavailable === null ? [] : ['config-tool-paths-unavailable']), ...(error === undefined ? [] : [`${id}-error`])].join(' ');
        return <div className="field configuration-tool-field" key={tool} data-tool={tool}>
          <label htmlFor={id}>{names[tool]}</label>
          <div className="configuration-tool-input">
            <input id={id} type="text" spellCheck={false} autoComplete="off" value={choice?.kind === 'path' ? choice.path : ''}
              placeholder={choice === null ? m.awaitingImport : m.auto} disabled={disabled || unavailable !== null}
              aria-invalid={error !== undefined} aria-describedby={description}
              onChange={event => onChange(tool, { kind: 'path', path: event.target.value })} />
            <button type="button" className="button" disabled={disabled || unavailable !== null} onClick={() => onChange(tool, { kind: 'auto' })}>{m.reset}</button>
          </div>
          {error !== undefined && <p className="field-error" id={`${id}-error`}>{m.invalidPath}</p>}
          {changed[tool] && <p className="application-feedback"><span className="status-chip unsaved">{m.unsaved}</span></p>}
          <WorkerToolPathDetails tool={tool} {...(telemetry === undefined ? {} : { telemetry })} desired={resource.desired} online={online}
            {...(resource.desired?.value.agentControlMode == null ? {} : { primaryContext: resource.desired.value.agentControlMode })} />
        </div>;
      })}
    </div>
  </details>;
};
