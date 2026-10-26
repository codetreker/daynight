import { useLayoutEffect } from "react";
import { LanguageSelector } from "../../i18n/LanguageSelector";
import { useI18n } from "../../i18n/LocaleProvider";
import { LandingDemo } from "./LandingDemo";
import { demoTasks, taskIds, taskState } from "./demo";
import { useNavigationIdentity } from "./useNavigationIdentity";
import "../../styles/landing.css";

const Arrow = ({ diagonal = false }: { readonly diagonal?: boolean }) => <span className="arrow" aria-hidden="true">{diagonal ? "↗" : "→"}</span>;
const Brand = () => {
  const { messages: { landing } } = useI18n();
  return <a className="brand" href="/" aria-label={landing.navigation.home}><span className="mark" aria-hidden="true" />daynight</a>;
};

export const LandingPage = () => {
  const { locale, messages: { landing: m } } = useI18n();
  const identity = useNavigationIdentity();
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = m.metadata.title;
    const metadata = [
      ["name", "description", m.metadata.description],
      ["property", "og:title", m.metadata.title],
      ["property", "og:description", m.metadata.description],
      ["property", "og:type", "website"],
      ["property", "og:site_name", "Daynight"],
    ] as const;
    for (const [attribute, key, content] of metadata) {
      let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
      if (element === null) {
        element = document.createElement("meta");
        element.setAttribute(attribute, key);
        document.head.append(element);
      }
      element.content = content;
    }
  }, [locale, m.metadata]);
  const entry = identity === "authenticated" ? { href: "/projects", label: m.navigation.workspace } : identity === "anonymous" ? { href: "/login", label: m.navigation.login } : { href: "/login", label: m.navigation.unknown };
  const focusDemo = () => document.querySelector<HTMLElement>("#demo")!.focus({ preventScroll: true });
  const heroTasks = ["requirements", "design", "api", "email"] as const;
  const setupCommands = ["npm install --global @codetreker/daynight", "daynight skill install"];

  return <div className="landing-page" data-locale={locale}>
    <a className="skip-link" href="#main">{m.navigation.main}</a>
    <header className="site-header"><div className="wrap header-inner"><Brand /><nav className="header-nav" aria-label={m.navigation.label}><a className="value-link" href="#why">{m.navigation.why}</a><a href="#demo">{m.navigation.demo}</a></nav><div className="header-actions"><LanguageSelector /><a className="nav-start" href={entry.href}>{entry.label} <span aria-hidden="true">↗</span></a></div></div>{identity === "error" && <p className="identity-notice wrap" role="status">{m.navigation.identityFailed} <a href="/projects">{m.navigation.workspace} →</a></p>}</header>
    <main id="main">
      <section className="hero"><div className="wrap"><div className="hero-grid"><div><p className="hero-tag">{m.hero.tag}</p><h1>{m.hero.title[0]}<br /><span>{m.hero.title[1]}</span></h1><p className="hero-copy">{m.hero.body}</p><div className="actions"><a className="button primary" href="#demo" onClick={focusDemo}>{m.hero.demo}<Arrow diagonal /></a><a className="button secondary" href="/setup">{m.hero.start}<Arrow /></a></div><p className="hero-note">{m.hero.note}</p></div><div className="hero-visual" role="img" aria-label={m.hero.previewLabel}><div className="mini-window" aria-hidden="true"><div className="mini-bar"><span>daynight / {m.hero.window}</span><span className="window-dots"><i /><i /><i /></span></div><div className="mini-body"><div className="mini-project"><strong>{m.demo.project}</strong><span>{m.demo.example}</span></div><div className="mini-progress">{taskIds.map((id) => <i key={id} className={taskState(id)} />)}</div><div className="mini-flow">{heroTasks.map((id) => <div key={id} className={`mini-task ${demoTasks[id].status === "in_progress" ? "active" : taskState(id) === "blocked" ? "blocked" : ""}`}><span className="task-symbol">{taskState(id) === "done" ? "✓" : taskState(id) === "running" ? "◔" : "⌁"}</span><span className="mini-task-label">{m.demo.tasks[id].title}</span><span className="status-text">{taskState(id) === "done" ? m.hero.confirmed : m.demo.states[taskState(id)]}</span></div>)}</div><div className="mini-foot"><span>{m.hero.shared}</span><span>{m.hero.project}</span></div></div></div><div className="floating-note"><span className="note-dot" />{m.hero.floating}</div></div></div><div className="agent-line"><span>{m.hero.agents}</span><div className="agent-name">Codex</div><div className="agent-name">Claude Code</div><div className="agent-name">GitHub Copilot <small>CLI</small></div></div></div></section>
      <section className="why" id="why"><div className="wrap why-grid"><div><p className="eyebrow">{m.why.eyebrow}</p><h2 className="section-heading">{m.why.title[0]}<br />{m.why.title[1]}</h2><p className="body-copy">{m.why.body}</p></div><div className="pain-list">{m.why.items.map((item, index) => <div className="pain-item" key={index}><span className="pain-number" aria-hidden="true">{(index + 1).toString().padStart(2, "0")}</span><div><h3>{item.title}</h3><p>{item.body}</p></div></div>)}</div></div></section>
      <LandingDemo />
      <section className="people"><div className="wrap"><div className="people-intro"><h2 className="section-heading">{m.people.title[0]}<br />{m.people.title[1]}</h2><p>{m.people.body}</p></div><div className="audience-grid">{m.people.audiences.map((audience, index) => <article className={`audience ${index === 1 ? "team" : ""}`} key={index}><span className="audience-tag">{audience.tag}</span><h3>{audience.title[0]}<br />{audience.title[1]}</h3><p>{audience.body}</p><div className="audience-bottom">{audience.note}</div></article>)}</div><p className="principle">{m.people.principle}</p></div></section>
      <section className="start-section" id="start"><div className="wrap start-grid"><div><p className="eyebrow">{m.start.eyebrow}</p><h2 className="section-heading">{m.start.title[0]}<br />{m.start.title[1]}</h2><p className="body-copy">{m.start.body}</p><a className="button primary" href="/setup">{m.start.guide}<Arrow /></a></div><div className="setup-steps">{m.start.steps.map((step, index) => <div className="setup-step" key={index}><span className="setup-number" aria-hidden="true">{index + 1}</span><div><h3>{step.title}</h3><p>{step.body}</p>{setupCommands[index] !== undefined && <code>{setupCommands[index]}</code>}</div></div>)}</div></div></section>
      <section className="faq"><div className="wrap faq-grid"><div><p className="eyebrow">{m.faq.eyebrow}</p><h2 className="section-heading">{m.faq.title[0]}<br />{m.faq.title[1]}</h2></div><div className="faq-list">{m.faq.items.map((item, index) => <details key={index} open={index === 0 ? true : undefined}><summary>{item.title}</summary><p>{item.body}</p></details>)}</div></div></section>
      <section className="closing"><h2>{m.closing.title[0]}<br />{m.closing.title[1]}</h2><p>{m.closing.body}</p><div className="actions"><a className="button primary" href="#demo" onClick={focusDemo}>{m.closing.demo}<Arrow diagonal /></a><a className="button secondary" href="/setup">{m.closing.start}<Arrow /></a></div></section>
    </main>
    <footer className="site-footer"><div className="wrap footer-inner"><Brand /><p className="footer-copy">{m.footer.body}</p><a className="footer-link" href="/setup">{m.footer.guide} ↗</a></div></footer>
  </div>;
};
