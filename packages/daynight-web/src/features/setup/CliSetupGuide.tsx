import { useI18n } from "../../i18n/LocaleProvider";
import { SetupCommand, type SetupCopyProps } from "./SetupCommand";

const commands = {
  install: "npm install --global @codetreker/daynight\ndaynight --version",
  login: "daynight login",
  skill: "daynight skill install",
} as const;

export const CliSetupGuide = (copyProps: SetupCopyProps) => {
  const { messages: { setup: m } } = useI18n();
  const steps = [
    { id: "install", ...m.steps.install, command: commands.install },
    { id: "login", ...m.steps.login, command: commands.login },
    { id: "project", ...m.steps.project },
    { id: "skill", ...m.steps.skill, command: commands.skill },
    { id: "start", ...m.steps.start, command: m.steps.start.example },
  ];
  return <section id="cli" className="setup-section" aria-labelledby="cli-heading">
    <div className="setup-section-heading"><h2 id="cli-heading">{m.cliTitle}</h2><p>{m.cliDescription}</p></div>
    <ol className="panel setup-steps" aria-label={m.stepsLabel}>
      {steps.map((step, index) => <li className="setup-step" key={step.id}>
        <span className="setup-step-number" aria-hidden="true">{index + 1}</span>
        <div className="setup-step-content">
          <h3>{step.title}</h3><p>{step.description}</p>
          {step.id === "start" && <p className="setup-request-label">{m.agentRequest}</p>}
          <SetupCommand text={step.command} title={step.title} {...copyProps} />
          {"note" in step && <p className="setup-guide-tip">{step.note}</p>}
          <p className="setup-guide-result"><span>{m.successLabel}</span>{step.success}</p>
          {step.id === "start" && <a className="button primary" href="/projects">{m.returnToProjects}<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></a>}
        </div>
      </li>)}
    </ol>
  </section>;
};
