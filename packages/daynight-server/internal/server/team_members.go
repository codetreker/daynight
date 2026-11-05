package server

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func (h *teamHandler) listMembers(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	if _, err := queryValues(r); err != nil {
		writeError(w, r, logger, "team", "list_members", err)
		return
	}
	items, err := h.teams.Members(r.Context(), p, r.PathValue("teamId"))
	if err != nil {
		writeError(w, r, logger, "team", "list_members", err)
		return
	}
	response := api.TeamMemberList{Items: make([]api.TeamMemberWithProfile, 0, len(items))}
	for _, item := range items {
		response.Items = append(response.Items, api.TeamMemberWithProfile{TeamMember: teamMemberResponse(item.Membership), Profile: api.ProjectParticipantProfile{Name: item.Profile.Name, Email: item.Profile.Email, AvatarURL: item.Profile.AvatarURL}})
	}
	writeJSON(w, r, logger, http.StatusOK, response)
}

func teamMemberInput(w http.ResponseWriter, r *http.Request, roleRequired bool) (service.ChangeTeamMember, error) {
	if _, err := queryValues(r); err != nil {
		return service.ChangeTeamMember{}, err
	}
	allowed := []string{"version", "expectedUserId"}
	if roleRequired {
		allowed = append(allowed, "role")
	}
	fields, err := decodeObject(w, r, allowed...)
	if err != nil {
		return service.ChangeTeamMember{}, err
	}
	version, err := versionInput(fields)
	if err != nil {
		return service.ChangeTeamMember{}, err
	}
	expected, err := requiredString(fields, "expectedUserId")
	if err != nil {
		return service.ChangeTeamMember{}, err
	}
	var role string
	if roleRequired {
		role, err = requiredString(fields, "role")
		if err != nil {
			return service.ChangeTeamMember{}, err
		}
	}
	return service.ChangeTeamMember{Version: version, ExpectedUserID: expected, Role: model.ProjectRole(role)}, nil
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
