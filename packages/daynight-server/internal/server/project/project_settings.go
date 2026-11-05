package project

import (
	"encoding/json"
	"net/http"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func projectSettingsInput(fields map[string]json.RawMessage) (api.UpdateProjectSettingsRequest, error) {
	version, err := httpx.VersionInput(fields)
	if err != nil {
		return api.UpdateProjectSettingsRequest{}, err
	}
	var minutes int32
	if err := json.Unmarshal(fields["executionWarningMinutes"], &minutes); err != nil || minutes < 1 {
		return api.UpdateProjectSettingsRequest{}, httpx.InvalidInput("executionWarningMinutes is required and must be a positive 32-bit integer")
	}
	return api.UpdateProjectSettingsRequest{Version: version, ExecutionWarningMinutes: minutes}, nil
}

func (h *projectHandler) settings(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	id, err := model.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "settings", err)
		return
	}
	logger = logger.With("project_id", id)
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		httpx.WriteError(w, request, logger, "project", "settings", httpx.InvalidInput("project settings do not accept query parameters"))
		return
	}
	fields, err := httpx.DecodeObject(w, request, "version", "executionWarningMinutes")
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "settings", err)
		return
	}
	input, err := projectSettingsInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "settings", err)
		return
	}
	project, err := h.projects.UpdateSettings(request.Context(), principal, id, coreproject.UpdateProjectSettings{
		Version: input.Version, ExecutionWarningMinutes: input.ExecutionWarningMinutes,
	})
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "settings", err)
		return
	}
	logger.InfoContext(request.Context(), "project settings saved", "type", "resource", "component", "project", "phase", "settings", "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, http.StatusOK, ProjectResponse(project))
}
