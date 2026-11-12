package team

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func RegisterDirectMemberRoutes(mux *http.ServeMux, members *teamservice.DirectMembers, auth *authhttp.Authentication, logger *slog.Logger) {
	h := &teamHandler{addMember: members.AddMember, logger: logger}
	mux.HandleFunc("POST /api/v1/teams/{teamId}/members", auth.Require(h.addDirectMember))
}

func directMemberInput(w http.ResponseWriter, r *http.Request) (coreteam.AddTeamMember, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return coreteam.AddTeamMember{}, err
	}
	fields, err := httpx.DecodeObject(w, r, "expectedUserId", "user", "role")
	if err != nil {
		return coreteam.AddTeamMember{}, err
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		return coreteam.AddTeamMember{}, err
	}
	role, err := httpx.RequiredString(fields, "role")
	if err != nil {
		return coreteam.AddTeamMember{}, err
	}
	input, err := authhttp.DecodeExternalUserInput(fields["user"])
	if err != nil {
		return coreteam.AddTeamMember{}, err
	}
	user, err := authhttp.ExternalUser(input)
	if err != nil {
		return coreteam.AddTeamMember{}, err
	}
	return coreteam.AddTeamMember{ExpectedUserID: expected, User: user, Role: model.ProjectRole(role)}, nil
}

func (h *teamHandler) addDirectMember(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	input, err := directMemberInput(w, r)
	if err != nil {
		writeTeamError(w, r, logger, "add_member", err)
		return
	}
	result, err := h.addMember(r.Context(), p, r.PathValue("teamId"), input)
	if err != nil {
		writeTeamError(w, r, logger, "add_member", err)
		return
	}
	writeTeamJSON(w, r, logger.With("team_id", result.Membership.TeamID), http.StatusOK, api.AddTeamMemberReceipt{Membership: teamMemberResponse(result.Membership), Added: result.Added, ActorRole: string(model.ProjectAdmin)})
}
