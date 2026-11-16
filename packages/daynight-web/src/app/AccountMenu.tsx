import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/LocaleProvider";
import { useBrowserLocation } from "./browser-location";
import { navigate } from "./router";

const AccountAvatar = ({ name, src }: { readonly name: string; readonly src: string | null }) => {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  return <span className="avatar account-avatar" aria-hidden="true"><span className={state === "loaded" ? "account-avatar-initial-hidden" : undefined}>{name.slice(0, 1).toUpperCase()}</span>
    {src !== null && src !== "" && state !== "failed" && <img src={src} alt="" className={state === "loaded" ? "loaded" : undefined} onLoad={() => setState("loaded")} onError={() => setState("failed")} />}
  </span>;
};

export const AccountMenu = ({ name, userId, avatarUrl, onSignOut }: { readonly name: string; readonly userId: string; readonly avatarUrl: string | null; readonly onSignOut: () => void }) => {
  const { messages: { auth: { shell: m } } } = useI18n();
  const location = useBrowserLocation();
  const [openedAt, setOpenedAt] = useState<typeof location | null>(null);
  const open = openedAt === location;
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  const close = (restore: boolean) => { setOpenedAt(null); if (restore) trigger.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const element = menu.current!;
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      element.style.top = `${anchor.bottom + box.height + 8 <= window.innerHeight ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4)}px`;
    };
    position();
    const items = menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]');
    items[focusLast.current ? items.length - 1 : 0]?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpenedAt(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return <div className="account-picker" ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button className="account-button" ref={trigger} type="button" aria-label={m.accountMenu({ name })} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { focusLast.current = false; open ? close(false) : setOpenedAt(location); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusLast.current = event.key === "ArrowUp"; setOpenedAt(location); }
        else if (event.key === "Escape" && open) { event.preventDefault(); close(true); }
      }}><AccountAvatar key={JSON.stringify([userId, avatarUrl])} name={name} src={avatarUrl} /><span className="account-name">{name}</span></button>
    {open && <div className="account-menu" id={menuId} ref={menu} role="menu" aria-label={m.accountMenu({ name })} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}><a className="account-menu-item" role="menuitem" tabIndex={-1} href="/account" onKeyDown={(event) => {
      if (event.key === " ") { event.preventDefault(); event.currentTarget.click(); }
    }} onClick={(event) => {
      close(location.pathname === "/account" || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(event.currentTarget.pathname);
    }}>{m.accountSettings}</a><div className="account-menu-separator" role="separator" /><button className="account-menu-item account-menu-sign-out" type="button" role="menuitem" tabIndex={-1} onClick={() => { close(false); onSignOut(); }}>{m.signOut}</button></div>}
  </div>;
};
