package task_test

import (
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func assignmentTaskIDs(tasks []model.Task) []string {
	ids := make([]string, len(tasks))
	for index, task := range tasks {
		ids[index] = task.ID
	}
	return ids
}

func assignmentListFixture(t *testing.T, wanted store.TaskQuery, rows []model.Task) (*taskservice.Tasks, *taskReaderMock, model.Project, model.Principal) {
	t.Helper()
	project, _, principal := assignmentTaskModels()
	return assignmentListFixtureFor(t, wanted, rows, project, principal)
}

func assignmentListFixtureFor(t *testing.T, wanted store.TaskQuery, rows []model.Task, project model.Project, principal model.Principal) (*taskservice.Tasks, *taskReaderMock, model.Project, model.Principal) {
	t.Helper()
	ctx := t.Context()
	base := newTaskMockBase(t, "selection")
	projects := &projectReaderMock{taskMockBase: base.withLabel("project"), ProjectAccessFn: func(actual context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		if actual != ctx || p != principal || id != project.ID {
			t.Fatal("selection authorization scope")
		}
		return taskMockAccess(project, principal), nil
	}}
	reader := &taskReaderMock{taskMockBase: base.withLabel("task")}
	calls, returned := 0, 0
	reader.TasksFn = func(actual context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
		expected := wanted
		expected.TagFilter = store.TagFilter{TagIDs: []string{}, TagMatch: "all"}
		expected.Page.Limit = q.Page.Limit
		if returned > 0 {
			expected.Page.After = &store.Position{ID: rows[returned-1].ID, CreatedAt: rows[returned-1].CreatedAt}
		}
		if actual != ctx || id != project.ID || q.Page.Limit < 1 || !reflect.DeepEqual(q, expected) {
			t.Fatalf("selection query=%#v want=%#v", q, expected)
		}
		calls++
		end := min(returned+q.Page.Limit, len(rows))
		items := append([]model.Task{}, rows[returned:end]...)
		returned = end
		return store.TaskPage{Items: items, HasMore: returned < len(rows)}, nil
	}
	scope := &taskSnapshotScopeMock{taskMockBase: base.withLabel("snapshot"), ProjectDAOFn: func() store.ProjectReader { return projects }, TaskDAOFn: func() store.TaskReader { return reader }}
	database := &taskStoreMock{taskMockBase: base.withLabel("store"), ReadSnapshotFn: func(actual context.Context, work func(store.SnapshotScope) error) error {
		if actual != ctx {
			t.Fatal("selection snapshot context")
		}
		return work(scope)
	}}
	t.Cleanup(func() {
		if returned != len(rows) || calls < 1 {
			t.Errorf("selection returned=%d want=%d calls=%d", returned, len(rows), calls)
		}
	})
	return taskservice.NewTasks(database), reader, project, principal
}
