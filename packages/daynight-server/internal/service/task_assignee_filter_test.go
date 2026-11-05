package service

import (
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"

	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func assignmentCursorFields(t *testing.T, cursor string) map[string]any {
	t.Helper()
	data, err := base64.RawURLEncoding.Strict().DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func assignmentCursorMutation(t *testing.T, cursor string, mutate func(map[string]any)) string {
	t.Helper()
	value := assignmentCursorFields(t, cursor)
	mutate(value)
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func assignmentTaskIDs(tasks []model.Task) []string {
	ids := make([]string, len(tasks))
	for index, task := range tasks {
		ids[index] = task.ID
	}
	return ids
}

func TestTaskAssignedToCursorScopeAndOtherCursorVersions(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	alice := workerMember(t, database, project.ID)
	for range 3 {
		createAssignedTask(t, tasks, admin, project.ID, &admin.UserID)
	}
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AssignedTo: pointer("me")}
	page, err := tasks.List(ctx, admin, project.ID, request)
	if err != nil || page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatalf("missing self-filtered cursor: %#v %v", page, err)
	}
	fields := assignmentCursorFields(t, *page.NextCursor)
	if fields["version"] != float64(2) || fields["kind"] != "tasks" {
		t.Fatalf("task cursor did not adopt its own version: %#v", fields)
	}
	request.Cursor, request.AssignedTo = page.NextCursor, pointer(strings.ToUpper(admin.UserID))
	continued, err := tasks.List(ctx, admin, project.ID, request)
	if err != nil || len(continued.Items) != 1 || continued.Items[0].ID == page.Items[0].ID {
		t.Fatal("me and its canonical UUID do not share cursor scope", err)
	}
	for _, changed := range []*string{nil, pointer("unassigned"), &alice.UserID} {
		invalid := request
		invalid.AssignedTo = changed
		_, err := tasks.List(ctx, admin, project.ID, invalid)
		requireFault(t, err, "invalid_input")
	}
	request.AssignedTo = pointer("me")
	_, err = tasks.List(ctx, alice, project.ID, request)
	requireFault(t, err, "invalid_input")
	old := assignmentCursorMutation(t, *page.NextCursor, func(value map[string]any) { value["version"] = 1 })
	request.Cursor = &old
	_, err = tasks.List(ctx, admin, project.ID, request)
	requireFault(t, err, "invalid_input")
	for _, invalid := range []string{"", "ME", "Unassigned", " me", "null", "bad", strings.Repeat("a", 36)} {
		_, err := tasks.List(ctx, admin, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AssignedTo: &invalid})
		requireFault(t, err, "invalid_input")
	}
	projectCursor, err := query.EncodeProjectCursor(project, admin.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
	if err != nil {
		t.Fatal(err)
	}
	projectFields := assignmentCursorFields(t, projectCursor)
	if projectFields["version"] != float64(2) || projectFields["kind"] != "scoped-projects" {
		t.Fatalf("project cursor version or kind mismatch: %#v", projectFields)
	}
	workers := workerservice.NewWorkers(database)
	for range 2 {
		if _, err := workers.Report(ctx, admin, uuid.NewString(), serviceWorkerReport()); err != nil {
			t.Fatal(err)
		}
	}
	workerPage, err := workers.List(ctx, admin, model.PageRequest{Limit: 1})
	if err != nil || workerPage.NextCursor == nil {
		t.Fatal("worker cursor missing", err)
	}
	if workerFields := assignmentCursorFields(t, *workerPage.NextCursor); workerFields["version"] != float64(1) {
		t.Fatalf("worker cursor version changed with task cursor: %#v", workerFields)
	}
}
