package server

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPAgentPermissionResourcesAndStrictInputs(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	response := projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Manual by default"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	if task.AllowAgents || !strings.Contains(response.Body.String(), `"allowAgents":false`) {
		t.Fatalf("missing required false permission: %s", response.Body)
	}
	for _, value := range []string{"true", "false", "null"} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Cannot opt in during creation","allowAgents":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	for _, value := range []string{"null", `"true"`, `0`, `[]`, `{}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"allowAgents":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"allowAgents":true,"allowAgents":false}`), http.StatusBadRequest, "invalid_input")
	if got := readHTTPTask(t, handler, task); !reflect.DeepEqual(got, task) {
		t.Fatal("invalid permission inputs changed task")
	}
	same := updateHTTPTask(t, handler, task, map[string]any{"allowAgents": false})
	if !reflect.DeepEqual(same, task) {
		t.Fatal("false same-value PATCH changed task")
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	if !task.AllowAgents || task.Status != "todo" || !task.Ready {
		t.Fatalf("permission changed task status: %#v", task)
	}
	task = setHTTPTask(t, handler, task, "in_progress")
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "allowAgents": false, "description": "Must not save"})), http.StatusConflict, "invalid_transition")
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("locked toggle partially saved metadata")
	}
	task = setHTTPTask(t, handler, task, "done")
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": false})
	for _, path := range []string{taskPath(task), taskCollection(project.ID), graphPath(project.ID, task.ID)} {
		read := projectRequest(handler, http.MethodGet, path, "")
		if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `"allowAgents":false`) {
			t.Fatalf("resource omitted permission: %s %s", path, read.Body)
		}
	}
}

func TestTaskHTTPAgentPermissionFilteringAndCursorScopes(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	var permitted, manual []string
	for index := range 5 {
		task := createHTTPTask(t, handler, project.ID, "Permission filter")
		if index >= 2 {
			task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
			permitted = append(permitted, task.ID)
		} else {
			manual = append(manual, task.ID)
		}
	}
	collection := taskCollection(project.ID)
	for _, allowed := range []bool{false, true} {
		query := fmt.Sprintf("?ready=true&allowAgents=%t&limit=1", allowed)
		cursor := ""
		var ids []string
		for {
			suffix := query
			if cursor != "" {
				suffix += "&cursor=" + url.QueryEscape(cursor)
			}
			response := projectRequest(handler, http.MethodGet, collection+suffix, "")
			page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
			for _, task := range page.Items {
				if task.AllowAgents != allowed || !task.Ready {
					t.Fatalf("permission page mismatch: %#v", task)
				}
				ids = append(ids, task.ID)
			}
			if page.NextCursor == nil {
				break
			}
			cursor = *page.NextCursor
			assertProjectError(t, projectRequest(handler, http.MethodGet, collection+"?limit=1&ready=true&cursor="+url.QueryEscape(cursor), ""), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(handler, http.MethodGet, fmt.Sprintf("%s?limit=1&ready=true&allowAgents=%t&cursor=%s", collection, !allowed, url.QueryEscape(cursor)), ""), http.StatusBadRequest, "invalid_input")
		}
		want := manual
		if allowed {
			want = permitted
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("filter after limit hid candidates: got %v want %v", ids, want)
		}
	}
	for _, query := range []string{"allowAgents=", "allowAgents=True", "allowAgents=1", "allowAgents=null", "allowAgents=true&allowAgents=false", "AllowAgents=true"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}
