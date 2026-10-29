package server

import (
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func taskGraphResponse(graph core.TaskGraph) api.TaskGraph {
	response := api.TaskGraph{
		Project:    projectResponse(graph.Project),
		ObservedAt: graph.ObservedAt.UTC(),
		Summary: api.TaskGraphSummary{
			Total: graph.Summary.Total, Todo: graph.Summary.Todo, InProgress: graph.Summary.InProgress,
			Done: graph.Summary.Done, Ready: graph.Summary.Ready, Blocked: graph.Summary.Blocked,
		},
		Tasks: make([]api.GraphTask, 0, len(graph.Tasks)),
	}
	for _, task := range graph.Tasks {
		response.Tasks = append(response.Tasks, api.GraphTask{
			ID: task.ID, TitlePreview: task.TitlePreview, TitleTruncated: task.TitleTruncated, Status: string(task.Status),
			DependsOn: append([]string{}, task.DependsOn...), ExternalDependsOn: append([]string{}, task.ExternalDependsOn...), BlockedBy: append([]string{}, task.BlockedBy...), Ready: task.Ready, AllowAgents: task.AllowAgents, RequiredPlatform: platformResponse(task.RequiredPlatform),
			CreatedAt: task.CreatedAt.UTC(), UpdatedAt: task.UpdatedAt.UTC(),
			StartedAt: timestampResponse(task.StartedAt), CompletedAt: timestampResponse(task.CompletedAt),
		})
	}
	return response
}

func (h *taskHandler) graph(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	start := time.Now()
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task_graph", "get", err)
		return
	}
	values, err := queryValues(request, "taskId")
	if err != nil {
		writeError(w, request, logger, "task_graph", "get", err)
		return
	}
	taskID := values.Get("taskId")
	if taskID == "" {
		writeError(w, request, logger, "task_graph", "get", invalidInput("task graph requires taskId"))
		return
	}
	graph, err := h.tasks.Graph(request.Context(), principal, projectID, taskID)
	if err != nil {
		if fault, ok := knownFault(err); ok && ErrorKind(err) == fault.Code && fault.GraphLimit != nil {
			logger = logger.With("node_count", fault.GraphLimit.NodeCount, "edge_count", fault.GraphLimit.EdgeCount)
		}
		writeError(w, request, logger, "task_graph", "get", err)
		return
	}
	edgeCount := 0
	for _, task := range graph.Tasks {
		edgeCount += len(task.DependsOn)
	}
	logger.InfoContext(request.Context(), "task graph read", "type", "resource", "component", "task_graph", "phase", "get",
		"request_id", RequestID(request.Context()), "duration", time.Since(start), "node_count", len(graph.Tasks), "edge_count", edgeCount)
	writeJSON(w, request, logger, http.StatusOK, taskGraphResponse(graph))
}
