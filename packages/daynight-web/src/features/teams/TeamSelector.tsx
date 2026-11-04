import { useRef, type MouseEvent } from "react";
import { ApiError } from "../../api/client";
import { useI18n } from "../../i18n/LocaleProvider";
import { navigate } from "../../app/router";
import { useTeams } from "./TeamsProvider";
import { useTeamMessages } from "./messages";

export const TeamSelector = ({ personalId, selectedId, expanded, onExpand, onNavigate }: { readonly personalId: string; readonly selectedId: string; readonly expanded: boolean; readonly onExpand: () => void; readonly onNavigate: () => void }) => {
  const teams = useTeams(), m = useTeamMessages(), menu = useRef<HTMLDetailsElement>(null);
  const { messages: { common } } = useI18n();
  const detail = (error: unknown) => <><span>{error instanceof ApiError && error.kind === "network" ? m.network : m.readError}</span>{error instanceof ApiError && error.requestId !== null && <span> {common.requestId}<code>{error.requestId}</code></span>}</>;
  const selected = teams.detail.status === "ready" ? teams.detail.team : undefined;
  const title = selected?.kind === "ordinary" ? selected.name! : selected?.kind === "personal" ? m.personal : teams.detail.status === "loading" ? m.loading : m.failed;
  const initial = Array.from(title.trimStart())[0];
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); if (menu.current) menu.current.open = false;
    navigate(event.currentTarget.pathname); onNavigate();
  };
  if (!expanded) return <button type="button" className="team-switch team-selector" aria-label={`${m.switchTeam}: ${title}`} title={`${m.switchTeam}: ${title}`} onClick={onExpand}><span className="team-avatar" aria-hidden="true">{initial}</span></button>;
  return <details className="team-selector" ref={menu} onKeyDown={(event) => { if (event.key === "Escape" && menu.current?.open) { event.stopPropagation(); menu.current.open = false; menu.current.querySelector("summary")?.focus(); } }}>
    <summary className="team-switch" aria-label={`${m.switchTeam}: ${title}`} title={`${m.switchTeam}: ${title}`}><span className="team-avatar" aria-hidden="true">{initial}</span><span className="team-switch-text">{title}</span><span className="team-chevron" aria-hidden="true">⌄</span></summary>
    <div className="team-options" aria-label={m.switchTeam}>
      {teams.list.status === "loading" && <p role="status">{m.loading}</p>}
      {teams.list.status === "error" && <p role="alert">{m.failed} {detail(teams.list.error)} <button type="button" onClick={teams.refreshList}>{m.retry}</button></p>}
      <a href={`/teams/${personalId}`} onClick={follow} aria-current={personalId === selectedId ? "true" : undefined}>{m.personal}</a>
      {teams.list.items.filter((team) => team.id !== personalId).map((team) => <a key={team.id} href={team.id === personalId ? "/projects" : `/teams/${team.id}`} onClick={follow} aria-current={team.id === selectedId ? "true" : undefined}>{team.kind === "personal" ? m.personal : team.name}</a>)}
      {teams.list.status === "ready" && teams.list.cursor !== null && <div>{teams.list.moreError !== null && <p role="alert">{m.moreFailed} {detail(teams.list.moreError)}</p>}<button type="button" disabled={teams.list.more} onClick={teams.loadMore}>{teams.list.more ? m.loading : teams.list.moreError !== null ? m.retry : m.more}</button></div>}
    </div>
  </details>;
};
