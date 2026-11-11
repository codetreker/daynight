import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { CurrentUser, TeamRef } from "../../api/auth-types";
import { ApiError } from "../../api/client";
import { navigate, parseAuthRoute, type AuthRoute } from "../../app/router";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";
import { TeamSettingsPanel } from "./TeamManagement";
import { TeamMembersPanel } from "./TeamMembersPanel";
import { useTeamMessages } from "./messages";
import { useTeams } from "./TeamsProvider";
import { useCurrentTeamPreference } from "./useTeamPreference";

type Section = "general" | "members";
type Owner = {
  readonly id: string;
  readonly host: HTMLDivElement;
  team: TeamRef;
  section: Section;
  readonly opened: Record<Section, boolean>;
  readonly guarded: Record<Section, boolean>;
};
type Props = {
  readonly route: AuthRoute;
  readonly user: CurrentUser;
  readonly admission: TaskCacheScope;
  readonly blocked: boolean;
  readonly identityChecking: boolean;
  readonly workspaceVisible: boolean;
  readonly slot: HTMLDivElement | null;
  readonly guardedTeam: (id: string) => boolean;
  readonly setTeamGuard: (id: string, source: "settings" | "members", guarded: boolean) => void;
  readonly onIdentityMismatch: () => void;
  readonly onNameSaved: (id: string) => void;
  readonly onDeletedResult: (id: string) => void;
  readonly onMemberResult: (id: string, kind: "changed" | "left") => void;
  readonly onMemberStart: (id: string) => void;
};

export const isTeamSettingsRoute = (route: AuthRoute, teamId?: string) => (route.kind === "teamSettings" || route.kind === "teamMembers") && (teamId === undefined || route.teamId === teamId);
const onCurrentTeam = (teamId: string) => isTeamSettingsRoute(parseAuthRoute(window.location.pathname, window.location.search), teamId);
const followSection = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.pathname);
};

export const TeamSettingsWorkspace = ({ route, user, admission, blocked, identityChecking, workspaceVisible, slot, guardedTeam, setTeamGuard, onIdentityMismatch, onNameSaved, onDeletedResult, onMemberResult, onMemberStart }: Props) => {
  const teams = useTeams(), confirmedTeam = useCurrentTeamPreference().confirmedTeam, m = useTeamMessages();
  // Stable hosts keep dispatched operations alive when standalone navigation detaches the workspace.
  const owners = useRef<Owner[]>([]);
  const [, updateOwners] = useState(0);
  const teamId = route.kind === "teamSettings" || route.kind === "teamMembers" ? route.teamId : null;
  const section: Section = route.kind === "teamMembers" ? "members" : "general";
  owners.current = owners.current.filter(owner => owner.id === teamId || owner.guarded.general || owner.guarded.members);
  const ready = teamId !== null && teams.detail.id === teamId && !blocked && (teams.detail.status === "ready" || teams.detail.status === "error" && owners.current.some(owner => owner.id === teamId) && guardedTeam(teamId));
  if (ready && teamId !== null) {
    let owner = owners.current.find(owner => owner.id === teamId);
    if (owner === undefined && teams.detail.team !== undefined) {
      owner = { id: teamId, host: document.createElement("div"), team: teams.detail.team, section, opened: { general: false, members: false }, guarded: { general: false, members: false } };
      owners.current.push(owner);
    }
    if (owner !== undefined) {
      if (teams.detail.team !== undefined) owner.team = teams.detail.team;
      owner.section = section;
      owner.opened[section] = true;
    }
  }
  useLayoutEffect(() => {
    if (slot === null) return;
    for (const child of [...slot.children]) if (!owners.current.some(owner => owner.host === child)) child.remove();
    for (const owner of owners.current) if (owner.host.parentNode !== slot) slot.appendChild(owner.host);
  });
  const guard = (owner: Owner, source: Section, value: boolean) => {
    setTeamGuard(owner.id, source === "general" ? "settings" : "members", value);
    if (owner.guarded[source] === value) return;
    owner.guarded[source] = value;
    updateOwners(previous => previous + 1);
    if (!value && teams.detail.id === owner.id && teams.detail.status === "error") teams.refreshDetail();
  };
  const unavailable = (id: string) => {
    if (!onCurrentTeam(id)) return "changed" as const;
    const result = teams.forgetUnavailable(id);
    if (result === "forgotten") navigate("/projects");
    return result;
  };
  const departed = (id: string, finish = true) => {
    const current = finish && onCurrentTeam(id);
    teams.leaveTeam(id);
    teams.refreshList();
    if (current) navigate(`/teams/${user.personalTeam.id}`);
  };
  const preferenceDenied = teams.detail.error instanceof ApiError && teams.detail.error.kind === "server" && ((teams.detail.error.status === 403 && teams.detail.error.code === "forbidden") || (teams.detail.error.status === 404 && teams.detail.error.code === "not_found"));
  return owners.current.map(owner => {
    const onRoute = teamId === owner.id;
    const visible = onRoute && ready && workspaceVisible;
    const generalActive = visible && owner.section === "general";
    const membersActive = visible && owner.section === "members";
    const denied = preferenceDenied && teams.detail.id === owner.id;
    return createPortal(<div hidden={!visible} inert={!visible}>
      <div className="page-heading"><div><div className="eyebrow">TEAM SETTINGS</div><h1 tabIndex={-1}>{m.settings}</h1><p className="team-settings-context">{owner.team.kind === "personal" ? m.personal : owner.team.name}</p></div></div>
      <nav className="project-management-nav team-settings-nav" aria-label={m.settings}>
        <a className="button" href={`/teams/${owner.id}/settings`} onClick={followSection} aria-current={owner.section === "general" ? "page" : undefined}>{m.general}</a>
        <a className="button" href={`/teams/${owner.id}/members`} onClick={followSection} aria-current={owner.section === "members" ? "page" : undefined}>{m.membersAndInvitations}</a>
      </nav>
      {owner.opened.general && <div hidden={!generalActive} inert={!generalActive}><TeamSettingsPanel teamId={owner.id} active={generalActive} admissionBlocked={identityChecking} preferenceDenied={denied} confirmedTeam={confirmedTeam} admission={admission} onIdentityMismatch={onIdentityMismatch} onGuardChange={value => guard(owner, "general", value)} onDeleted={finish => { onDeletedResult(owner.id); departed(owner.id, finish); }} onUnavailable={() => unavailable(owner.id)} onUpdated={team => { onNameSaved(team.id); teams.acceptTeam(team); teams.refreshList(); }} /></div>}
      {owner.opened.members && <div hidden={!membersActive} inert={!membersActive}><TeamMembersPanel teamId={owner.id} active={membersActive} admissionBlocked={identityChecking} preferenceDenied={denied} onRoute={onRoute} admission={admission} onIdentityMismatch={onIdentityMismatch} onGuardChange={value => guard(owner, "members", value)} onUnavailable={() => unavailable(owner.id)} onStart={() => onMemberStart(owner.id)} onChanged={confirmed => { if (confirmed) onMemberResult(owner.id, "changed"); if (onCurrentTeam(owner.id)) teams.refreshDetail(); teams.refreshList(); }} onLeft={() => { onMemberResult(owner.id, "left"); departed(owner.id); }} /></div>}
    </div>, owner.host, owner.id);
  });
};
