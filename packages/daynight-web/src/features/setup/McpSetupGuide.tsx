import { useI18n } from "../../i18n/LocaleProvider";
import { NativeSelect } from "../../ui/native-select/NativeSelect";
import { mcpConfiguration, type McpClient } from "./mcp-configuration";
import { SetupCommand, type SetupCopyProps } from "./SetupCommand";

type Props = SetupCopyProps & {
  readonly client: McpClient;
  readonly onClientChange: (client: McpClient) => void;
};

export const McpSetupGuide = ({ client, onClientChange, ...copyProps }: Props) => {
  const { messages: { setup: m } } = useI18n();
  const endpoint = new URL("/mcp", window.location.origin).href;
  const configuration = mcpConfiguration(client, endpoint);
  const c = m.mcp;
  return <section id="mcp" className="setup-section" aria-labelledby="mcp-heading">
    <div className="setup-section-heading"><h2 id="mcp-heading">{m.mcpTitle}</h2><p>{c.description}</p></div>
    <div className="panel">
      <ol className="setup-steps" aria-label={c.stepsLabel}>
        <li className="setup-step">
          <span className="setup-step-number" aria-hidden="true">1</span><div className="setup-step-content">
            <h3>{c.configure}</h3><p>{c.configureDescription}</p>
            <div className="setup-client-field"><label htmlFor="setup-client">{c.client}</label><NativeSelect id="setup-client" value={client} onChange={(event) => onClientChange(event.target.value as McpClient)}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="copilot">Copilot CLI</option></NativeSelect></div>
            <p className="setup-guide-tip">{c.scope}</p>
            <span className="setup-block-label">{c.endpoint}</span><SetupCommand text={endpoint} title={c.endpoint} {...copyProps} />
            <span className="setup-block-label">{c.terminal}</span><SetupCommand text={configuration.command} title={c.configure} {...copyProps} />
            <p className="setup-guide-tip"><a className="setup-footer-link" href={configuration.documentation} target="_blank" rel="noopener noreferrer">{c.clientDocumentation} ↗</a></p>
            <p className="setup-guide-result"><span>{m.successLabel}</span>{c.configureSuccess}</p>
          </div>
        </li>
        <li className="setup-step">
          <span className="setup-step-number" aria-hidden="true">2</span><div className="setup-step-content">
            <h3>{c.authorize}</h3><p>{c.authorizeDescription}</p>
            <p className="setup-in-session">{client === "copilot" ? c.copilotAuth : c.otherAuth}</p>
            {configuration.remoteCommand === null ? <><span className="setup-block-label">{c.session}</span><SetupCommand text="/mcp auth daynight" title={c.session} {...copyProps} /></> : <><span className="setup-block-label">{c.remote}</span><SetupCommand text={configuration.remoteCommand} title={c.remote} {...copyProps} /><p className="setup-guide-tip">{c.remoteNote}</p></>}
            <p className="setup-guide-tip">{c.authorizeNote}</p>
            <p className="setup-guide-result"><span>{m.successLabel}</span>{c.authorizeSuccess}</p>
          </div>
        </li>
        <li className="setup-step">
          <span className="setup-step-number" aria-hidden="true">3</span><div className="setup-step-content">
            <h3>{c.verify}</h3><p>{c.verifyDescription}</p>
            <span className="setup-block-label">{m.agentRequest}</span><SetupCommand text={c.teamRequest} title={c.verify} {...copyProps} />
            <p className="setup-guide-result"><span>{m.successLabel}</span>{c.verifySuccess}</p>
          </div>
        </li>
      </ol>
      <div className="setup-section-footer"><p><a href="/mcp">{c.manual}</a> · <a href="/account">{c.tokens}</a></p><p>{c.accountNote}</p><p>{c.pat}</p></div>
    </div>
  </section>;
};
