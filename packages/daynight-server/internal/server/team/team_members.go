package team

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *teamHandler) listMembers(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.WriteError(w, r, logger, "team", "list_members", err)
		return
	}
	items, err := h.teams.Members(r.Context(), p, r.PathValue("teamId"))
	if err != nil {
		httpx.WriteError(w, r, logger, "team", "list_members", err)
		return
	}
	response := api.TeamMemberList{Items: make([]api.TeamMemberWithProfile, 0, len(items))}
	for _, item := range items {
		response.Items = append(response.Items, api.TeamMemberWithProfile{TeamMember: teamMemberResponse(item.Membership), Profile: api.ProjectParticipantProfile{Name: item.Profile.Name, Email: item.Profile.Email, AvatarURL: item.Profile.AvatarURL}})
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, response)
}

func teamMemberInput(w http.ResponseWriter, r *http.Request, roleRequired bool) (coreteam.ChangeTeamMember, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return coreteam.ChangeTeamMember{}, err
	}
	allowed := []string{"version", "expectedUserId"}
	if roleRequired {
		allowed = append(allowed, "role")
	}
	fields, err := httpx.DecodeObject(w, r, allowed...)
	if err != nil {
		return coreteam.ChangeTeamMember{}, err
	}
	version, err := httpx.VersionInput(fields)
	if err != nil {
		return coreteam.ChangeTeamMember{}, err
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		return coreteam.ChangeTeamMember{}, err
	}
	var role string
	if roleRequired {
		role, err = httpx.RequiredString(fields, "role")
		if err != nil {
			return coreteam.ChangeTeamMember{}, err
		}
	}
	return coreteam.ChangeTeamMember{Version: version, ExpectedUserID: expected, Role: model.ProjectRole(role)}, nil
}

func actorRoleResponse(role *model.ProjectRole) *string {
	if role == nil {
		return nil
	}
	value := string(*role)
	return &value
}

func (h *teamHandler) setMemberRole(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	input, err := teamMemberInput(w, r, true)
	if err != nil {
		writeTeamError(w, r, logger, "set_member_role", err)
		return
	}
	result, err := h.teams.SetMemberRole(r.Context(), p, r.PathValue("teamId"), r.PathValue("userId"), input)
	if err != nil {
		writeTeamError(w, r, logger, "set_member_role", err)
		return
	}
	writeTeamJSON(w, r, logger.With("team_id", result.Membership.TeamID), http.StatusOK, api.TeamMemberRoleReceipt{Membership: teamMemberResponse(result.Membership), ActorRole: actorRoleResponse(result.ActorRole)})
}

func (h *teamHandler) removeMember(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	input, err := teamMemberInput(w, r, false)
	if err != nil {
		writeTeamError(w, r, logger, "remove_member", err)
		return
	}
	result, err := h.teams.RemoveMember(r.Context(), p, r.PathValue("teamId"), r.PathValue("userId"), input)
	if err != nil {
		writeTeamError(w, r, logger, "remove_member", err)
		return
	}
	writeTeamJSON(w, r, logger.With("team_id", result.Membership.TeamID), http.StatusOK, api.RemoveTeamMemberReceipt{TeamID: result.Membership.TeamID, UserID: result.Membership.UserID, Removed: true, ActorRole: actorRoleResponse(result.ActorRole)})
}
