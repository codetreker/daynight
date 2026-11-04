package server

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type projectHandler struct {
	projects *service.Projects
	logger   *slog.Logger
}

func projectRoutes(mux *http.ServeMux, projects *service.Projects, auth *Authentication, logger *slog.Logger) {
	handler := &projectHandler{projects: projects, logger: logger}
	mux.HandleFunc("POST /api/v1/projects", auth.Require(handler.create))
	mux.HandleFunc("GET /api/v1/projects", auth.Require(handler.list))
	mux.HandleFunc("GET /api/v1/projects/{projectId}", auth.Require(handler.get))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/access", auth.Require(handler.access))
	mux.HandleFunc("/api/v1/projects/{projectId}/access", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/settings", auth.Require(handler.settings))
	mux.HandleFunc("/api/v1/projects/{projectId}/settings", auth.Require(resourceMethodNotAllowed(logger, "PATCH")))
	mux.HandleFunc("/api/v1/projects", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/projects/{projectId}", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
}

func resourceMethodNotAllowed(logger *slog.Logger, allowed string) AuthenticatedHandler {
	return func(w http.ResponseWriter, request *http.Request, principal core.Principal) {
		w.Header().Set("Cache-Control", "no-store")
		methodNotAllowed(logger.With("user_id", principal.UserID), allowed)(w, request)
	}
}

func projectResponse(project core.Project) api.Project {
	return api.Project{ID: project.ID, Name: project.Name, RepoURL: project.RepoURL,
		CreatedAt: project.CreatedAt.UTC(), UpdatedAt: project.UpdatedAt.UTC(),
		Settings:  api.ProjectSettings{Version: project.Settings.Version, ExecutionWarningMinutes: project.Settings.ExecutionWarningMinutes},
		Ownership: ownershipResponse(project.Ownership)}
}

func (h *projectHandler) create(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	fields, err := decodeObject(w, request, "name", "repoUrl")
	if err != nil {
		writeError(w, request, logger, "project", "create", err)
		return
	}
	name, err := requiredString(fields, "name")
	if err != nil {
		writeError(w, request, logger, "project", "create", err)
		return
	}
	repoURL, err := requiredString(fields, "repoUrl")
	if err != nil {
		writeError(w, request, logger, "project", "create", err)
		return
	}
	input := api.CreateProjectRequest{Name: name, RepoURL: repoURL}
	project, err := h.projects.Create(request.Context(), principal, service.CreateProject{Name: input.Name, RepoURL: input.RepoURL})
	if err != nil {
		writeError(w, request, logger, "project", "create", err)
		return
	}
	logger = logger.With("project_id", project.ID)
	logger.InfoContext(request.Context(), "project created", "type", "resource", "component", "project", "phase", "create", "request_id", RequestID(request.Context()))
	writeCreated(w, request, logger, "/api/v1/projects/"+project.ID, projectResponse(project))
}

func (h *projectHandler) list(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	page, err := pageRequest(request)
	if err != nil {
		writeError(w, request, logger, "project", "list", err)
		return
	}
	result, err := h.projects.List(request.Context(), principal, page)
	if err != nil {
		writeError(w, request, logger, "project", "list", err)
		return
	}
	response := api.ProjectPage{Items: make([]api.Project, 0, len(result.Items)), NextCursor: result.NextCursor}
	for _, project := range result.Items {
		response.Items = append(response.Items, projectResponse(project))
	}
	writeJSON(w, request, logger, http.StatusOK, response)
}

func (h *projectHandler) get(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	id, err := service.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		writeError(w, request, logger, "project", "get", err)
		return
	}
	logger = logger.With("project_id", id)
	project, access, err := h.projects.GetWithAccess(request.Context(), principal, id)
	if err != nil {
		writeError(w, request, logger, "project", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "project read", "type", "resource", "component", "project", "phase", "get", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, api.ProjectDocument{Project: projectResponse(project), Access: projectAccessResponse(access)})
}
