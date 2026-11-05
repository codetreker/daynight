package server

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func teamInvitationResponse(i model.TeamInvitation) api.TeamInvitation {
	return api.TeamInvitation{ID: i.ID, TeamID: i.TeamID, CreatedBy: i.CreatedBy, CreatedAt: i.CreatedAt.UTC(), ExpiresAt: i.ExpiresAt.UTC(), ConsumedBy: i.ConsumedBy, ConsumedAt: i.ConsumedAt, RevokedAt: i.RevokedAt}
}
func teamMemberResponse(m model.TeamMember) api.TeamMember {
	return api.TeamMember{TeamID: m.TeamID, UserID: m.UserID, Role: string(m.Role), Version: m.Version, CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC()}
}
func (h *teamHandler) listInvitations(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.WriteError(w, r, logger, "team", "list_invitations", err)
		return
	}
	items, err := h.teams.ListInvitations(r.Context(), p, r.PathValue("teamId"))
	if err != nil {
		writeTeamError(w, r, logger, "list_invitations", err)
		return
	}
	response := api.TeamInvitationList{Items: make([]api.TeamInvitation, 0, len(items))}
	for _, i := range items {
		response.Items = append(response.Items, teamInvitationResponse(i))
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, response)
}
func (h *teamHandler) createInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	_, err := httpx.QueryValues(r)
	var expected string
	if err == nil {
		expected, err = invitationActor(w, r)
	}
	if err != nil {
		writeTeamError(w, r, logger, "create_invitation", err)
		return
	}
	result, err := h.teams.CreateInvitation(r.Context(), p, r.PathValue("teamId"), expected)
	if err != nil {
		writeTeamError(w, r, logger, "create_invitation", err)
		return
	}
	w.Header().Set("Location", "/api/v1/teams/"+result.Invitation.TeamID+"/invitations/"+result.Invitation.ID)
	writeTeamJSON(w, r, logger, http.StatusCreated, api.CreatedTeamInvitation{TeamInvitation: teamInvitationResponse(result.Invitation), Link: h.origin + "/team-invitations#" + result.Secret})
}
func (h *teamHandler) revokeInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	_, err := httpx.QueryValues(r)
	var expected string
	if err == nil {
		expected, err = invitationActor(w, r)
	}
	if err == nil {
		changed, revokeErr := h.teams.RevokeInvitation(r.Context(), p, r.PathValue("teamId"), r.PathValue("inviteId"), expected)
		err = revokeErr
		if err == nil {
			writeTeamJSON(w, r, logger, http.StatusOK, struct {
				TeamID       string `json:"teamId"`
				InvitationID string `json:"invitationId"`
				Changed      bool   `json:"changed"`
			}{r.PathValue("teamId"), r.PathValue("inviteId"), changed})
			return
		}
	}
	if err != nil {
		writeTeamError(w, r, logger, "revoke_invitation", err)
		return
	}

}
func (h *teamHandler) inspectInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	_, err := httpx.QueryValues(r)
	var token string
	if err == nil {
		token, err = invitationToken(w, r)
	}
	if err != nil {
		httpx.WriteError(w, r, logger, "team", "inspect_invitation", err)
		return
	}
	result, err := h.teams.InspectInvitation(r.Context(), p, token)
	if err != nil {
		httpx.WriteError(w, r, logger, "team", "inspect_invitation", err)
		return
	}
	response := api.TeamInvitationInspection{Team: httpx.TeamRefResponse(result.Team)}
	if result.Membership != nil {
		m := teamMemberResponse(*result.Membership)
		response.Membership = &m
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, response)
}
func (h *teamHandler) acceptInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	_, err := httpx.QueryValues(r)
	var token, expected string
	if err == nil {
		var fieldsErr error
		fields, fieldsErr := httpx.DecodeObject(w, r, "token", "expectedUserId")
		err = fieldsErr
		if err == nil {
			token, err = httpx.RequiredString(fields, "token")
		}
		if err == nil {
			expected, err = httpx.RequiredString(fields, "expectedUserId")
		}
	}
	if err != nil {
		writeTeamError(w, r, logger, "accept_invitation", err)
		return
	}
	result, err := h.teams.AcceptInvitation(r.Context(), p, token, expected)
	if err != nil {
		writeTeamError(w, r, logger, "accept_invitation", err)
		return
	}
	writeTeamJSON(w, r, logger, http.StatusOK, api.TeamInvitationAcceptance{Team: httpx.TeamRefResponse(result.Team), Membership: teamMemberResponse(result.Membership), Joined: result.Joined, Consumed: result.Consumed})
}
