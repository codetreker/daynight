package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonunicode"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type teamHandler struct {
	teams  *service.Teams
	logger *slog.Logger
	origin string
}

func teamRoutes(mux *http.ServeMux, teams *service.Teams, auth *Authentication, logger *slog.Logger) {
	h := &teamHandler{teams: teams, logger: logger, origin: auth.origin}
	mux.HandleFunc("GET /api/v1/teams", auth.Require(h.list))
	mux.HandleFunc("POST /api/v1/teams", auth.Require(h.create))
	mux.HandleFunc("GET /api/v1/teams/{teamId}", auth.Require(h.get))
	mux.HandleFunc("PATCH /api/v1/teams/{teamId}", auth.Require(h.rename))
	mux.HandleFunc("DELETE /api/v1/teams/{teamId}", auth.Require(h.remove))
	mux.HandleFunc("GET /api/v1/teams/{teamId}/members", auth.Require(h.listMembers))
	mux.HandleFunc("PATCH /api/v1/teams/{teamId}/members/{userId}", auth.Require(h.setMemberRole))
	mux.HandleFunc("DELETE /api/v1/teams/{teamId}/members/{userId}", auth.Require(h.removeMember))
	mux.HandleFunc("/api/v1/teams/{teamId}/members", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("/api/v1/teams/{teamId}/members/{userId}", auth.Require(resourceMethodNotAllowed(logger, "PATCH, DELETE")))
	mux.HandleFunc("GET /api/v1/teams/{teamId}/invitations", auth.Require(h.listInvitations))
	mux.HandleFunc("POST /api/v1/teams/{teamId}/invitations", auth.Require(h.createInvitation))
	mux.HandleFunc("DELETE /api/v1/teams/{teamId}/invitations/{inviteId}", auth.Require(h.revokeInvitation))
	mux.HandleFunc("POST /api/v1/team-invitations/inspect", auth.Require(h.inspectInvitation))
	mux.HandleFunc("POST /api/v1/team-invitations/accept", auth.Require(h.acceptInvitation))
	mux.HandleFunc("/api/v1/teams/{teamId}/invitations", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/teams/{teamId}/invitations/{inviteId}", auth.Require(resourceMethodNotAllowed(logger, "DELETE")))
	mux.HandleFunc("/api/v1/team-invitations/inspect", auth.Require(resourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("/api/v1/team-invitations/accept", auth.Require(resourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("/api/v1/teams", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/teams/{teamId}", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, PATCH, DELETE")))
}

func teamResponse(team model.Team) api.Team {
	m := team.Membership
	return api.Team{TeamRef: teamRefResponse(team.TeamRef), Version: team.Version, CreatedAt: team.CreatedAt.UTC(), UpdatedAt: team.UpdatedAt.UTC(), Membership: api.TeamMember{TeamID: m.TeamID, UserID: m.UserID, Role: string(m.Role), Version: m.Version, CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC()}}
}

func teamNameInput(fields map[string]json.RawMessage) (string, error) {
	if !jsonunicode.Valid(fields["name"]) {
		return "", invalidInput("name must contain valid Unicode text")
	}
	return requiredString(fields, "name")
}

func (h *teamHandler) create(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	if _, err := queryValues(r); err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	fields, err := decodeObject(w, r, "name", "expectedUserId")
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	name, err := teamNameInput(fields)
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	expected, err := requiredString(fields, "expectedUserId")
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	team, err := h.teams.Create(r.Context(), p, service.CreateTeam{Name: name, ExpectedUserID: expected})
	if err != nil {
		writeTeamError(w, r, logger, "create", err)
		return
	}
	w.Header().Set("Location", "/api/v1/teams/"+team.ID)
	writeTeamJSON(w, r, logger.With("team_id", team.ID), http.StatusCreated, teamResponse(team))
}

func (h *teamHandler) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	page, err := pageRequest(r)
	if err != nil {
		writeError(w, r, logger, "team", "list", err)
		return
	}
	result, err := h.teams.List(r.Context(), p, page)
	if err != nil {
		writeError(w, r, logger, "team", "list", err)
		return
	}
	response := api.TeamPage{Items: make([]api.Team, 0, len(result.Items)), NextCursor: result.NextCursor}
	for _, team := range result.Items {
		response.Items = append(response.Items, teamResponse(team))
	}
	writeJSON(w, r, logger, http.StatusOK, response)
}

func (h *teamHandler) get(w http.ResponseWriter, r *http.Request, p model.Principal) {
	logger := h.logger.With("user_id", p.UserID)
	if _, err := queryValues(r); err != nil {
		writeError(w, r, logger, "team", "get", err)
		return
	}
	team, err := h.teams.Get(r.Context(), p, r.PathValue("teamId"))
	if err != nil {
		writeError(w, r, logger, "team", "get", err)
		return
	}
	writeJSON(w, r, logger.With("team_id", team.ID), http.StatusOK, teamResponse(team))
}

func teamChangeInput(w http.ResponseWriter, r *http.Request) (service.ChangeTeam, error) {
	if _, err := queryValues(r); err != nil {
		return service.ChangeTeam{}, err
	}
	fields, err := decodeObject(w, r, "name", "version", "expectedUserId")
	if err != nil {
		return service.ChangeTeam{}, err
	}
	name, err := teamNameInput(fields)
	if err != nil {
		return service.ChangeTeam{}, err
	}
	version, err := versionInput(fields)
	if err != nil {
		return service.ChangeTeam{}, err
	}
	expected, err := requiredString(fields, "expectedUserId")
	return service.ChangeTeam{Name: name, Version: version, ExpectedUserID: expected}, err
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
	if fault, classified := service.TeamResponseFault(err); classified {
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
			LogFailure(logger, r.Context(), "team", phase, fault)
			writeJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: RequestID(r.Context())}})
			return
		}
		err = fault
	}
	writeError(w, r, logger, "team", phase, err)
}

func writeTeamJSON(w http.ResponseWriter, r *http.Request, logger *slog.Logger, status int, value any) {
	writeMutationJSON(w, r, logger, "team", status, value)
}

func writeMutationJSON(w http.ResponseWriter, r *http.Request, logger *slog.Logger, component string, status int, value any) {
	responseLogger := logger.With(component+"_error_code", "write_outcome_unknown", "write_outcome", "unknown")
	data, err := json.Marshal(value)
	if err != nil {
		fault := &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: err}
		LogFailure(responseLogger, r.Context(), component, "response", fault)
		writeJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: RequestID(r.Context())}})
		return
	}
	if r.Context().Err() != nil {
		LogFailure(responseLogger, r.Context(), component, "response", &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: r.Context().Err()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	data = append(data, '\n')
	written, err := w.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		LogFailure(responseLogger, r.Context(), component, "response", &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: err})
		return
	}
	logger.InfoContext(r.Context(), "write response", "type", "resource", "component", component, "phase", "response", "status", status, "written_bytes", written, "request_id", RequestID(r.Context()))
}
