import { useLayoutEffect, useRef, useState, type MouseEventHandler } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import "../../styles/setup.css";

const commands = {
  install: "npm install --global @codetreker/daynight\ndaynight --version",
  login: "daynight login",
  skill: "daynight skill install",
} as const;

type CopyState = "idle" | "pending" | "copied" | "failed";

export const SetupGuidePage = ({ onFollowLink }: { readonly onFollowLink: MouseEventHandler<HTMLAnchorElement> }) => {
  const { locale, messages: { setup: m } } = useI18n();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const generation = useRef(0);
  const pending = useRef(false);
  useLayoutEffect(() => {
    pending.current = false;
    setCopyState("idle");
    ++generation.current;
    return () => { ++generation.current; };
  }, [locale]);
  const copy = async (command: string) => {
    if (pending.current) return;
    pending.current = true;
    const current = ++generation.current;
    setCopyState("pending");
    try {
      await navigator.clipboard.writeText(command);
      if (current === generation.current) setCopyState("copied");
    } catch {
      if (current === generation.current) setCopyState("failed");
    } finally {
      if (current === generation.current) pending.current = false;
    }
  };
  const steps = [
    { id: "install", ...m.steps.install, command: commands.install },
    { id: "login", ...m.steps.login, command: commands.login },
    { id: "project", ...m.steps.project },
    { id: "skill", ...m.steps.skill, command: commands.skill },
    { id: "start", ...m.steps.start, command: m.steps.start.example },
  ];
  return <div className="setup-guide">
    <div className="setup-guide-intro">
      <p className="eyebrow">{m.eyebrow}</p><h1>{m.title}</h1><p className="subtitle">{m.subtitle}</p>
      <p className="setup-service"><span>{m.currentService}</span><code>{window.location.origin}</code></p>
    </div>
    <ol className="panel setup-steps" aria-label={m.stepsLabel}>
      {steps.map((step, index) => <li className="setup-step" key={step.id}>
        <span className="setup-step-number" aria-hidden="true">{index + 1}</span>
        <div className="setup-step-content">
          <h2>{step.title}</h2><p>{step.description}</p>
          {step.id === "start" && <p className="setup-request-label">{m.agentRequest}</p>}
          <div className="setup-command"><pre><code>{step.command}</code></pre><button className="setup-copy" type="button" disabled={copyState === "pending"} aria-label={m.copyLabel({ title: step.title })} title={m.copyLabel({ title: step.title })} onClick={() => { void copy(step.command); }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></svg>
          </button></div>
          {"note" in step && <p className="setup-guide-tip">{step.note}</p>}
          <p className="setup-guide-result"><span>{m.successLabel}</span>{step.success}</p>
          {step.id === "start" && <a className="button primary" href="/" onClick={onFollowLink}>{m.returnToProjects}<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></a>}
        </div>
      </li>)}
    </ol>
    <p className={`setup-copy-status${copyState === "failed" ? " failed" : ""}`} role="status" aria-live="polite" aria-atomic="true" hidden={copyState === "idle"}>{copyState === "idle" ? "" : m.copyStatus[copyState]}</p>
  </div>;
};
