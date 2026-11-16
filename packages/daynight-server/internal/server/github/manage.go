package github

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type ManagementOperations interface {
	Discover(context.Context, model.Principal, string) (core.InstallationCandidate, error)
	Connect(context.Context, model.Principal, string, int64, int64) (core.Status, error)
	Disconnect(context.Context, model.Principal, string, int64) (core.Status, error)
	Settings(context.Context, model.Principal, string, int64, int32) (core.Status, error)
	Sync(context.Context, model.Principal, string, int64, bool) (core.Status, error)
}
type managementHandler struct {
	operations ManagementOperations
	logger     *slog.Logger
}

func RegisterManagementRoutes(mux *http.ServeMux, ops ManagementOperations, auth RouteAuthentication, logger *slog.Logger) {
	h := &managementHandler{operations: ops, logger: logger}
	mux.HandleFunc("GET /api/v1/projects/{projectId}/github/installation", auth.Require(h.discover))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/github/connect", auth.Require(h.connect))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/github/disconnect", auth.Require(h.disconnect))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/github/settings", auth.Require(h.settings))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/github/sync", auth.Require(h.sync))
	for _, route := range []struct{ path, allow string }{{"installation", "GET, HEAD"}, {"connect", "POST"}, {"disconnect", "POST"}, {"settings", "PATCH"}, {"sync", "PATCH"}} {
		mux.HandleFunc("/api/v1/projects/{projectId}/github/"+route.path, auth.Require(httpx.ResourceMethodNotAllowed(logger, route.allow)))
	}
}

func (h *managementHandler) sync(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "sync_config", true, func(id string) (any, error) {
		fields, err := httpx.DecodeObject(w, r, "version", "syncEnabled")
		if err != nil {
			return nil, err
		}
		v, err := decimalField(fields, "version")
		if err != nil {
			return nil, err
		}
		var enabled *bool
		if err = json.Unmarshal(fields["syncEnabled"], &enabled); err != nil || enabled == nil {
			return nil, httpx.InvalidInput("syncEnabled must be a boolean")
		}
		s, err := h.operations.Sync(r.Context(), p, id, v, *enabled)
		if err != nil {
			return nil, err
		}
		return mutationStatus(s)
	})
}
func (h *managementHandler) run(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, mutate bool, f func(string) (any, error)) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	id, err := model.CanonicalID(r.PathValue("projectId"))
	if err == nil {
		_, err = query(r)
	}
	var result any
	if err == nil {
		result, err = f(id)
	}
	if err != nil {
		var mgmt *service.ManagementError
		if errors.As(err, &mgmt) {
			httpx.LogFailure(logger.With("project_id", id), r.Context(), "github", phase, err)
			if r.Context().Err() != nil {
				return
			}
			status := http.StatusConflict
			if mgmt.Code == "github_unavailable" || mgmt.Code == "github_rate_limited" {
				status = http.StatusBadGateway
			}
			var details *api.ErrorDetails
			if mgmt.Code == "github_write_outcome_unknown" {
				status = http.StatusServiceUnavailable
				value := "unknown"
				details = &api.ErrorDetails{WriteOutcome: &value}
			}
			httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: mgmt.Code, Message: mgmt.Message, RequestID: httpx.RequestID(r.Context()), Details: details}})
			return
		}
		httpx.WriteError(w, r, logger, "github", phase, err)
		return
	}
	if mutate {
		httpx.WriteMutationJSON(w, r, logger, "github", http.StatusOK, result)
	} else {
		httpx.WriteJSON(w, r, logger, http.StatusOK, result)
	}
}
func decimalField(fields map[string]json.RawMessage, key string) (int64, error) {
	value, err := httpx.RequiredString(fields, key)
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != value {
		return 0, httpx.InvalidInput(key + " must be a positive decimal string")
	}
	return n, nil
}
func (h *managementHandler) discover(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "discover", false, func(id string) (any, error) {
		c, err := h.operations.Discover(r.Context(), p, id)
		if err != nil {
			return nil, err
		}
		private := c.Repository.Private
		return api.GitHubInstallationCandidate{Installation: api.GitHubInstallation{ID: decimal(c.Installation.ID), AccountLogin: c.Installation.AccountLogin}, Repository: api.GitHubRepository{ID: decimal(c.Repository.ID), FullName: c.Repository.FullName, Private: &private}}, nil
	})
}
func (h *managementHandler) connect(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "connect", true, func(id string) (any, error) {
		fields, err := httpx.DecodeObject(w, r, "version", "installationId")
		if err != nil {
			return nil, err
		}
		v, err := decimalField(fields, "version")
		if err != nil {
			return nil, err
		}
		inst, err := decimalField(fields, "installationId")
		if err != nil {
			return nil, err
		}
		s, err := h.operations.Connect(r.Context(), p, id, v, inst)
		if err != nil {
			return nil, err
		}
		return mutationStatus(s)
	})
}
func (h *managementHandler) disconnect(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "disconnect", true, func(id string) (any, error) {
		fields, err := httpx.DecodeObject(w, r, "version")
		if err != nil {
			return nil, err
		}
		v, err := decimalField(fields, "version")
		if err != nil {
			return nil, err
		}
		s, err := h.operations.Disconnect(r.Context(), p, id, v)
		if err != nil {
			return nil, err
		}
		return mutationStatus(s)
	})
}
func (h *managementHandler) settings(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "settings", true, func(id string) (any, error) {
		fields, err := httpx.DecodeObject(w, r, "version", "pollIntervalMinutes")
		if err != nil {
			return nil, err
		}
		v, err := decimalField(fields, "version")
		if err != nil {
			return nil, err
		}
		var minutes int32
		if err = json.Unmarshal(fields["pollIntervalMinutes"], &minutes); err != nil || minutes < 1 {
			return nil, httpx.InvalidInput("pollIntervalMinutes must be a positive 32-bit integer")
		}
		s, err := h.operations.Settings(r.Context(), p, id, v, minutes)
		if err != nil {
			return nil, err
		}
		return mutationStatus(s)
	})
}

// A committed mutation whose response cannot be encoded must not be reported as a definite failure.
func mutationStatus(s core.Status) (api.GitHubStatus, error) {
	response, err := statusResponse(s)
	if err != nil {
		return api.GitHubStatus{}, &service.ManagementError{Code: "github_write_outcome_unknown", Message: "GitHub configuration write outcome is unknown; read the resource before deciding what to do.", Cause: err}
	}
	return response, nil
}
