package server

import (
	"io"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPPlatformStrictInputsAndNullableResources(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	response := projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Unrestricted default"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	if task.RequiredPlatform != nil || !strings.Contains(response.Body.String(), `"requiredPlatform":null`) {
		t.Fatalf("missing mandatory nullable requirement: %s", response.Body)
	}
	for _, value := range []string{`""`, `"darwin"`, `"Linux"`, `"linux "`, `true`, `0`, `[]`, `{}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Invalid platform","requiredPlatform":`+value+`}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"requiredPlatform":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{"title":"Duplicate","requiredPlatform":null,"requiredPlatform":"linux"}`, `{"title":"Wrong case","RequiredPlatform":"linux"}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"requiredPlatform":"linux","requiredPlatform":null}`), http.StatusBadRequest, "invalid_input")
	if got := readHTTPTask(t, handler, task); !reflect.DeepEqual(got, task) {
		t.Fatal("invalid inputs changed task")
	}
	if got := updateHTTPTask(t, handler, task, map[string]any{"requiredPlatform": nil}); !reflect.DeepEqual(got, task) {
		t.Fatal("same null changed resource")
	}
	for _, platform := range []any{nil, "windows", "linux", "macos"} {
		created := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Explicit platform", "requiredPlatform": platform})), http.StatusCreated)
		if platform == nil && created.RequiredPlatform != nil || platform != nil && (created.RequiredPlatform == nil || *created.RequiredPlatform != platform) {
			t.Fatal("creation lost platform")
		}
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"requiredPlatform": "windows", "allowAgents": true})
	if task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" || !task.AllowAgents {
		t.Fatal("setting platform lost permission")
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"description": "Omitted requirement"})
	if task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" {
		t.Fatal("omitted platform cleared requirement")
	}
	task = setHTTPTask(t, handler, task, "in_progress")
	if task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" {
		t.Fatal("manual start discarded requirement")
	}
	if got := updateHTTPTask(t, handler, task, map[string]any{"requiredPlatform": "windows"}); !reflect.DeepEqual(got, task) {
		t.Fatal("active same-value update changed resource")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version - 1, "requiredPlatform": "windows"})), http.StatusConflict, "version_conflict")
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "requiredPlatform": nil, "description": "Must not save"})), http.StatusConflict, "invalid_transition")
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("locked platform partly saved metadata")
	}
	for _, path := range []string{taskPath(task), taskCollection(project.ID), graphPath(project.ID, task.ID)} {
		read := projectRequest(handler, http.MethodGet, path, "")
		if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `"requiredPlatform":"windows"`) {
			t.Fatalf("resource lost platform: %s %s", path, read.Body)
		}
	}
	task = setHTTPTask(t, handler, task, "done")
	cleared := updateHTTPTask(t, handler, task, map[string]any{"requiredPlatform": nil})
	if cleared.RequiredPlatform != nil || !cleared.AllowAgents || !reflect.DeepEqual(cleared.StartedAt, task.StartedAt) || !reflect.DeepEqual(cleared.CompletedAt, task.CompletedAt) {
		t.Fatal("clearing platform changed history")
	}
}

func TestTaskHTTPPlatformFilteringAndCursorScopes(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	var want []string
	for _, platform := range []any{"windows", "macos", "linux", nil, "linux"} {
		task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Platform candidate", "requiredPlatform": platform})), http.StatusCreated)
		task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
		if platform == nil || platform == "linux" {
			want = append(want, task.ID)
		}
	}
	collection := taskCollection(project.ID)
	query := "?limit=1&ready=true&allowAgents=true&compatiblePlatform=linux"
	cursor := ""
	var ids []string
	for {
		suffix := query
		if cursor != "" {
			suffix += "&cursor=" + url.QueryEscape(cursor)
		}
		page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, collection+suffix, ""), http.StatusOK)
		for _, task := range page.Items {
			ids = append(ids, task.ID)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
		for _, platform := range []string{"", "windows", "macos"} {
			changed := "?limit=1&ready=true&allowAgents=true&cursor=" + url.QueryEscape(cursor)
			if platform != "" {
				changed += "&compatiblePlatform=" + platform
			}
			assertProjectError(t, projectRequest(handler, http.MethodGet, collection+changed, ""), http.StatusBadRequest, "invalid_input")
		}
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("bounded query hid compatible candidates: got %v want %v", ids, want)
	}
	for _, query := range []string{"compatiblePlatform=", "compatiblePlatform=null", "compatiblePlatform=darwin", "compatiblePlatform=Linux", "compatiblePlatform=true", "compatiblePlatform=linux&compatiblePlatform=macos", "CompatiblePlatform=linux"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}

func TestTaskHTTPStatusPreservesRequiredPlatformForEveryPair(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	for _, platform := range []any{nil, "windows", "linux", "macos"} {
		for _, from := range []string{"todo", "in_progress", "done"} {
			for _, to := range []string{"todo", "in_progress", "done"} {
				task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Status keeps platform", "requiredPlatform": platform})), http.StatusCreated)
				task = setHTTPTask(t, handler, task, from)
				after := setHTTPTask(t, handler, task, to)
				delta := int64(1)
				if from == to {
					delta = 0
				}
				if !reflect.DeepEqual(after.RequiredPlatform, task.RequiredPlatform) || after.Version != task.Version+delta {
					t.Fatalf("status %s to %s changed platform %v: before %+v, after %+v", from, to, platform, task, after)
				}
				if delta == 0 && !reflect.DeepEqual(after, task) {
					t.Fatal("same status changed platform or other persisted data")
				}
			}
		}
	}
}
