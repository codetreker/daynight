package server

import (
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func projectSettingsInput(fields map[string]json.RawMessage) (api.UpdateProjectSettingsRequest, error) {
	version, err := versionInput(fields)
	if err != nil {
		return api.UpdateProjectSettingsRequest{}, err
	}
	var minutes int32
	if err := json.Unmarshal(fields["executionWarningMinutes"], &minutes); err != nil || minutes < 1 {
		return api.UpdateProjectSettingsRequest{}, invalidInput("executionWarningMinutes is required and must be a positive 32-bit integer")
	}
	return api.UpdateProjectSettingsRequest{Version: version, ExecutionWarningMinutes: minutes}, nil
}

func (h *projectHandler) settings(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	id, err := service.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		writeError(w, request, logger, "project", "settings", err)
		return
	}
	logger = logger.With("project_id", id)
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeError(w, request, logger, "project", "settings", invalidInput("project settings do not accept query parameters"))
		return
	}
	fields, err := decodeObject(w, request, "version", "executionWarningMinutes")
	if err != nil {
		writeError(w, request, logger, "project", "settings", err)
		return
	}
	input, err := projectSettingsInput(fields)
	if err != nil {
		writeError(w, request, logger, "project", "settings", err)
		return
	}
	project, err := h.projects.UpdateSettings(request.Context(), principal, id, service.UpdateProjectSettings{
		Version: input.Version, ExecutionWarningMinutes: input.ExecutionWarningMinutes,
	})
	if err != nil {
		writeError(w, request, logger, "project", "settings", err)
		return
	}
	logger.InfoContext(request.Context(), "project settings saved", "type", "resource", "component", "project", "phase", "settings", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, projectResponse(project))
}
