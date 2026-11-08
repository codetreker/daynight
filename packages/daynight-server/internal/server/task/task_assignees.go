package task

import (
	"net/http"
	"net/url"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projection "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func taskAssigneesRequest(request *http.Request) (service.TaskAssigneesRequest, error) {
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return service.TaskAssigneesRequest{}, httpx.InvalidInput("query parameters must be valid URL encoding")
	}
	for key := range values {
		if key != "userId" {
			return service.TaskAssigneesRequest{}, httpx.InvalidInput("query contains an unknown parameter")
		}
	}
	userIDs, exists := values["userId"]
	if !exists {
		return service.TaskAssigneesRequest{}, nil
	}
	if len(userIDs) > projection.MaxAssigneeResolution {
		return service.TaskAssigneesRequest{}, httpx.InvalidInput("userId may occur at most 100 times")
	}
	for _, userID := range userIDs {
		if userID == "" {
			return service.TaskAssigneesRequest{}, httpx.InvalidInput("userId must not be empty")
		}
	}
	return service.TaskAssigneesRequest{UserIDs: userIDs}, nil
}

func taskAssigneesResponse(result model.TaskAssignees) api.TaskAssignees {
	response := api.TaskAssignees{Items: make([]api.TaskAssignee, 0, len(result.Items)), UnresolvedUserIDs: append([]string{}, result.UnresolvedUserIDs...)}
	for _, person := range result.Items {
		response.Items = append(response.Items, api.TaskAssignee{UserID: person.UserID, Version: person.Version, Name: person.Name, AvatarURL: person.AvatarURL, HasProjectAccess: person.HasProjectAccess})
	}
	return response
}

func (h *taskHandler) assignees(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	start := time.Now()
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_assignee", "parse", err)
		return
	}
	input, err := taskAssigneesRequest(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_assignee", "parse", err)
		return
	}
	phase := "catalogue"
	if input.UserIDs != nil {
		phase = "resolve"
	}
	result, err := h.tasks.Assignees(request.Context(), principal, projectID, input)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_assignee", phase, err)
		return
	}
	logger.InfoContext(request.Context(), "task assignees read", "type", "resource", "component", "task_assignee", "phase", phase,
		"request_id", httpx.RequestID(request.Context()), "duration", time.Since(start), "requested_users", len(input.UserIDs), "returned_users", len(result.Items), "unresolved_users", len(result.UnresolvedUserIDs))
	httpx.WriteJSON(w, request, logger, http.StatusOK, taskAssigneesResponse(result))
}
