package server

import (
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPPlatformStrictInputsAndNullableResources(t *testing.T) {
	f := newTaskHTTPFixture(t)
	row := f.target
	row.AssignedTo, row.Title = nil, "Unrestricted default"
	created := expectMutationHTTPCreate(f, taskcore.CreateTask{Title: row.Title, Status: platformHTTPPointer(model.TaskTodo), DependsOn: []string{}, Properties: model.TaskProperties{}}, row, nil)
	response := projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Unrestricted default","status":"todo"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	platformHTTPCheck(t, task, platformHTTPAPI(*created))
	row = *created
	if task.RequiredPlatform != nil || !strings.Contains(response.Body.String(), `"requiredPlatform":null`) {
		t.Fatalf("missing mandatory nullable requirement: %s", response.Body)
	}
	clearMutationHTTPOperations(f)
	for _, value := range []string{`""`, `"darwin"`, `"Linux"`, `"linux "`, `true`, `0`, `[]`, `{}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), `{"title":"Invalid platform","requiredPlatform":`+value+`}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), `{"version":1,"requiredPlatform":`+value+`}`), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{"title":"Duplicate","requiredPlatform":null,"requiredPlatform":"linux"}`, `{"title":"Wrong case","RequiredPlatform":"linux"}`} {
		assertProjectError(t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), `{"version":1,"requiredPlatform":"linux","requiredPlatform":null}`), http.StatusBadRequest, "invalid_input")
	f.expectRead(row)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, task), task)
	expectMutationHTTPUpdate(f, row.ID, taskcore.UpdateTask{Version: row.Version, RequiredPlatform: platformHTTPPointer[*model.TaskPlatform](nil)}, row, nil)
	platformHTTPCheck(t, updateHTTPTask(t, f.handler, task, map[string]any{"requiredPlatform": nil}), task)
	for _, value := range []any{nil, "windows", "linux", "macos"} {
		wanted := f.target
		wanted.AssignedTo, wanted.Title = nil, "Explicit platform"
		if value != nil {
			platform := model.TaskPlatform(value.(string))
			wanted.RequiredPlatform = &platform
		}
		result := expectMutationHTTPCreate(f, taskcore.CreateTask{Title: wanted.Title, Status: platformHTTPPointer(model.TaskTodo), RequiredPlatform: copyTaskHTTPPointer(wanted.RequiredPlatform), DependsOn: []string{}, Properties: model.TaskProperties{}}, wanted, nil)
		got := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), jsonBody(t, map[string]any{"title": "Explicit platform", "requiredPlatform": value, "status": "todo"})), http.StatusCreated)
		platformHTTPCheck(t, got, platformHTTPAPI(*result))
		if value == nil && got.RequiredPlatform != nil || value != nil && (got.RequiredPlatform == nil || *got.RequiredPlatform != value) {
			t.Fatal("creation lost platform")
		}
	}
	windows := model.PlatformWindows
	next := row
	next.RequiredPlatform, next.AllowAgents = &windows, true
	next = platformHTTPResult(row, next)
	expectMutationHTTPUpdate(f, row.ID, taskcore.UpdateTask{Version: row.Version, RequiredPlatform: platformHTTPPointer(&windows), AllowAgents: platformHTTPPointer(true)}, next, nil)
	task = updateHTTPTask(t, f.handler, platformHTTPAPI(row), map[string]any{"requiredPlatform": "windows", "allowAgents": true})
	platformHTTPCheck(t, task, platformHTTPAPI(next))
	row = next
	if task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" || !task.AllowAgents {
		t.Fatal("setting platform lost permission")
	}
	next = row
	next.Description = "Omitted requirement"
	next = platformHTTPResult(row, next)
	expectMutationHTTPUpdate(f, row.ID, taskcore.UpdateTask{Version: row.Version, Description: platformHTTPPointer("Omitted requirement")}, next, nil)
	task = updateHTTPTask(t, f.handler, task, map[string]any{"description": "Omitted requirement"})
	platformHTTPCheck(t, task, platformHTTPAPI(next))
	row = next
	if task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" {
		t.Fatal("omitted platform cleared requirement")
	}
	row = platformHTTPStatus(f, row, model.TaskInProgress)
	task = platformHTTPAPI(row)
	if task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" {
		t.Fatal("manual start discarded requirement")
	}
	expectMutationHTTPUpdate(f, row.ID, taskcore.UpdateTask{Version: row.Version, RequiredPlatform: platformHTTPPointer(&windows)}, row, nil)
	platformHTTPCheck(t, updateHTTPTask(t, f.handler, task, map[string]any{"requiredPlatform": "windows"}), task)
	expectMutationHTTPUpdate(f, row.ID, taskcore.UpdateTask{Version: task.Version - 1, RequiredPlatform: platformHTTPPointer(&windows)}, model.Task{}, mutationHTTPFault("version_conflict"))
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version - 1, "requiredPlatform": "windows"})), http.StatusConflict, "version_conflict")
	expectMutationHTTPUpdate(f, row.ID, taskcore.UpdateTask{Version: task.Version, RequiredPlatform: platformHTTPPointer[*model.TaskPlatform](nil), Description: platformHTTPPointer("Must not save")}, model.Task{}, mutationHTTPFault("invalid_transition"))
	assertProjectError(t, projectRequest(f.handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "requiredPlatform": nil, "description": "Must not save"})), http.StatusConflict, "invalid_transition")
	f.expectRead(row)
	platformHTTPCheck(t, readHTTPTask(t, f.handler, task), task)
	for _, path := range []string{taskPath(task), taskCollection(f.project.ID), graphPath(f.project.ID, task.ID)} {
		switch path {
		case taskPath(task):
			f.expectRead(row)
		case taskCollection(f.project.ID):
			f.expectListRequest(taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}}, taskservice.TaskPage{Items: []model.Task{row}}, nil)
		default:
			f.expectGraph(row.ID, []model.GraphTask{platformHTTPProjection(row)}, model.TaskGraphSummary{Total: 1, InProgress: 1})
		}
		read := projectRequest(f.handler, http.MethodGet, path, "")
		if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `"requiredPlatform":"windows"`) {
			t.Fatalf("resource lost platform: %s %s", path, read.Body)
		}
	}
	row = platformHTTPStatus(f, row, model.TaskDone)
	task = platformHTTPAPI(row)
	next = row
	next.RequiredPlatform = nil
	next = platformHTTPResult(row, next)
	expectMutationHTTPUpdate(f, row.ID, taskcore.UpdateTask{Version: row.Version, RequiredPlatform: platformHTTPPointer[*model.TaskPlatform](nil)}, next, nil)
	cleared := updateHTTPTask(t, f.handler, task, map[string]any{"requiredPlatform": nil})
	platformHTTPCheck(t, cleared, platformHTTPAPI(next))
	if cleared.RequiredPlatform != nil || !cleared.AllowAgents || !reflect.DeepEqual(cleared.StartedAt, task.StartedAt) || !reflect.DeepEqual(cleared.CompletedAt, task.CompletedAt) {
		t.Fatal("clearing platform changed history")
	}
}

func TestTaskHTTPPlatformFilteringAndCursorScopes(t *testing.T) {
	f := newTaskHTTPFixture(t)
	rows := make([]model.Task, 5)
	for i, value := range []*model.TaskPlatform{platformHTTPPointer(model.PlatformWindows), platformHTTPPointer(model.PlatformMacOS), platformHTTPPointer(model.PlatformLinux), nil, platformHTTPPointer(model.PlatformLinux)} {
		rows[i] = f.target
		rows[i].ID = platformHTTPID(i + 1)
		rows[i].Title = "Platform candidate"
		rows[i].AssignedTo = nil
		rows[i].RequiredPlatform = value
		rows[i].AllowAgents = true
	}
	selected := []model.Task{rows[2], rows[3], rows[4]}
	want := []string{rows[2].ID, rows[3].ID, rows[4].ID}
	collection, query, cursor := taskCollection(f.project.ID), "?limit=1&ready=true&allowAgents=true&compatiblePlatform=linux", ""
	var ids []string
	for index, row := range selected {
		expected := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1, Cursor: mutationHTTPCursorInput(cursor)}, Ready: platformHTTPPointer(true), AllowAgents: platformHTTPPointer(true), CompatiblePlatform: platformHTTPPointer(model.PlatformLinux)}
		var next *string
		if index < len(selected)-1 {
			next = platformHTTPPointer(mutationHTTPCursor(index + 1))
		}
		f.expectListRequest(expected, taskservice.TaskPage{Items: []model.Task{row}, NextCursor: next}, nil)
		suffix := query
		if cursor != "" {
			suffix += "&cursor=" + url.QueryEscape(cursor)
		}
		page := decodeResponse[api.TaskPage](t, projectRequest(f.handler, http.MethodGet, collection+suffix, ""), http.StatusOK)
		if len(page.Items) != 1 {
			t.Fatalf("unexpected compatible page: %#v", page)
		}
		platformHTTPCheck(t, page.Items[0], platformHTTPAPI(row))
		ids = append(ids, page.Items[0].ID)
		if index == len(selected)-1 {
			if page.NextCursor != nil {
				t.Fatal("last compatible page has cursor")
			}
			break
		}
		if page.NextCursor == nil {
			t.Fatal("compatible page lost cursor")
		}
		cursor = *page.NextCursor
		clearMutationHTTPOperations(f)
		for _, platform := range []string{"", "windows", "macos"} {
			changed := "?limit=1&ready=true&allowAgents=true&cursor=" + url.QueryEscape(cursor)
			if platform != "" {
				changed += "&compatiblePlatform=" + platform
			}
			rejected := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1, Cursor: mutationHTTPCursorInput(cursor)}, Ready: platformHTTPPointer(true), AllowAgents: platformHTTPPointer(true)}
			if platform != "" {
				rejected.CompatiblePlatform = platformHTTPPointer(model.TaskPlatform(platform))
			}
			f.expectListRequest(rejected, taskservice.TaskPage{}, mutationHTTPFault("invalid_input"))
			assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+changed, ""), http.StatusBadRequest, "invalid_input")
		}
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("compatible response sequence: got %v want %v", ids, want)
	}
	clearMutationHTTPOperations(f)
	for _, query := range []string{"compatiblePlatform=", "compatiblePlatform=null", "compatiblePlatform=darwin", "compatiblePlatform=Linux", "compatiblePlatform=true", "compatiblePlatform=linux&compatiblePlatform=macos", "CompatiblePlatform=linux"} {
		if query != "compatiblePlatform=" && !strings.Contains(query, "&") && !strings.HasPrefix(query, "CompatiblePlatform=") {
			value := strings.TrimPrefix(query, "compatiblePlatform=")
			f.expectListRequest(taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}, CompatiblePlatform: platformHTTPPointer(model.TaskPlatform(value))}, taskservice.TaskPage{}, mutationHTTPFault("invalid_input"))
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}

func TestTaskHTTPStatusPreservesRequiredPlatformForEveryPair(t *testing.T) {
	f := newTaskHTTPFixture(t)
	for _, platform := range []*model.TaskPlatform{nil, platformHTTPPointer(model.PlatformWindows), platformHTTPPointer(model.PlatformLinux), platformHTTPPointer(model.PlatformMacOS)} {
		for _, from := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
			for _, to := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
				before := f.target
				before.ID = platformHTTPID(50)
				before.Title = "Status keeps platform"
				before.AssignedTo = nil
				before.RequiredPlatform = platform
				before.Status = from
				before.Ready = from == model.TaskTodo
				if from != model.TaskTodo {
					before.StartedAt = copyTaskHTTPPointer(&before.CreatedAt)
				}
				if from == model.TaskDone {
					before.CompletedAt = copyTaskHTTPPointer(&before.UpdatedAt)
				}
				after := platformHTTPStatus(f, before, to)
				delta := int64(1)
				if from == to {
					delta = 0
				}
				if !reflect.DeepEqual(after.RequiredPlatform, before.RequiredPlatform) || after.Version != before.Version+delta {
					t.Fatalf("status %s to %s changed platform %v: before %#v, after %#v", from, to, platform, before, after)
				}
				if delta == 0 && !reflect.DeepEqual(after, before) {
					t.Fatal("same status changed platform or other resource data")
				}
			}
		}
	}
}

func platformHTTPPointer[T any](value T) *T { return &value }
func platformHTTPID(number int) string      { return fmt.Sprintf("ab000000-0000-4000-8000-%012d", number) }
