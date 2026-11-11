import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountChangeBanner } from "../../src/features/auth/AccountChangeBanner";
import { LocaleProvider } from "../../src/i18n/LocaleProvider";

const locale = new URLSearchParams(location.search).get("lang") === "zh-CN" ? "zh-CN" : "en";
const mode = new URLSearchParams(location.search).get("mode") ?? "normal";

function Fixture() {
  const [changed, setChanged] = useState(false);
  const [reloads, setReloads] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const show = () => setChanged(true);
    window.addEventListener("account-change", show);
    return () => window.removeEventListener("account-change", show);
  }, []);
  const banner = (active: boolean) => <AccountChangeBanner active={changed && active} onReload={() => setReloads(count => count + 1)} />;
  const content = <><header><strong>Header</strong>{banner(true)}</header><label>Draft <input defaultValue="Retained draft text" /></label><p>Retained content</p></>;
  return <>
    <style>{`body { margin: 0; font: 16px sans-serif; } header { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:12px; } header .account-change-banner { flex-shrink:1; } @media(max-width:600px) { header .account-change-banner { flex-basis:100%; justify-content:space-between; } } dialog, #fullscreen { box-sizing:border-box; width:100%; max-width:100%; }`}</style>
    <div data-testid="reloads">{reloads}</div>
    {mode === "dialog" ? <><header inert><strong>Background header</strong>{banner(false)}</header><button onClick={() => dialog.current?.showModal()}>Open dialog</button><dialog ref={dialog}>{content}</dialog></> : mode === "fullscreen" ? <div id="fullscreen">{content}<button onClick={() => document.getElementById("fullscreen")?.requestFullscreen()}>Fullscreen</button></div> : content}
  </>;
}

createRoot(document.getElementById("root")!).render(<LocaleProvider initial={{ locale, issue: null }}><Fixture /></LocaleProvider>);
