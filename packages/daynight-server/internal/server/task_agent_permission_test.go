package server

import (
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskHTTPAgentPermissionResourcesAndStrictInputs(t *testing.T) {
	f := newTaskHTTPFixture(t)
	row := f.target
	row.AssignedTo, row.Title = nil, "Manual by default"
	created := platformHTTPWrite(f, nil, platformHTTPValues(row), row, false)
	response := projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Manual by default"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	platformHTTPCheck(t, task, platformHTTPAPI(*created))
	row = *created
	if task.AllowAgents || !strings.Contains(response.Body.String(), `"allowAgents":false`) {
		t.Fatalf("missing required false permission: %s", response.Body)
	}
	f.store.WriteProjectCall = nil
	for _, value := range []string{"true", "false", "null"} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Cannot opt in during creation","allowAgents":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	for _, value := range []string{"null", `"true"`, `0`, `[]`, `{}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), `{"version":1,"allowAgents":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), `{"version":1,"allowAgents":true,"allowAgents":false}`), http.StatusBadRequest, "invalid_input")
	f.expectRead(row)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, task), task)
	platformHTTPWrite(f, &row, platformHTTPValues(row), row, false)
	platformHTTPCheck(t, updateHTTPTask(t, f.handler, task, map[string]any{"allowAgents": false}), task)
	next := row
	next.AllowAgents = true
	next = platformHTTPResult(row, next)
	values := platformHTTPValues(row)
	values.AllowAgents = true
	platformHTTPWrite(f, &row, values, next, false)
	task = updateHTTPTask(t, f.handler, task, map[string]any{"allowAgents": true})
	platformHTTPCheck(t, task, platformHTTPAPI(next))
	row = next
	if !task.AllowAgents || task.Status != "todo" || !task.Ready {
		t.Fatalf("permission changed task status: %#v", task)
	}
	row = platformHTTPStatus(f, row, model.TaskInProgress)
	task = platformHTTPAPI(row)
	platformHTTPRefusal(f, row)
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "allowAgents": false, "description": "Must not save"})), http.StatusConflict, "invalid_transition")
	f.expectRead(row)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, task), task)
	row = platformHTTPStatus(f, row, model.TaskDone)
	task = platformHTTPAPI(row)
	next = row
	next.AllowAgents = false
	next = platformHTTPResult(row, next)
	values = platformHTTPValues(row)
	values.AllowAgents = false
	platformHTTPWrite(f, &row, values, next, false)
	task = updateHTTPTask(t, f.handler, task, map[string]any{"allowAgents": false})
	platformHTTPCheck(t, task, platformHTTPAPI(next))
	row = next
	for _, path := range []string{taskPath(task), taskCollection(f.project.ID), graphPath(f.project.ID, task.ID)} {
		switch path {
		case taskPath(task):
			f.expectRead(row)
		case taskCollection(f.project.ID):
			f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}}}, []store.TaskPage{{Items: []model.Task{row}}})
		default:
			f.expectGraph(row.ID, []model.GraphTask{platformHTTPProjection(row)})
		}
		read := projectRequest(f.handler, http.MethodGet, path, "")
		if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `"allowAgents":false`) {
			t.Fatalf("resource omitted permission: %s %s", path, read.Body)
		}
	}
}

func TestTaskHTTPAgentPermissionFilteringAndCursorScopes(t *testing.T) {
	f := newTaskHTTPFixture(t)
	rows := make([]model.Task, 5)
	for i := range rows {
		rows[i] = f.target
		rows[i].ID = platformHTTPID(i + 20)
		rows[i].AssignedTo = nil
		rows[i].Title = "Permission filter"
		rows[i].AllowAgents = i >= 2
	}
	collection := taskCollection(f.project.ID)
	for _, allowed := range []bool{false, true} {
		selected := rows[:2]
		want := []string{rows[0].ID, rows[1].ID}
		if allowed {
			selected = rows[2:]
			want = []string{rows[2].ID, rows[3].ID, rows[4].ID}
		}
		query, cursor := fmt.Sprintf("?ready=true&allowAgents=%t&limit=1", allowed), ""
		var ids []string
		for index, row := range selected {
			expected := store.TaskQuery{Page: store.Page{Limit: 1}, Ready: platformHTTPPointer(true), AllowAgents: platformHTTPPointer(allowed)}
			if index > 0 {
				expected.Page.After = &store.Position{CreatedAt: selected[index-1].CreatedAt, ID: selected[index-1].ID}
			}
			f.expectList([]store.TaskQuery{expected}, []store.TaskPage{{Items: []model.Task{row}, HasMore: index < len(selected)-1}})
			suffix := query
			if cursor != "" {
				suffix += "&cursor=" + url.QueryEscape(cursor)
			}
			page := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, collection+suffix, ""), http.StatusOK)
			if len(page.Items) != 1 {
				t.Fatalf("unexpected permission page: %#v", page)
			}
			platformHTTPCheck(t, page.Items[0], platformHTTPAPI(row))
			if page.Items[0].AllowAgents != allowed || !page.Items[0].Ready {
				t.Fatalf("permission page mismatch: %#v", page.Items[0])
			}
			ids = append(ids, page.Items[0].ID)
			if index == len(selected)-1 {
				if page.NextCursor != nil {
					t.Fatal("last permission page has cursor")
				}
				break
			}
			if page.NextCursor == nil {
				t.Fatal("permission page lost cursor")
			}
			cursor = *page.NextCursor
			f.store.ReadSnapshotCall = nil
			assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?limit=1&ready=true&cursor="+url.QueryEscape(cursor), ""), http.StatusBadRequest, "invalid_input")
			assertProjectError(t, projectRequest(f.handler, http.MethodGet, fmt.Sprintf("%s?limit=1&ready=true&allowAgents=%t&cursor=%s", collection, !allowed, url.QueryEscape(cursor)), ""), http.StatusBadRequest, "invalid_input")
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("permission response sequence: got %v want %v", ids, want)
		}
	}
	f.store.ReadSnapshotCall = nil
	for _, query := range []string{"allowAgents=", "allowAgents=True", "allowAgents=1", "allowAgents=null", "allowAgents=true&allowAgents=false", "AllowAgents=true"} {
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}
