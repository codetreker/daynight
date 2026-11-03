package server

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func taskAssignmentFilterQuery(selector string) string {
	return "?limit=1&status=todo&ready=true&allowAgents=true&compatiblePlatform=linux&assignedTo=" + url.QueryEscape(selector)
}

func collectAssignmentHTTPPages(t *testing.T, handler *resourceTestHandler, collection, query string, expected *string) ([]string, *string) {
	t.Helper()
	var ids []string
	var firstCursor *string
	cursor := ""
	for {
		path := collection + query
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		response := projectRequest(handler, http.MethodGet, path, "")
		page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
		if len(page.Items) > 1 {
			t.Fatalf("task page exceeded requested limit: %#v", page)
		}
		for _, task := range page.Items {
			if expected == nil && task.AssignedTo != nil || expected != nil && (task.AssignedTo == nil || *task.AssignedTo != *expected) {
				t.Fatalf("task did not match assignedTo filter: %#v", task)
			}
			ids = append(ids, task.ID)
		}
		if page.NextCursor == nil {
			break
		}
		if firstCursor == nil {
			value := *page.NextCursor
			firstCursor = &value
		}
		cursor = *page.NextCursor
	}
	return ids, firstCursor
}

func TestTaskHTTPAssignedToFilteringPrecedesLimitAndBindsCursor(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	other := assignmentHTTPMember(t, database, project.ID)
	otherHandler := assigneeHTTPIdentity(t, database, handler, other)
	var matching []string
	var unassigned []string
	for _, seed := range []struct {
		target   *string
		allowed  bool
		platform any
		state    string
	}{
		{nil, true, "linux", "todo"},
		{assignmentHTTPPointer(other), true, "linux", "todo"},
		{assignmentHTTPPointer(handler.principal.UserID), true, "windows", "todo"},
		{assignmentHTTPPointer(handler.principal.UserID), true, "linux", "todo"},
		{assignmentHTTPPointer(handler.principal.UserID), true, nil, "todo"},
		{assignmentHTTPPointer(handler.principal.UserID), false, "linux", "todo"},
		{assignmentHTTPPointer(handler.principal.UserID), true, "linux", "in_progress"},
		{assignmentHTTPPointer(handler.principal.UserID), true, "linux", "done"},
	} {
		task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Assignment filter candidate", "assignedTo": seed.target, "requiredPlatform": seed.platform})), http.StatusCreated)
		task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": seed.allowed})
		if seed.state != "todo" {
			task = setHTTPTask(t, handler, task, seed.state)
		}
		if seed.target == nil {
			unassigned = append(unassigned, task.ID)
		}
		if seed.target != nil && *seed.target == handler.principal.UserID && seed.allowed && (seed.platform == nil || seed.platform == "linux") && seed.state == "todo" {
			matching = append(matching, task.ID)
		}
	}
	foreignProject := taskProject(t, handler)
	foreign := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(foreignProject.ID), jsonBody(t, map[string]any{"title": "Foreign matching candidate", "assignedTo": handler.principal.UserID})), http.StatusCreated)
	updateHTTPTask(t, handler, foreign, map[string]any{"allowAgents": true})
	collection := taskCollection(project.ID)
	query := taskAssignmentFilterQuery("me")
	ids, cursor := collectAssignmentHTTPPages(t, handler, collection, query, assignmentHTTPPointer(handler.principal.UserID))
	if !slices.Equal(ids, matching) || cursor == nil {
		t.Fatalf("assignment filtered after bounded page: got %v want %v cursor %v", ids, matching, cursor)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(*cursor)
	if err != nil {
		t.Fatal(err)
	}
	var cursorFields map[string]any
	if err := json.Unmarshal(decoded, &cursorFields); err != nil || cursorFields["version"] != float64(2) {
		t.Fatalf("task cursor was not upgraded: %s %v", decoded, err)
	}
	for _, selector := range []string{"unassigned", other} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, collection+taskAssignmentFilterQuery(selector)+"&cursor="+url.QueryEscape(*cursor), ""), http.StatusBadRequest, "invalid_input")
	}
	withoutAssignment := "?limit=1&status=todo&ready=true&allowAgents=true&compatiblePlatform=linux&cursor=" + url.QueryEscape(*cursor)
	assertProjectError(t, projectRequest(handler, http.MethodGet, collection+withoutAssignment, ""), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, projectRequest(otherHandler, http.MethodGet, collection+query+"&cursor="+url.QueryEscape(*cursor), ""), http.StatusBadRequest, "invalid_input")
	sameScope := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, collection+taskAssignmentFilterQuery(strings.ToUpper(handler.principal.UserID))+"&cursor="+url.QueryEscape(*cursor), ""), http.StatusOK)
	if len(sameScope.Items) != 1 || sameScope.Items[0].ID != matching[1] {
		t.Fatalf("me and explicit canonical identity have different scope: %#v", sameScope)
	}
	cursorFields["version"] = float64(1)
	old, err := json.Marshal(cursorFields)
	if err != nil {
		t.Fatal(err)
	}
	oldCursor := base64.RawURLEncoding.EncodeToString(old)
	assertProjectError(t, projectRequest(handler, http.MethodGet, collection+query+"&cursor="+url.QueryEscape(oldCursor), ""), http.StatusBadRequest, "invalid_input")
	unassignedIDs, _ := collectAssignmentHTTPPages(t, handler, collection, taskAssignmentFilterQuery("unassigned"), nil)
	if !slices.Equal(unassignedIDs, unassigned) {
		t.Fatalf("unassigned filter: got %v want %v", unassignedIDs, unassigned)
	}
}

func TestTaskHTTPAssignedToStrictFiltersAndFormerTarget(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	former := assignmentHTTPMember(t, database, project.ID)
	task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Former assignment query", "assignedTo": former})), http.StatusCreated)
	if _, err := database.Pool.Exec(t.Context(), `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, former); err != nil {
		t.Fatal(err)
	}
	collection := taskCollection(project.ID)
	for _, query := range []string{
		"assignedTo=", "assignedTo=null", "assignedTo=all", "assignedTo=invalid", "assignedTo=Me", "assignedTo=Unassigned", "assignedTo=true", "assignedTo=%xx", "assignedTo=%ff", "assignedTo=%00", "assignedTo=me&assignedTo=me", "assignedTo=me&assignedTo=unassigned", "AssignedTo=me", "assignedTo[]=me", "assignedTo=%20" + former, "assignedTo=" + former + "%20",
	} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	response := projectRequest(handler, http.MethodGet, collection+"?assignedTo="+strings.ToUpper(former), "")
	page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != task.ID || page.Items[0].AssignedTo == nil || *page.Items[0].AssignedTo != former {
		t.Fatalf("former target filter was qualified as a new assignment: %#v", page)
	}
	if response.Header().Get("Daynight-User-ID") != handler.principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("filter response lost admitted identity or no-store")
	}
	unknown := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, collection+"?assignedTo="+uuid.NewString(), ""), http.StatusOK)
	if unknown.Items == nil || len(unknown.Items) != 0 || unknown.NextCursor != nil {
		t.Fatalf("unknown valid filter is not an empty page: %#v", unknown)
	}
	all := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, collection, ""), http.StatusOK)
	if len(all.Items) != 1 || all.Items[0].ID != task.ID {
		t.Fatal("omitted assignment selector changed default list scope")
	}
}
