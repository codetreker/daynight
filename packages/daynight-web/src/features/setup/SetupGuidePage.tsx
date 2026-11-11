import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { CliSetupGuide } from "./CliSetupGuide";
import { McpSetupGuide } from "./McpSetupGuide";
import type { McpClient } from "./mcp-configuration";
import "../../styles/setup.css";

type CopyState = "idle" | "pending" | "copied" | "failed";

export const SetupGuidePage = () => {
  const { locale, messages: { setup: m } } = useI18n();
  const [client, setClient] = useState<McpClient>("codex");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const generation = useRef(0);
  const pending = useRef(false);
  useLayoutEffect(() => {
    pending.current = false;
    setCopyState("idle");
    ++generation.current;
    return () => { ++generation.current; };
  }, [locale, client]);
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
  const copyProps = { disabled: copyState === "pending", copy: (text: string) => { void copy(text); } };
  return <div className="setup-guide">
    <div className="setup-guide-intro">
      <p className="eyebrow">{m.eyebrow}</p><h1>{m.title}</h1><p className="subtitle">{m.subtitle}</p>
      <p className="setup-service"><span>{m.currentService}</span><code>{window.location.origin}</code></p>
      <nav className="setup-path-nav" aria-label={m.pathNavigation}><a href="#mcp">{m.mcpTitle} ↓</a><a href="#cli">{m.cliTitle} ↓</a></nav>
    </div>
    <McpSetupGuide client={client} onClientChange={setClient} {...copyProps} />
    <CliSetupGuide {...copyProps} />
    <p className={`setup-copy-status${copyState === "failed" ? " failed" : ""}`} role="status" aria-live="polite" aria-atomic="true" hidden={copyState === "idle"}>{copyState === "idle" ? "" : m.copyStatus[copyState]}</p>
  </div>;
};
