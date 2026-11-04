package server

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func projectGrantResponse(grant core.ProjectGrant) api.ProjectGrant {
	return api.ProjectGrant{ProjectID: grant.ProjectID, UserID: grant.UserID, Role: string(grant.Role),
		Version: grant.Version, CreatedAt: grant.CreatedAt.UTC(), UpdatedAt: grant.UpdatedAt.UTC()}
}

func projectAccessResponse(access core.ProjectAccess) api.ProjectAccess {
	var direct *api.ProjectGrant
	if grant := access.DirectGrant; grant != nil {
		response := projectGrantResponse(*grant)
		direct = &response
	}
	return api.ProjectAccess{EffectiveRole: string(access.Role), DirectGrant: direct}
}

func (h *projectHandler) access(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	projectID, err := service.CanonicalID(request.PathValue("projectId"))
	if err == nil {
		_, err = queryValues(request)
	}
	if err != nil {
		writeError(w, request, logger, "project_access", "get", err)
		return
	}
	logger = logger.With("project_id", projectID)
	access, err := h.projects.Access(request.Context(), principal, projectID)
	if err != nil {
		writeError(w, request, logger, "project_access", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "project access read", "type", "resource", "component", "project_access", "phase", "get", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, projectAccessResponse(access))
}
