package team

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func RegisterDirectMemberRoutes(mux *http.ServeMux, members *teamservice.DirectMembers, auth *authhttp.Authentication, logger *slog.Logger) {
	h := &teamHandler{addMember: members.AddMember, resolveMember: members.ResolveMember, logger: logger}
	mux.HandleFunc("POST /api/v1/teams/{teamId}/members", auth.Require(h.addDirectMember))
	mux.HandleFunc("POST /api/v1/teams/{teamId}/members/resolve", auth.Require(h.resolveDirectMember))
	mux.HandleFunc("PATCH /api/v1/teams/{teamId}/members/resolve", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("DELETE /api/v1/teams/{teamId}/members/resolve", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
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
		writeDirectMemberError(w, r, logger, err)
		return
	}
	result, err := h.addMember(r.Context(), p, r.PathValue("teamId"), input)
	if err != nil {
		writeDirectMemberError(w, r, logger, err)
		return
	}
	writeTeamJSON(w, r, logger.With("team_id", result.Membership.TeamID), http.StatusOK, api.AddTeamMemberReceipt{Membership: teamMemberResponse(result.Membership), Added: result.Added, ActorRole: string(model.ProjectAdmin)})
}

func writeDirectMemberError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	if fault, classified := coreteam.WriteFault(err); classified && (fault.Code == "internal_error" || fault.Code == "write_outcome_unknown") {
		writeTeamError(w, r, logger, "add_member", err)
		return
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed || httpx.ErrorKind(err) == "network" {
		httpx.WriteError(w, r, logger, "team", "add_member", err)
		return
	}
	// Credential refusal can retain a missing credential row as its cause; it does not describe the Team.
	if fault, known := httpx.KnownFault(err); known && fault.Code == "unauthenticated" {
		httpx.WriteError(w, r, logger, "team", "add_member", err)
		return
	}
	writeTeamError(w, r, logger, "add_member", err)
}
