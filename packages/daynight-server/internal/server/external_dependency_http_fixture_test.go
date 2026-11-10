package server

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type externalHTTPFixture struct{ *taskHTTPFixture }

func newExternalHTTPFixture(t *testing.T) *externalHTTPFixture {
	t.Helper()
	return &externalHTTPFixture{newTaskHTTPFixture(t)}
}
func externalHTTPRecord(projectID, id, title string) model.Task {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.Task{ID: id, ProjectID: projectID, Title: title, Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: at, UpdatedAt: at, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true}
}
func externalHTTPChanged(before model.Task) model.Task {
	after := copyTaskHTTPTask(before)
	after.Version, after.UpdatedAt = before.Version+1, before.UpdatedAt.Add(time.Microsecond)
	return after
}
func externalHTTPAPI(row model.Task) api.Task {
	row = copyTaskHTTPTask(row)
	return api.Task{ID: row.ID, ProjectID: row.ProjectID, Title: row.Title, Description: row.Description, Properties: row.Properties, Status: string(row.Status), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn, BlockedBy: row.BlockedBy, AssignedTo: row.AssignedTo, AllowAgents: row.AllowAgents, Ready: row.Ready}
}
func externalHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("external dependency operation argument: got %#v, want %#v", actual, expected)
		panic("external dependency operation argument mismatch")
	}
}
func (f *externalHTTPFixture) clearOperations()    { clearMutationHTTPOperations(f.taskHTTPFixture) }
func (f *externalHTTPFixture) read(row model.Task) { f.clearOperations(); f.expectRead(row) }
func (f *externalHTTPFixture) page(rows []model.Task, status *model.TaskStatus, ready *bool) {
	f.clearOperations()
	f.expectListRequest(taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}, Status: copyTaskHTTPPointer(status), Ready: copyTaskHTTPPointer(ready)}, taskservice.TaskPage{Items: copyTaskHTTPRows(rows)}, nil)
}
func (f *externalHTTPFixture) graph(root string, rows []model.Task, summary model.TaskGraphSummary) {
	f.clearOperations()
	result := make([]model.GraphTask, len(rows))
	for index, row := range rows {
		result[index] = model.GraphTask{ID: row.ID, TitlePreview: row.Title, Status: row.Status, DependsOn: copyTaskHTTPSlice(row.DependsOn), ExternalDependsOn: copyTaskHTTPSlice(row.ExternalDependsOn), BlockedBy: copyTaskHTTPSlice(row.BlockedBy), AllowAgents: row.AllowAgents, Ready: row.Ready, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: copyTaskHTTPPointer(row.StartedAt), CompletedAt: copyTaskHTTPPointer(row.CompletedAt), CancelledAt: copyTaskHTTPPointer(row.CancelledAt)}
	}
	f.expectGraph(root, result, summary)
}
func externalHTTPID(letter byte) string {
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", string(slices.Repeat([]byte{letter}, 8)), string(slices.Repeat([]byte{letter}, 4)), string(slices.Repeat([]byte{letter}, 3)), string(slices.Repeat([]byte{letter}, 3)), string(slices.Repeat([]byte{letter}, 12)))
}
func mutationHTTPCursor(index int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"version":2,"fixturePage":%d}`, index)))
}
func (f *externalHTTPFixture) update(before, after model.Task, patch map[string]any, input taskcore.UpdateTask) api.Task {
	input.Version = before.Version
	expectMutationHTTPUpdate(f.taskHTTPFixture, before.ID, input, after, nil)
	got := updateHTTPTask(f.t, f.handler, externalHTTPAPI(before), patch)
	externalHTTPCheck(f.t, got, externalHTTPAPI(after))
	return got
}
func (f *externalHTTPFixture) status(before, after model.Task) api.Task {
	expectMutationHTTPStatus(f.taskHTTPFixture, before.ID, taskcore.SetTaskStatus{Version: before.Version, Status: after.Status}, after, nil)
	got := setHTTPTask(f.t, f.handler, externalHTTPAPI(before), string(after.Status))
	externalHTTPCheck(f.t, got, externalHTTPAPI(after))
	return got
}
func (f *externalHTTPFixture) rejectedPatch(current model.Task, body string, expected *taskcore.UpdateTask, code string) {
	f.clearOperations()
	if expected != nil {
		expectMutationHTTPUpdate(f.taskHTTPFixture, current.ID, *expected, model.Task{}, mutationHTTPFault(code))
	}
	status := http.StatusBadRequest
	if code == "version_conflict" || code == "dependency_unsatisfied" {
		status = http.StatusConflict
	}
	assertProjectError(f.t, projectRequest(f.handler, http.MethodPatch, taskPath(externalHTTPAPI(current)), body), status, code)
}

func mutationHTTPCursorInput(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
