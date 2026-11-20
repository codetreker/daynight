package task

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}

type taskOnlyProject struct {
	ID string `json:"id"`
}

type taskOnlyReader struct{ *service.Tasks }

func (s taskOnlyReader) Graph(ctx context.Context, p model.Principal, project, task string) (model.TaskGraph, error) {
	return s.GraphTaskOnly(ctx, p, project, task)
}

type taskOnlyObservations struct{ *service.Observations }

func (s taskOnlyObservations) ObserveGraph(ctx context.Context, p model.Principal, project, task string) (service.ObservedGraph, error) {
	return s.ObserveGraphTaskOnly(ctx, p, project, task)
}

// ScopedReadRoutes registers Task query handlers with request-local policy
// snapshots. Mutation and execution routes retain their independent admission.
func ScopedReadRoutes(mux httpx.RouteRegistrar, tasks *service.Tasks, observations *service.Observations, sync *service.TaskSync, auth ScopedAuthentication, logger *slog.Logger, window time.Duration) error {
	if mux == nil || tasks == nil || observations == nil || sync == nil || auth == nil || logger == nil {
		return errors.New("scoped Task read routes require all dependencies")
	}
	bind := func(next func(*taskHandler, http.ResponseWriter, *http.Request, model.Principal)) http.HandlerFunc {
		return auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
			if err := a.Validate(); err != nil {
				httpx.WriteError(w, r, logger, "task", "authentication", model.Unauthenticated(err))
				return
			}
			t := service.NewScopedTasks(tasks, a)
			o := service.NewScopedObservations(observations, a)
			h := &taskHandler{tasks: t, observations: o, sync: service.NewScopedTaskSync(sync, a).Get, logger: logger, window: window}
			if r.URL.Path == "/api/v1/task-properties/schema" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
				if err := scopeadmission.Require(a, scopepolicy.TaskRead); err != nil {
					httpx.WriteError(w, r, logger, "task_property", "schema", err)
					return
				}
			}
			if r.PathValue("projectId") != "" && r.URL.Path == "/api/v1/projects/"+r.PathValue("projectId")+"/task-graph" && r.Header.Get("Daynight-Projection") == "task-only-v1" {
				h.taskOnly = true
				h.tasks = taskOnlyReader{t}
				h.observations = taskOnlyObservations{o}
			}
			next(h, w, r, a.Principal)
		})
	}
	for _, route := range []struct {
		path string
		run  func(*taskHandler, http.ResponseWriter, *http.Request, model.Principal)
	}{
		{"/api/v1/projects/{projectId}/tasks", (*taskHandler).list},
		{"/api/v1/projects/{projectId}/tasks/{taskId}", (*taskHandler).get},
		{"/api/v1/projects/{projectId}/task-work", (*taskHandler).work},
		{"/api/v1/projects/{projectId}/task-graph", (*taskHandler).graph},
		{"/api/v1/projects/{projectId}/task-sync", (*taskHandler).taskSync},
		{"/api/v1/projects/{projectId}/tasks/{taskId}/properties", (*taskHandler).getProperties},
		{"/api/v1/task-properties/schema", (*taskHandler).propertySchema},
	} {
		mux.HandleFunc("GET "+route.path, bind(route.run))
		mux.HandleFunc(route.path, bind(func(_ *taskHandler, w http.ResponseWriter, r *http.Request, p model.Principal) {
			if route.path == "/api/v1/projects/{projectId}/tasks/{taskId}" && r.PathValue("taskId") == "search" {
				httpx.ResourceMethodNotAllowed(logger, "POST")(w, r, p)
				return
			}
			httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")(w, r, p)
		}))
	}
	const goalPath = "/api/v1/projects/{projectId}/tasks/{taskId}/goal-dependencies"
	mux.HandleFunc("GET "+goalPath, bind(func(h *taskHandler, w http.ResponseWriter, r *http.Request, p model.Principal) {
		(&goalDependencyHandler{service: h.tasks.(*service.Tasks), logger: logger}).show(w, r, p)
	}))
	mux.HandleFunc(goalPath, bind(func(_ *taskHandler, w http.ResponseWriter, r *http.Request, p model.Principal) {
		httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")(w, r, p)
	}))
	return nil
}

type ScopedSearchOperation func(context.Context, model.CredentialAuthorization, string, tasksearch.Request) (tasksearch.Page, error)

func ScopedTaskSearchRoutes(mux httpx.RouteRegistrar, search ScopedSearchOperation, auth ScopedAuthentication, logger *slog.Logger) error {
	if mux == nil || search == nil || auth == nil || logger == nil {
		return errors.New("scoped Task search routes require all dependencies")
	}
	bind := func(next func(*searchHandler, http.ResponseWriter, *http.Request, model.Principal)) http.HandlerFunc {
		return auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
			if err := a.Validate(); err != nil {
				httpx.WriteError(w, r, logger, "task_search", "authentication", model.Unauthenticated(err))
				return
			}
			h := &searchHandler{logger: logger, operationTimeout: 5 * time.Second, run: func(ctx context.Context, p model.Principal, project string, input tasksearch.Request) (tasksearch.Page, error) {
				return search(ctx, a, project, input)
			}}
			next(h, w, r, a.Principal)
		})
	}
	const path = "/api/v1/projects/{projectId}/tasks/search"
	mux.HandleFunc("POST "+path, bind((*searchHandler).search))
	for _, method := range []string{"GET", "PATCH", "DELETE"} {
		mux.HandleFunc(method+" "+path, bind(func(_ *searchHandler, w http.ResponseWriter, r *http.Request, p model.Principal) {
			httpx.ResourceMethodNotAllowed(logger, "POST")(w, r, p)
		}))
	}
	return nil
}
