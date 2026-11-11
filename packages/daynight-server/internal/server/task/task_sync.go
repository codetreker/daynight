package task

import (
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

var taskSyncTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`)

func TaskSyncRoutes(mux *http.ServeMux, sync SyncOperation, auth RouteAuthentication, logger *slog.Logger, window time.Duration) {
	handler := &taskHandler{sync: sync, logger: logger, window: window}
	mux.HandleFunc("GET /api/v1/projects/{projectId}/task-sync", auth.Require(handler.taskSync))
	mux.HandleFunc("/api/v1/projects/{projectId}/task-sync", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
}

func taskSyncRequest(request *http.Request) (service.TaskSyncRequest, error) {
	values, err := httpx.QueryValues(request, "epoch", "since")
	if err != nil {
		return service.TaskSyncRequest{}, err
	}
	result := service.TaskSyncRequest{}
	if epoch, exists := values["epoch"]; exists {
		canonical, err := model.CanonicalID(epoch[0])
		if err != nil || canonical != epoch[0] {
			return service.TaskSyncRequest{}, httpx.InvalidInput("epoch must be a canonical UUID")
		}
		result.Epoch = canonical
	}
	if since, exists := values["since"]; exists {
		if result.Epoch == "" {
			return service.TaskSyncRequest{}, httpx.InvalidInput("since requires an epoch")
		}
		if !taskSyncTimestamp.MatchString(since[0]) {
			return service.TaskSyncRequest{}, httpx.InvalidInput("since must be a UTC timestamp with at most nine fractional digits")
		}
		stamp, err := time.Parse(time.RFC3339Nano, since[0])
		if err != nil {
			return service.TaskSyncRequest{}, httpx.InvalidInput("since must be a valid UTC timestamp")
		}
		result.Since = &stamp
	}
	return result, nil
}

func TaskSyncResponse(sync model.TaskSync) api.TaskSync {
	result := api.TaskSync{Mode: sync.Mode, Epoch: sync.Epoch, Project: projecthttp.ProjectResponse(sync.Project), ActorAccess: projecthttp.AccessResponse(sync.ActorAccess), ObservedAt: sync.ObservedAt.UTC(), Tasks: make([]api.TaskViewRecord, 0, len(sync.Tasks)), DependencyStates: make(map[string]api.TaskDependencyState, len(sync.DependencyStates)), AssigneeVersions: make([]api.TaskAssigneeVersion, 0, len(sync.AssigneeVersions))}
	for id, state := range sync.DependencyStates {
		blocked := append([]string{}, state.BlockedBy...)
		result.DependencyStates[id] = api.TaskDependencyState{TaskVersion: strconv.FormatInt(state.TaskVersion, 10), BlockedBy: blocked, Ready: state.Ready}
	}
	if sync.Sessions != nil {
		result.Sessions = make(map[string]string, len(sync.Sessions))
		for taskID, state := range sync.Sessions {
			result.Sessions[taskID] = string(state)
		}
	}
	for _, person := range sync.AssigneeVersions {
		result.AssigneeVersions = append(result.AssigneeVersions, api.TaskAssigneeVersion{UserID: person.UserID, Version: person.Version, HasProjectAccess: person.HasProjectAccess})
	}
	for _, task := range sync.Tasks {
		result.Tasks = append(result.Tasks, taskprotocol.RESTSyncRecord(task))
	}
	return result
}

func (h *taskHandler) taskSync(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	start := time.Now()
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_sync", "get", err)
		return
	}
	input, err := taskSyncRequest(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_sync", "get", err)
		return
	}
	logger = logger.With("since", input.Since, "window", h.window)
	result, err := h.sync(request.Context(), principal, projectID, input)
	if err != nil {

		httpx.WriteError(w, request, logger, "task_sync", "get", err)
		return
	}
	response := TaskSyncResponse(result)
	logger.InfoContext(request.Context(), "task sync read", "type", "resource", "component", "task_sync", "phase", "get",
		"request_id", httpx.RequestID(request.Context()), "duration", time.Since(start), "mode", result.Mode, "returned_tasks", len(result.Tasks))
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}
