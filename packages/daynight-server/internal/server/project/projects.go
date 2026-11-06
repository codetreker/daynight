package project

import (
	"log/slog"
	"net/http"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type projectHandler struct {
	projects *projectservice.Projects
	logger   *slog.Logger
}

// RegisterRoutes mounts the authenticated Project endpoints.
func RegisterRoutes(mux *http.ServeMux, projects *projectservice.Projects, auth *authhttp.Authentication, logger *slog.Logger) {
	handler := &projectHandler{projects: projects, logger: logger}
	mux.HandleFunc("POST /api/v1/projects", auth.Require(handler.create))
	mux.HandleFunc("GET /api/v1/projects", auth.Require(handler.list))
	mux.HandleFunc("GET /api/v1/projects/{projectId}", auth.Require(handler.get))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}", auth.Require(handler.delete))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/deletion-preview", auth.Require(handler.deletionPreview))
	mux.HandleFunc("/api/v1/projects/{projectId}/deletion-preview", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/access", auth.Require(handler.access))
	mux.HandleFunc("/api/v1/projects/{projectId}/access", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/transfer-preview", auth.Require(handler.transferPreview))
	mux.HandleFunc("/api/v1/projects/{projectId}/transfer-preview", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/transfer", auth.Require(handler.transfer))
	mux.HandleFunc("/api/v1/projects/{projectId}/transfer", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/settings", auth.Require(handler.settings))
	mux.HandleFunc("/api/v1/projects/{projectId}/settings", auth.Require(httpx.ResourceMethodNotAllowed(logger, "PATCH")))
	mux.HandleFunc("/api/v1/projects", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/projects/{projectId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, DELETE")))
}

// ProjectResponse projects a Project into its HTTP representation.
func ProjectResponse(project model.Project) api.Project {
	return api.Project{ID: project.ID, Name: project.Name, RepoURL: project.RepoURL,
		CreatedAt: project.CreatedAt.UTC(), UpdatedAt: project.UpdatedAt.UTC(),
		Settings:  api.ProjectSettings{Version: project.Settings.Version, ExecutionWarningMinutes: project.Settings.ExecutionWarningMinutes},
		Ownership: OwnershipResponse(project.Ownership)}
}

func (h *projectHandler) create(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	fields, err := httpx.DecodeObject(w, request, "name", "repoUrl", "teamId", "expectedUserId")
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "create", err)
		return
	}
	if !jsonunicode.Valid(fields["name"]) || !jsonunicode.Valid(fields["repoUrl"]) {
		httpx.WriteError(w, request, logger, "project", "create", httpx.InvalidInput("name and repoUrl must contain valid Unicode text"))
		return
	}
	name, err := httpx.RequiredString(fields, "name")
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "create", err)
		return
	}
	repoURL, err := httpx.RequiredString(fields, "repoUrl")
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "create", err)
		return
	}
	teamID, err := httpx.OptionalString(fields, "teamId")
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "create", err)
		return
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "create", err)
		return
	}
	input := api.CreateProjectRequest{Name: name, RepoURL: repoURL, TeamID: teamID, ExpectedUserID: expected}
	project, access, err := h.projects.CreateWithAccess(request.Context(), principal, coreproject.CreateProject{Name: input.Name, RepoURL: input.RepoURL, TeamID: input.TeamID, ExpectedUserID: input.ExpectedUserID})
	if err != nil {
		writeProjectCreateError(w, request, logger, err)
		return
	}
	logger = logger.With("project_id", project.ID)
	logger.InfoContext(request.Context(), "project created", "type", "resource", "component", "project", "phase", "create", "request_id", httpx.RequestID(request.Context()))
	w.Header().Set("Location", "/api/v1/projects/"+project.ID)
	httpx.WriteMutationJSON(w, request, logger, "project", http.StatusCreated, api.ProjectDocument{Project: ProjectResponse(project), Access: AccessResponse(access)})
}

func writeProjectCreateError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	if fault, classified := team.WriteFault(err); classified {
		if fault.Code == "write_outcome_unknown" || fault.Code == "internal_error" {
			status := http.StatusInternalServerError
			phase := "completion"
			if fault.Code == "write_outcome_unknown" {
				status, phase = http.StatusServiceUnavailable, "commit"
				logger = logger.With("write_outcome", "unknown")
			}
			httpx.LogFailure(logger, r.Context(), "project", phase, fault)
			httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
			return
		}
		err = fault
	}
	httpx.WriteError(w, r, logger, "project", "create", err)
}

func (h *projectHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	values, err := httpx.QueryValues(request, "limit", "cursor", "teamId", "shared")
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "list", err)
		return
	}
	page, err := httpx.PageValues(values)
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "list", err)
		return
	}
	input := coreproject.ProjectListRequest{Page: page}
	if team, exists := values["teamId"]; exists {
		input.TeamID = &team[0]
	}
	if shared, exists := values["shared"]; exists {
		if shared[0] != "true" || input.TeamID != nil {
			httpx.WriteError(w, request, logger, "project", "list", httpx.InvalidInput("shared must be true and cannot be combined with teamId"))
			return
		}
		input.Shared = true
	}
	result, err := h.projects.ListScoped(request.Context(), principal, input)
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "list", err)
		return
	}
	response := api.ProjectPage{Items: make([]api.Project, 0, len(result.Items)), NextCursor: result.NextCursor}
	for _, project := range result.Items {
		response.Items = append(response.Items, ProjectResponse(project))
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *projectHandler) get(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	id, err := model.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "get", err)
		return
	}
	logger = logger.With("project_id", id)
	project, access, err := h.projects.GetWithAccess(request.Context(), principal, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "project", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "project read", "type", "resource", "component", "project", "phase", "get", "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, http.StatusOK, api.ProjectDocument{Project: ProjectResponse(project), Access: AccessResponse(access)})
}
