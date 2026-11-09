package task_test

import (
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

func assignmentListFixture(t *testing.T, wanted store.TaskQuery, rows []model.Task) (*taskservice.Tasks, *taskReaderMock, model.Project, model.Principal) {
	t.Helper()
	project, _, principal := assignmentTaskModels()
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
func TestTaskAssignedToFilterComposesBeforePagination(t *testing.T) {
	_, row, admin := assignmentTaskModels()
	alice, bob := "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"
	for _, selector := range []*string{nil, pointer("unassigned"), pointer("me"), pointer(strings.ToUpper(alice)), &bob} {
		for _, status := range []*model.TaskStatus{nil, pointer(model.TaskTodo), pointer(model.TaskInProgress), pointer(model.TaskDone)} {
			for _, allowed := range []*bool{nil, pointer(false), pointer(true)} {
				for _, ready := range []*bool{nil, pointer(false), pointer(true)} {
					for _, platform := range []*model.TaskPlatform{nil, pointer(model.PlatformLinux)} {
						assignment := model.TaskAssignmentFilter{}
						if selector != nil {
							switch *selector {
							case "unassigned":
								assignment.Mode = model.TaskAssignmentUnassigned
							case "me":
								assignment = model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: admin.UserID}
							default:
								assignment = model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: strings.ToLower(*selector)}
							}
						}
						tasks, _, project, principal := assignmentListFixture(t, store.TaskQuery{AssignedTo: assignment, Status: status, AllowAgents: allowed, Ready: ready, CompatiblePlatform: platform}, []model.Task{row})
						page, err := tasks.List(t.Context(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, AssignedTo: selector, Status: status, AllowAgents: allowed, Ready: ready, CompatiblePlatform: platform})
						if err != nil || !reflect.DeepEqual(page.Items, []model.Task{row}) || page.NextCursor != nil {
							t.Fatalf("composed selection result: %#v %v", page, err)
						}
					}
				}
			}
		}
	}
	first, second := row, row
	first.AssignedTo = &alice
	second.AssignedTo = &alice
	second.ID = "88888888-8888-4888-8888-888888888888"
	second.CreatedAt = first.CreatedAt.Add(1)
	q := store.TaskQuery{AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: alice}, Status: pointer(model.TaskTodo), Ready: pointer(true), AllowAgents: pointer(true), CompatiblePlatform: pointer(model.PlatformLinux)}
	tasks, _, project, principal := assignmentListFixture(t, q, []model.Task{first, second})
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AssignedTo: &alice, Status: q.Status, Ready: q.Ready, AllowAgents: q.AllowAgents, CompatiblePlatform: q.CompatiblePlatform}
	var ids []string
	for {
		page, err := tasks.List(t.Context(), principal, project.ID, request)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, assignmentTaskIDs(page.Items)...)
		if page.NextCursor == nil {
			break
		}
		request.Cursor = page.NextCursor
	}
	if !slices.Equal(ids, []string{first.ID, second.ID}) {
		t.Fatalf("assignment pagination: %v", ids)
	}
	// Historical responsibility selects stored Task facts without requalifying membership.
	tasks, _, project, principal = assignmentListFixture(t, store.TaskQuery{AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: alice}}, []model.Task{first})
	page, err := tasks.List(t.Context(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, AssignedTo: &alice})
	if err != nil || len(page.Items) != 1 || page.Items[0].AssignedTo == nil || *page.Items[0].AssignedTo != alice {
		t.Fatalf("former assignee selection: %#v %v", page, err)
	}
}
func TestTaskAssignedToWorkerInventoryUsesExplicitSelectionOnly(t *testing.T) {
	_, base, actor := assignmentTaskModels()
	alice, bob, workerID := "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"
	active := []model.Task{base, base, base}
	for i := range active {
		active[i].ID = []string{base.ID, "88888888-8888-4888-8888-888888888888", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}[i]
		active[i].CreatedAt = base.CreatedAt.Add(time.Duration(i))
		active[i].AssignedTo = []*string{&bob, nil, &alice}[i]
	}
	worker := &store.WorkerQuery{UserID: actor.UserID, WorkerID: workerID}
	tasks, _, project, principal := assignmentListFixture(t, store.TaskQuery{Worker: worker}, active)
	all, err := tasks.List(t.Context(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, WorkerID: &workerID})
	if err != nil || !reflect.DeepEqual(assignmentTaskIDs(all.Items), assignmentTaskIDs(active)) {
		t.Fatalf("default worker inventory: %#v %v", all, err)
	}
	tasks, _, project, principal = assignmentListFixture(t, store.TaskQuery{Worker: worker, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: alice}}, []model.Task{active[2]})
	filtered, err := tasks.List(t.Context(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID, AssignedTo: &alice})
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].ID != active[2].ID || filtered.NextCursor != nil {
		t.Fatalf("explicit worker assignment: %#v %v", filtered, err)
	}
	tasks, _, project, principal = assignmentListFixture(t, store.TaskQuery{Ready: pointer(true), AllowAgents: pointer(true)}, active)
	candidates, err := tasks.List(t.Context(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, Ready: pointer(true), AllowAgents: pointer(true)})
	if err != nil || len(candidates.Items) != 3 {
		t.Fatalf("implicit responsibility filter: %#v %v", candidates, err)
	}
}
