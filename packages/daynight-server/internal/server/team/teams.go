package team

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type teamHandler struct {
	teams         *teamservice.Teams
	addMember     func(context.Context, model.Principal, string, coreteam.AddTeamMember) (coreteam.DirectMemberResult, error)
	resolveMember func(context.Context, model.Principal, string, coreteam.ResolveTeamMember) (*model.TeamMember, error)
	logger        *slog.Logger
	origin        string
}

func RegisterRoutes(mux *http.ServeMux, teams *teamservice.Teams, auth *authhttp.Authentication, logger *slog.Logger) {
	h := &teamHandler{teams: teams, logger: logger, origin: auth.Origin()}
	mux.HandleFunc("GET /api/v1/teams", auth.Require(h.list))
	mux.HandleFunc("POST /api/v1/teams", auth.Require(h.create))
	mux.HandleFunc("GET /api/v1/teams/{teamId}", auth.Require(h.get))
	mux.HandleFunc("PATCH /api/v1/teams/{teamId}", auth.Require(h.rename))
	mux.HandleFunc("DELETE /api/v1/teams/{teamId}", auth.Require(h.remove))
	mux.HandleFunc("GET /api/v1/teams/{teamId}/members", auth.Require(h.listMembers))
	mux.HandleFunc("PATCH /api/v1/teams/{teamId}/members/{userId}", auth.Require(h.setMemberRole))
	mux.HandleFunc("DELETE /api/v1/teams/{teamId}/members/{userId}", auth.Require(h.removeMember))
	mux.HandleFunc("/api/v1/teams/{teamId}/members", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/teams/{teamId}/members/{userId}", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		allowed := "PATCH, DELETE"
		if r.PathValue("userId") == "resolve" {
			allowed = "POST"
		}
		httpx.ResourceMethodNotAllowed(logger, allowed)(w, r, p)
	}))
	mux.HandleFunc("GET /api/v1/teams/{teamId}/invitations", auth.Require(h.listInvitations))
	mux.HandleFunc("POST /api/v1/teams/{teamId}/invitations", auth.Require(h.createInvitation))
	mux.HandleFunc("DELETE /api/v1/teams/{teamId}/invitations/{inviteId}", auth.Require(h.revokeInvitation))
	mux.HandleFunc("POST /api/v1/team-invitations/inspect", auth.Require(h.inspectInvitation))
	mux.HandleFunc("POST /api/v1/team-invitations/accept", auth.Require(h.acceptInvitation))
	mux.HandleFunc("/api/v1/teams/{teamId}/invitations", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/teams/{teamId}/invitations/{inviteId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "DELETE")))
	mux.HandleFunc("/api/v1/team-invitations/inspect", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("/api/v1/team-invitations/accept", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("/api/v1/teams", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/teams/{teamId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PATCH, DELETE")))
}

func teamResponse(team model.Team) api.Team {
	m := team.Membership
	return api.Team{TeamRef: httpx.TeamRefResponse(team.TeamRef), Version: team.Version, CreatedAt: team.CreatedAt.UTC(), UpdatedAt: team.UpdatedAt.UTC(), Membership: api.TeamMember{TeamID: m.TeamID, UserID: m.UserID, Role: string(m.Role), Version: m.Version, CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC()}}
}

func teamNameInput(fields map[string]json.RawMessage) (string, error) {
	if !jsonunicode.Valid(fields["name"]) {
		return "", httpx.InvalidInput("name must contain valid Unicode text")
	}
	return httpx.RequiredString(fields, "name")
}

func (h *teamHandler) create(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	if _, err := httpx.QueryValues(r); err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	fields, err := httpx.DecodeObject(w, r, "name", "expectedUserId")
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	name, err := teamNameInput(fields)
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	team, err := h.teams.Create(r.Context(), p, coreteam.CreateTeam{Name: name, ExpectedUserID: expected})
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	w.Header().Set("Location", "/api/v1/teams/"+team.ID)
	writeTeamJSON(w, r, logger.With("team_id", team.ID), http.StatusCreated, teamResponse(team))
}

func (h *teamHandler) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	page, err := httpx.PageRequest(r)
	if err != nil {
		httpx.WriteError(w, r, logger, "team", "list", err)
		return
	}
	result, err := h.teams.List(r.Context(), p, page)
	if err != nil {
		httpx.WriteError(w, r, logger, "team", "list", err)
		return
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, teamPageResponse(result.Items, result.NextCursor))
}

func teamPageResponse(items []model.Team, cursor *string) api.TeamPage {
	response := api.TeamPage{Items: make([]api.Team, 0, len(items)), NextCursor: cursor}
	for _, team := range items {
		response.Items = append(response.Items, teamResponse(team))
	}
	return response
}

func (h *teamHandler) get(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.WriteError(w, r, logger, "team", "get", err)
		return
	}
	team, err := h.teams.Get(r.Context(), p, r.PathValue("teamId"))
	if err != nil {
		httpx.WriteError(w, r, logger, "team", "get", err)
		return
	}
	httpx.WriteJSON(w, r, logger.With("team_id", team.ID), http.StatusOK, teamResponse(team))
}

func teamChangeInput(w http.ResponseWriter, r *http.Request) (coreteam.ChangeTeam, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return coreteam.ChangeTeam{}, err
	}
	fields, err := httpx.DecodeObject(w, r, "name", "version", "expectedUserId")
	if err != nil {
		return coreteam.ChangeTeam{}, err
	}
	name, err := teamNameInput(fields)
	if err != nil {
		return coreteam.ChangeTeam{}, err
	}
	version, err := httpx.VersionInput(fields)
	if err != nil {
		return coreteam.ChangeTeam{}, err
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	return coreteam.ChangeTeam{Name: name, Version: version, ExpectedUserID: expected}, err
}

func (h *teamHandler) rename(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	input, err := teamChangeInput(w, r)
	if err != nil {
		writeTeamError(w, r, logger, "rename", err)
		return
	}
	team, err := h.teams.Rename(r.Context(), p, r.PathValue("teamId"), input)
	if err != nil {
		writeTeamError(w, r, logger, "rename", err)
		return
	}
	writeTeamJSON(w, r, logger.With("team_id", team.ID), http.StatusOK, teamResponse(team))
}

func (h *teamHandler) remove(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	input, err := teamChangeInput(w, r)
	if err != nil {
		writeTeamError(w, r, logger, "delete", err)
		return
	}
	id := r.PathValue("teamId")
	if err := h.teams.Delete(r.Context(), p, id, input); err != nil {
		writeTeamError(w, r, logger, "delete", err)
		return
	}
	writeTeamJSON(w, r, logger.With("team_id", id), http.StatusOK, api.DeleteTeamReceipt{TeamID: id, Deleted: true})
}

func writeTeamError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, err error) {
	if fault, classified := coreteam.WriteFault(err); classified {
		if fault.Code == "write_outcome_unknown" || fault.Code == "internal_error" {
			logger = logger.With("team_error_code", fault.Code)
			status := http.StatusInternalServerError
			if fault.Code == "write_outcome_unknown" {
				status = http.StatusServiceUnavailable
				phase = "commit"
				logger = logger.With("write_outcome", "unknown")
			} else {
				phase = "completion"
			}
			httpx.LogFailure(logger, r.Context(), "team", phase, fault)
			httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
			return
		}
		err = fault
	}
	httpx.WriteError(w, r, logger, "team", phase, err)
}

func writeTeamJSON(w http.ResponseWriter, r *http.Request, logger *slog.Logger, status int, value any) {
	httpx.WriteMutationJSON(w, r, logger, "team", status, value)
}
