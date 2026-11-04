package server

import (
	"net/http"
	"net/url"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func taskAssigneesRequest(request *http.Request) (service.TaskAssigneesRequest, error) {
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return service.TaskAssigneesRequest{}, invalidInput("query parameters must be valid URL encoding")
	}
	for key := range values {
		if key != "userId" {
			return service.TaskAssigneesRequest{}, invalidInput("query contains an unknown parameter")
		}
	}
	userIDs, exists := values["userId"]
	if !exists {
		return service.TaskAssigneesRequest{}, nil
	}
	if len(userIDs) > service.MaxTaskAssigneeResolution {
		return service.TaskAssigneesRequest{}, invalidInput("userId may occur at most 100 times")
	}
	for _, userID := range userIDs {
		if userID == "" {
			return service.TaskAssigneesRequest{}, invalidInput("userId must not be empty")
		}
	}
	return service.TaskAssigneesRequest{UserIDs: userIDs}, nil
}

func taskAssigneesResponse(result core.TaskAssignees) api.TaskAssignees {
	response := api.TaskAssignees{Items: make([]api.TaskAssignee, 0, len(result.Items)), UnresolvedUserIDs: append([]string{}, result.UnresolvedUserIDs...)}
	for _, person := range result.Items {
		response.Items = append(response.Items, api.TaskAssignee{UserID: person.UserID, Version: person.Version, Name: person.Name, AvatarURL: person.AvatarURL, HasProjectAccess: person.HasProjectAccess})
	}
	return response
}

func (h *taskHandler) assignees(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	start := time.Now()
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task_assignee", "parse", err)
		return
	}
	input, err := taskAssigneesRequest(request)
	if err != nil {
		writeError(w, request, logger, "task_assignee", "parse", err)
		return
	}
	phase := "catalogue"
	if input.UserIDs != nil {
		phase = "resolve"
	}
	result, err := h.tasks.Assignees(request.Context(), principal, projectID, input)
	if err != nil {
		writeError(w, request, logger, "task_assignee", phase, err)
		return
	}
	logger.InfoContext(request.Context(), "task assignees read", "type", "resource", "component", "task_assignee", "phase", phase,
		"request_id", RequestID(request.Context()), "duration", time.Since(start), "requested_users", len(input.UserIDs), "returned_users", len(result.Items), "unresolved_users", len(result.UnresolvedUserIDs))
	writeJSON(w, request, logger, http.StatusOK, taskAssigneesResponse(result))
}
