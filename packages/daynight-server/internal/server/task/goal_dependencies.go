package task

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/goaldependencies"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type GoalDependencyService interface {
	ShowGoalDependencies(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error)
	EditGoalDependencies(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error)
}

type goalDependencyHandler struct {
	service GoalDependencyService
	logger  *slog.Logger
}

func GoalDependencyRoutes(mux *http.ServeMux, service GoalDependencyService, auth RouteAuthentication, logger *slog.Logger) {
	h := &goalDependencyHandler{service: service, logger: logger}
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/goal-dependencies"
	mux.HandleFunc("GET "+path, auth.Require(h.show))
	mux.HandleFunc("PATCH "+path, auth.Require(h.edit))
	mux.HandleFunc(path, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PATCH")))
}

func (h *goalDependencyHandler) show(w http.ResponseWriter, r *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, goalID, logger, err := TaskResource(r, principal, h.logger)
	if err != nil {
		httpx.WriteError(w, r, logger, "goal_dependencies", "input", err)
		return
	}
	values, err := httpx.QueryValues(r, "limit", "cursor")
	if err != nil {
		httpx.WriteError(w, r, logger, "goal_dependencies", "input", err)
		return
	}
	page := model.PageRequest{Limit: 20}
	if values.Has("limit") {
		page.Limit, err = strconv.Atoi(values.Get("limit"))
		if err != nil || page.Limit < 1 || page.Limit > 50 {
			httpx.WriteError(w, r, logger, "goal_dependencies", "input", httpx.InvalidInput("limit must be an integer from 1 to 50."))
			return
		}
	}
	if values.Has("cursor") {
		cursor := values.Get("cursor")
		page.Cursor = &cursor
	}
	result, err := h.service.ShowGoalDependencies(r.Context(), principal, projectID, goalID, page)
	if err != nil {
		httpx.WriteError(w, r, logger, "goal_dependencies", "read", err)
		return
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, protocol.MapRelationships(result))
}

func (h *goalDependencyHandler) edit(w http.ResponseWriter, r *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, goalID, logger, err := TaskResource(r, principal, h.logger)
	if err != nil {
		httpx.WriteError(w, r, logger, "goal_dependencies", "input", err)
		return
	}
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.WriteError(w, r, logger, "goal_dependencies", "input", err)
		return
	}
	data, err := httpx.ReadJSONBodyLimit(w, r, httpx.MaxJSONBody, transport.JSONBodyReadTimeout)
	if err != nil {
		httpx.WriteError(w, r, logger, "goal_dependencies", "input", err)
		return
	}
	input, err := protocol.DecodeEdit(data)
	if err != nil {
		httpx.WriteError(w, r, logger, "goal_dependencies", "input", err)
		return
	}
	result, err := h.service.EditGoalDependencies(r.Context(), principal, projectID, goalID, input)
	if err != nil {
		if writeGoalOutcomeUnknown(w, r, logger, "goal_dependencies", err) {
			return
		}
		httpx.WriteError(w, r, logger, "goal_dependencies", "write", err)
		return
	}
	httpx.WriteOperationJSON(w, r, logger, "goal_dependencies", http.StatusOK, protocol.MapReceipt(result))
}
