package project

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// GrantResponse projects a stored grant without changing its role or version.
func GrantResponse(grant model.ProjectGrant) api.ProjectGrant {
	return api.ProjectGrant{ProjectID: grant.ProjectID, UserID: grant.UserID, Role: string(grant.Role),
		Version: grant.Version, CreatedAt: grant.CreatedAt.UTC(), UpdatedAt: grant.UpdatedAt.UTC()}
}

// AccessResponse projects the independently observed effective access and grant.
func AccessResponse(access model.ProjectAccess) api.ProjectAccess {
	var direct *api.ProjectGrant
	if grant := access.DirectGrant; grant != nil {
		response := GrantResponse(*grant)
		direct = &response
	}
	var teamRole *string
	if access.TeamRole != nil {
		role := string(*access.TeamRole)
		teamRole = &role
	}
	return api.ProjectAccess{ProjectID: access.ProjectID, OwnerTeam: httpx.TeamRefResponse(access.OwnerTeam), Ownership: OwnershipResponse(access.Ownership), EffectiveRole: string(access.Role), DirectGrant: direct, TeamRole: teamRole, CanTransfer: access.CanTransfer}
}

func (h *projectHandler) access(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	projectID, err := model.CanonicalID(request.PathValue("projectId"))
	if err == nil {
		_, err = httpx.QueryValues(request)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "project_access", "get", err)
		return
	}
	logger = logger.With("project_id", projectID)
	access, err := h.projects.Access(request.Context(), principal, projectID)
	if err != nil {
		httpx.WriteError(w, request, logger, "project_access", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "project access read", "type", "resource", "component", "project_access", "phase", "get", "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, http.StatusOK, AccessResponse(access))
}

// OwnershipResponse preserves the observed ownership version.
func OwnershipResponse(ownership model.ProjectOwnership) api.ProjectOwnership {
	return api.ProjectOwnership{TeamID: ownership.TeamID, Version: ownership.Version}
}
