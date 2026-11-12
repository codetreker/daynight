import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ApiError } from "../../api/client";
import { useI18n } from "../../i18n/LocaleProvider";
import { useBrowserLocation } from "../../app/browser-location";
import { navigate } from "../../app/router";
import { useTeams } from "./TeamsProvider";
import { useTeamMessages } from "./messages";

export const TeamSelector = ({ personalId, selectedId, visibilityTeamId, onNavigate, onCreate }: { readonly personalId: string; readonly selectedId: string | null; readonly visibilityTeamId: string | null; readonly onNavigate: () => void; readonly onCreate?: () => void }) => {
  const teams = useTeams(), m = useTeamMessages();
  const { messages: { common } } = useI18n();
  const location = useBrowserLocation();
  const [openedAt, setOpenedAt] = useState<typeof location | null>(null);
  const open = openedAt === location;
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const initial = useRef<"selected" | "first" | "last">("selected");
  const menuId = useId();
  const detail = (error: unknown) => <><span>{error instanceof ApiError && error.kind === "network" ? m.network : m.readError}</span>{error instanceof ApiError && error.requestId !== null && <span> {common.requestId}<code>{error.requestId}</code></span>}</>;
  const selected = teams.detail.status === "ready" ? teams.detail.team : undefined;
  const title = selected?.kind === "ordinary" ? selected.name! : selected?.kind === "personal" ? m.personal : teams.detail.status === "loading" ? m.loading : m.failed;
  const type = selected ? selected.kind === "personal" ? m.personalSpace : m.team : visibilityTeamId === null ? null : visibilityTeamId === personalId ? m.personalSpace : m.team;
  const label = `${m.switchTeam}: ${type === null ? "" : `${type}, `}${title}`;
  const avatar = Array.from(title.trimStart())[0];
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)') ?? []);
  const close = (restore: boolean) => { setOpenedAt(null); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = (edge: "selected" | "first" | "last" = "selected") => { initial.current = edge; setOpenedAt(location); };

  useLayoutEffect(() => {
    if (!open) return;
    const element = menu.current!;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const below = Math.max(0, window.innerHeight - anchor.bottom - 12);
      const above = Math.max(0, anchor.top - 12);
      const offscreen = anchor.bottom < 8 || anchor.top > window.innerHeight - 8;
      const placeBelow = below >= element.scrollHeight || below >= above;
      // Keep the trigger reachable even when the list is taller than the space beside it.
      element.style.maxHeight = `${offscreen ? Math.max(0, window.innerHeight - 16) : placeBelow ? below : above}px`;
      const box = element.getBoundingClientRect();
      const top = offscreen ? 8 : placeBelow ? anchor.bottom + 4 : anchor.top - box.height - 4;
      element.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(top, window.innerHeight - box.height - 8))}px`;
    };
    const toggled = (event: ToggleEvent) => { if (event.newState === "closed") setOpenedAt(null); };
    element.addEventListener("toggle", toggled);
    element.showPopover();
    position();
    const options = items();
    const first = initial.current === "last" ? options[options.length - 1] : initial.current === "selected" ? options.find((item) => item.getAttribute("aria-checked") === "true") ?? options[0] : options[0];
    first?.focus();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    resize?.observe(element);
    resize?.observe(trigger.current!);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      element.removeEventListener("toggle", toggled);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      resize?.disconnect();
      element.hidePopover();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpenedAt(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      // Leave the anchor mounted until the browser has performed its native navigation.
      window.setTimeout(() => close(false), 0);
      return;
    }
    close(false);
    event.preventDefault();
    navigate(event.currentTarget.pathname); onNavigate();
  };
  return <div className="team-selector" ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}>
    <button ref={trigger} type="button" className="team-switch" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(false) : show()} onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const edge = event.key === "ArrowUp" ? "last" : "first";
          if (open) { const options = items(); (edge === "last" ? options[options.length - 1] : options[0])?.focus(); }
          else show(edge);
        }
      }}><span className="team-avatar" aria-hidden="true">{avatar}</span><span className="team-switch-text"><span className="team-switch-type">{type}</span><span className="team-switch-name">{title}</span></span><span className="team-chevron" aria-hidden="true">⌄</span></button>
    {open && <div className="team-options" id={menuId} ref={menu} role="menu" aria-label={m.switchTeam} popover="auto" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const options = items(), current = options.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      } else if (event.key === " " && event.target instanceof HTMLAnchorElement) { event.preventDefault(); event.target.click(); }
    }}>
      <a className="team-option menu-personal" role="menuitemradio" aria-checked={personalId === selectedId} tabIndex={-1} href={`/teams/${personalId}`} onClick={follow} onAuxClick={follow} aria-current={personalId === selectedId ? "true" : undefined}><span className="menu-avatar" aria-hidden="true">{Array.from(m.personal.trimStart())[0]}</span><span className="menu-name">{m.personal}</span><span className="check" aria-hidden="true">{personalId === selectedId ? "✓" : ""}</span></a>
      {teams.list.status === "loading" && <div className="menu-state menu-loading" role="status"><span className="spinner" aria-hidden="true" />{m.loading}</div>}
      {teams.list.status === "error" && <div className="menu-state error" role="alert"><p>{m.failed}</p><p>{detail(teams.list.error)}</p><button type="button" role="menuitem" tabIndex={-1} onClick={() => { items().find((item) => item instanceof HTMLAnchorElement)?.focus(); teams.refreshList(); }}>{m.retry}</button></div>}
      {teams.list.status === "ready" && teams.list.error !== null && <div className="menu-state error" role="alert"><p>{m.failed}</p><p>{detail(teams.list.error)}</p><button type="button" role="menuitem" tabIndex={-1} onClick={() => { items().find((item) => item instanceof HTMLAnchorElement)?.focus(); teams.revalidateList(); }}>{m.retry}</button></div>}
      {teams.list.items.some((team) => team.id !== personalId) && <hr />}
      {teams.list.items.filter((team) => team.id !== personalId).map((team) => {
        const name = team.kind === "personal" ? m.personal : team.name!;
        return <a key={team.id} className="team-option" role="menuitemradio" aria-checked={team.id === selectedId} tabIndex={-1} href={`/teams/${team.id}`} onClick={follow} onAuxClick={follow} aria-current={team.id === selectedId ? "true" : undefined}><span className="menu-avatar" aria-hidden="true">{Array.from(name.trimStart())[0]}</span><span className="menu-name">{name}</span><span className="check" aria-hidden="true">{team.id === selectedId ? "✓" : ""}</span></a>;
      })}
      {teams.list.status === "ready" && teams.list.cursor !== null && <div className="menu-more">{teams.list.moreError !== null && <div className="menu-state error" role="alert"><p>{m.moreFailed}</p><p>{detail(teams.list.moreError)}</p></div>}<button type="button" className="menu-action" role="menuitem" tabIndex={-1} disabled={teams.list.more} onClick={() => { const options = items(); options[Math.max(0, options.indexOf(document.activeElement as HTMLElement) - 1)]?.focus(); teams.loadMore(); }}><span aria-hidden="true">{teams.list.more ? "◌" : "↓"}</span><span>{teams.list.more ? m.loading : teams.list.moreError !== null ? m.retry : m.more}</span></button></div>}
      {onCreate && <><hr /><button type="button" role="menuitem" tabIndex={-1} className="menu-action create-team-item" onClick={() => { close(true); onCreate(); }}><span aria-hidden="true">＋</span><span>{m.createTeam}</span></button></>}
    </div>}
  </div>;
};
