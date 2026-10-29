package server

import (
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

var taskSyncTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`)

func taskSyncRoutes(mux *http.ServeMux, sync *service.TaskSync, auth *Authentication, logger *slog.Logger, window time.Duration) {
	handler := &taskHandler{sync: sync, logger: logger, window: window}
	mux.HandleFunc("GET /api/v1/projects/{projectId}/task-sync", auth.Require(handler.taskSync))
	mux.HandleFunc("/api/v1/projects/{projectId}/task-sync", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
}

func taskSyncRequest(request *http.Request) (service.TaskSyncRequest, error) {
	values, err := queryValues(request, "epoch", "since")
	if err != nil {
		return service.TaskSyncRequest{}, err
	}
	result := service.TaskSyncRequest{}
	if epoch, exists := values["epoch"]; exists {
		canonical, err := service.CanonicalID(epoch[0])
		if err != nil || canonical != epoch[0] {
			return service.TaskSyncRequest{}, invalidInput("epoch must be a canonical UUID")
		}
		result.Epoch = canonical
	}
	if since, exists := values["since"]; exists {
		if result.Epoch == "" {
			return service.TaskSyncRequest{}, invalidInput("since requires an epoch")
		}
		if !taskSyncTimestamp.MatchString(since[0]) {
			return service.TaskSyncRequest{}, invalidInput("since must be a UTC timestamp with at most nine fractional digits")
		}
		stamp, err := time.Parse(time.RFC3339Nano, since[0])
		if err != nil {
			return service.TaskSyncRequest{}, invalidInput("since must be a valid UTC timestamp")
		}
		result.Since = &stamp
	}
	return result, nil
}

func taskSyncResponse(sync core.TaskSync) api.TaskSync {
	result := api.TaskSync{Mode: sync.Mode, Epoch: sync.Epoch, Project: projectResponse(sync.Project), ObservedAt: sync.ObservedAt.UTC(), Tasks: make([]api.TaskViewRecord, 0, len(sync.Tasks))}
	for _, task := range sync.Tasks {
		result.Tasks = append(result.Tasks, api.TaskViewRecord{
			ID: task.ID, TitlePreview: task.TitlePreview, TitleTruncated: task.TitleTruncated, Status: string(task.Status), Version: strconv.FormatInt(task.Version, 10),
			DependsOn: append([]string{}, task.DependsOn...), ExternalDependsOn: append([]string{}, task.ExternalDependsOn...), AllowAgents: task.AllowAgents, WorkerNeedsAttention: task.WorkerNeedsAttention, RequiredPlatform: platformResponse(task.RequiredPlatform),
			CreatedAt: task.CreatedAt.UTC(), UpdatedAt: task.UpdatedAt.UTC(), StartedAt: timestampResponse(task.StartedAt), CompletedAt: timestampResponse(task.CompletedAt),
		})
	}
	return result
}

func (h *taskHandler) taskSync(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	start := time.Now()
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task_sync", "get", err)
		return
	}
	input, err := taskSyncRequest(request)
	if err != nil {
		writeError(w, request, logger, "task_sync", "get", err)
		return
	}
	logger = logger.With("since", input.Since, "window", h.window)
	result, err := h.sync.Get(request.Context(), principal, projectID, input)
	if err != nil {
		if fault, ok := knownFault(err); ok && ErrorKind(err) == fault.Code && fault.GraphLimit != nil {
			logger = logger.With("node_count", fault.GraphLimit.NodeCount, "edge_count", fault.GraphLimit.EdgeCount)
		}
		writeError(w, request, logger, "task_sync", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "task sync read", "type", "resource", "component", "task_sync", "phase", "get",
		"request_id", RequestID(request.Context()), "duration", time.Since(start), "mode", result.Mode, "returned_tasks", len(result.Tasks))
	writeJSON(w, request, logger, http.StatusOK, taskSyncResponse(result))
}
