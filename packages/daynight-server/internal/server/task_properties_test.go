package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPPropertiesRoundTripAndMutationSemantics(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	for _, body := range []string{`{"title":"Default"}`, `{"title":"Default","properties":{}}`, `{"title":"Default","properties":{"pullRequests":[]}}`} {
		task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), body), http.StatusCreated)
		if task.Properties.PullRequests == nil || len(task.Properties.PullRequests) != 0 {
			t.Fatalf("default properties are not an initialized empty list: %+v", task.Properties)
		}
	}
	body := `{"title":"References","properties":{"pullRequests":[{"url":"","title":""},{"url":"  acceptance-secret arbitrary\u0000\n地址  ","title":"\t标题\u0000"},{"title":"\t标题\u0000","url":"  acceptance-secret arbitrary\u0000\n地址  "},{"url":"https://EXAMPLE.com/a","title":"\ud800"}]}}`
	task := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), body), http.StatusCreated)
	want := []api.PullRequestProperty{{URL: "", Title: ""}, {URL: "  acceptance-secret arbitrary\x00\n地址  ", Title: "\t标题\x00"}, {URL: "  acceptance-secret arbitrary\x00\n地址  ", Title: "\t标题\x00"}, {URL: "https://EXAMPLE.com/a", Title: "\ufffd"}}
	if !slices.Equal(task.Properties.PullRequests, want) || task.Version != 1 {
		t.Fatalf("decoded string/order/duplicate semantics changed: %+v", task)
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("properties changed on persisted read")
	}
	var stored string
	if err := database.Pool.QueryRow(context.Background(), "SELECT properties FROM tasks WHERE id=$1", task.ID).Scan(&stored); err != nil || strings.ContainsRune(stored, 0) || !strings.Contains(stored, `\u0000`) {
		t.Fatalf("NUL was not persisted as escaped JSON text: %q, %v", stored, err)
	}
	noop := updateHTTPTask(t, handler, task, map[string]any{"properties": api.TaskWritableProperties{PullRequests: want}})
	if !reflect.DeepEqual(noop, task) {
		t.Fatal("equal properties changed task metadata")
	}
	preserved := updateHTTPTask(t, handler, task, map[string]any{"title": "Renamed", "properties": map[string]any{}})
	if !slices.Equal(preserved.Properties.PullRequests, want) || preserved.Version != task.Version+1 {
		t.Fatal("empty property patch failed to preserve values alongside title")
	}
	omitted := updateHTTPTask(t, handler, preserved, map[string]any{"description": "Old client update"})
	if !slices.Equal(omitted.Properties.PullRequests, want) {
		t.Fatal("omitted properties did not preserve existing references")
	}
	reordered := slices.Clone(want)
	slices.Reverse(reordered)
	changed := updateHTTPTask(t, handler, omitted, map[string]any{"properties": api.TaskWritableProperties{PullRequests: reordered}})
	if changed.Version != omitted.Version+1 || !slices.Equal(changed.Properties.PullRequests, reordered) || !changed.UpdatedAt.After(omitted.UpdatedAt) {
		t.Fatal("array order was not part of change detection")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(changed), jsonBody(t, map[string]any{"version": omitted.Version, "properties": api.TaskWritableProperties{PullRequests: changed.Properties.PullRequests}})), http.StatusConflict, "version_conflict")
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"?limit=100", ""), http.StatusOK)
	if !slices.ContainsFunc(page.Items, func(item api.Task) bool { return reflect.DeepEqual(item, changed) }) {
		t.Fatal("full properties missing from paginated task resources")
	}
	graph := projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph", "")
	if graph.Code != http.StatusOK || strings.Contains(graph.Body.String(), "pullRequests") || strings.Contains(graph.Body.String(), "properties") || strings.Contains(graph.Body.String(), "acceptance-secret") {
		t.Fatalf("graph projection selected properties: %s", graph.Body)
	}
	cleared := updateHTTPTask(t, handler, changed, map[string]any{"properties": api.TaskWritableProperties{PullRequests: []api.PullRequestProperty{}}})
	if cleared.Properties.PullRequests == nil || len(cleared.Properties.PullRequests) != 0 || cleared.Version != changed.Version+1 {
		t.Fatal("empty list did not clear references")
	}
	if strings.Contains(logs.String(), "acceptance-secret") || strings.Contains(logs.String(), "标题") {
		t.Fatalf("property contents leaked to logs: %s", &logs)
	}
}

func TestTaskHTTPPropertiesRejectInvalidStructure(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Original")
	for _, properties := range []string{
		`null`, `[]`, `"text"`, `true`, `1`, `{"unknown":[]}`, `{"pullRequests":[],"pullRequests":[]}`, `{"pullRequests":[],"pull\u0052equests":[]}`,
		`{"pullRequests":null}`, `{"pullRequests":{}}`, `{"pullRequests":"text"}`, `{"pullRequests":true}`,
		`{"pullRequests":[null]}`, `{"pullRequests":[[]]}`, `{"pullRequests":["text"]}`, `{"pullRequests":[1]}`, `{"pullRequests":[false]}`,
		`{"pullRequests":[{}]}`, `{"pullRequests":[{"url":"x"}]}`, `{"pullRequests":[{"title":"x"}]}`,
		`{"pullRequests":[{"url":null,"title":"x"}]}`, `{"pullRequests":[{"url":"x","title":null}]}`,
		`{"pullRequests":[{"url":1,"title":"x"}]}`, `{"pullRequests":[{"url":"x","title":[]}]}`,
		`{"pullRequests":[{"url":"x","title":"y","state":"open"}]}`,
		`{"pullRequests":[{"url":"x","title":"y","url":"z"}]}`,
		`{"pullRequests":[{"url":"x","title":"y","ti\u0074le":"z"}]}`,
	} {
		t.Run(properties, func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Rejected","properties":`+properties+`}`), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"title":"Rejected","properties":`+properties+`}`), http.StatusBadRequest, "invalid_input")
		})
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"properties":{}}`), http.StatusBadRequest, "invalid_input")
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("rejected property input mutated task")
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID), ""), http.StatusOK)
	if len(page.Items) != 1 {
		t.Fatal("rejected property input created tasks")
	}
}

func TestTaskHTTPCorruptPropertiesFailWithoutFallback(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Original")
	for _, corrupt := range []string{`not JSON`, `{}`, `{"pullRequests":null}`, `{"pullRequests":[{"url":"x"}]}`, `{"pullRequests":[],"unknown":1}`, `{"pullRequests":[],"pullRequests":[]}`} {
		if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET properties=$1 WHERE id=$2", corrupt, task.ID); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{taskPath(task), taskCollection(project.ID)} {
			assertProjectError(t, projectRequest(handler, http.MethodGet, path, ""), http.StatusInternalServerError, "internal_error")
		}
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"title":"Rejected"}`), http.StatusInternalServerError, "internal_error")
		graph := projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph", "")
		if graph.Code != http.StatusOK {
			t.Fatal("graph began decoding full properties")
		}
	}
}
