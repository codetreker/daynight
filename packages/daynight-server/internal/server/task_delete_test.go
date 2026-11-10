package server

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPSoftDeletionAndGoneResources(t *testing.T) {
	var logs bytes.Buffer
	f, handler, task := stepsHTTPFixture(t, &logs)
	path := taskPath(task)
	current := copyTaskHTTPTask(f.target)
	current.Title = "Private deleted body"
	prepareDelete := func(input taskcore.DeleteTask, failure error) {
		called := projectHTTPCount(t, 1)
		f.tasks.DeleteCall = func(ctx context.Context, actor model.Principal, project, id string, actual taskcore.DeleteTask) error {
			called()
			f.requireOperation(ctx, actor, project)
			platformHTTPCheck(t, id, current.ID)
			platformHTTPCheck(t, actual, input)
			return failure
		}
	}
	prepareDelete(taskcore.DeleteTask{Version: 2}, mutationHTTPFault("version_conflict"))
	assertProjectError(t, projectRequest(handler, http.MethodDelete, path, `{"version":2}`), 409, "version_conflict")
	prepareDelete(taskcore.DeleteTask{Version: task.Version}, nil)
	response := projectRequest(handler, http.MethodDelete, path, jsonBody(t, api.TaskDeleteRequest{Version: task.Version}))
	if response.Code != 204 || response.Body.Len() != 0 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("delete result: %d %s %v", response.Code, response.Body, response.Header())
	}
	for _, call := range []struct{ method, suffix, body string }{{http.MethodGet, "", ""}, {http.MethodDelete, "", `{"version":2}`}, {http.MethodPatch, "", `{"version":2,"title":"Changed"}`}, {http.MethodPut, "/status", `{"version":2,"status":"done"}`}, {http.MethodGet, "/attachments", ""}, {http.MethodGet, "/attachments/files/evidence.txt", ""}, {http.MethodGet, "/preview/evidence.txt", ""}} {
		switch {
		case call.method == http.MethodGet && call.suffix == "":
			called := projectHTTPCount(t, 1)
			f.tasks.ObserveCall = func(ctx context.Context, actor model.Principal, project, id string) (taskservice.TaskObservation, error) {
				called()
				f.requireOperation(ctx, actor, project)
				platformHTTPCheck(t, id, task.ID)
				return taskservice.TaskObservation{}, mutationHTTPFault("task_deleted")
			}
		case call.method == http.MethodGet && call.suffix == "/attachments":
			called := projectHTTPCount(t, 1)
			f.attachments.ListCall = func(ctx context.Context, actor model.Principal, project, id string, input model.PageRequest) (attachmentcore.Page, error) {
				called()
				f.requireOperation(ctx, actor, project)
				platformHTTPCheck(t, id, task.ID)
				platformHTTPCheck(t, input, model.PageRequest{Limit: 50})
				return attachmentcore.Page{}, mutationHTTPFault("task_deleted")
			}
		case call.method == http.MethodGet:
			called := projectHTTPCount(t, 1)
			f.attachments.OpenCall = func(ctx context.Context, actor model.Principal, project, id, file string) (model.Attachment, filestorage.Object, error) {
				called()
				f.requireOperation(ctx, actor, project)
				platformHTTPCheck(t, id, task.ID)
				platformHTTPCheck(t, file, "evidence.txt")
				return model.Attachment{}, filestorage.Object{}, mutationHTTPFault("task_deleted")
			}
		case call.method == http.MethodDelete:
			prepareDelete(taskcore.DeleteTask{Version: 2}, mutationHTTPFault("task_deleted"))
		case call.method == http.MethodPatch:
			expectMutationHTTPUpdate(f.taskHTTPFixture, task.ID, taskcore.UpdateTask{Version: 2, Title: platformHTTPPointer("Changed")}, model.Task{}, mutationHTTPFault("task_deleted"))
		case call.method == http.MethodPut:
			expectMutationHTTPStatus(f.taskHTTPFixture, task.ID, taskcore.SetTaskStatus{Version: 2, Status: model.TaskDone}, model.Task{}, mutationHTTPFault("task_deleted"))
		}
		assertProjectError(t, projectRequest(handler, call.method, path+call.suffix, call.body), 410, "task_deleted")
	}
	f.expectListRequest(taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}}, taskservice.TaskPage{Items: []model.Task{}}, nil)
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(task.ProjectID), ""), 200)
	if len(page.Items) != 0 {
		t.Fatal("deleted Task is still listed")
	}
	if !strings.Contains(logs.String(), `"phase":"delete"`) || !strings.Contains(logs.String(), `"cause":"task_deleted"`) || strings.Contains(logs.String(), current.Title) {
		t.Fatalf("missing or unsafe deletion diagnostics: %s", &logs)
	}
}
