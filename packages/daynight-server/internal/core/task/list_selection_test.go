package task

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type selectionReadStep struct {
	query store.TaskQuery
	page  store.TaskPage
}

type selectionReader struct {
	t              *testing.T
	ctx            context.Context
	project        string
	steps          []selectionReadStep
	used, returned int
	wantedRows     int
}

func selectionCopyPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return ptr(*value)
}

func selectionCopyQuery(value store.TaskQuery) store.TaskQuery {
	value.TagFilter.TagIDs = append([]string{}, value.TagFilter.TagIDs...)
	if value.TagFilter.TagMatch == "" {
		value.TagFilter.TagMatch = "all"
	}
	value.Status = selectionCopyPointer(value.Status)
	value.Ready = selectionCopyPointer(value.Ready)
	value.AllowAgents = selectionCopyPointer(value.AllowAgents)
	value.CompatiblePlatform = selectionCopyPointer(value.CompatiblePlatform)
	value.PlatformSpecific = selectionCopyPointer(value.PlatformSpecific)
	value.Worker = selectionCopyPointer(value.Worker)
	value.Page.After = selectionCopyPointer(value.Page.After)
	return value
}

func selectionCopyTasks(values []model.Task) []model.Task {
	if values == nil {
		return nil
	}
	result := make([]model.Task, len(values))
	for i, value := range values {
		value.AssignedTo = selectionCopyPointer(value.AssignedTo)
		value.RequiredPlatform = selectionCopyPointer(value.RequiredPlatform)
		value.StartedAt = selectionCopyPointer(value.StartedAt)
		value.CompletedAt = selectionCopyPointer(value.CompletedAt)
		value.CancelledAt = selectionCopyPointer(value.CancelledAt)
		value.DependsOn = slices.Clone(value.DependsOn)
		value.ExternalDependsOn = slices.Clone(value.ExternalDependsOn)
		value.BlockedBy = slices.Clone(value.BlockedBy)
		if value.Properties != nil {
			properties := make(model.TaskProperties, len(value.Properties))
			for key, raw := range value.Properties {
				properties[key] = slices.Clone(raw)
			}
			value.Properties = properties
		}
		result[i] = value
	}
	return result
}

func newSelectionReader(t *testing.T, project string, steps ...selectionReadStep) *selectionReader {
	t.Helper()
	f := &selectionReader{t: t, ctx: t.Context(), project: project, steps: make([]selectionReadStep, len(steps))}
	for i, step := range steps {
		f.steps[i] = selectionReadStep{query: selectionCopyQuery(step.query), page: store.TaskPage{Items: selectionCopyTasks(step.page.Items), HasMore: step.page.HasMore}}
		f.wantedRows += len(step.page.Items)
	}
	t.Cleanup(func() {
		if f.used != len(f.steps) || f.returned != f.wantedRows {
			t.Errorf("list reads = %d/%d, returned rows = %d/%d", f.used, len(f.steps), f.returned, f.wantedRows)
		}
	})
	return f
}

func (f *selectionReader) Task(context.Context, string, string) (model.Task, error) {
	f.t.Error("unexpected single Task read during list selection")
	return model.Task{}, errors.New("unexpected single Task read")
}

func (f *selectionReader) Tasks(ctx context.Context, project string, actual store.TaskQuery) (store.TaskPage, error) {
	if f.used == len(f.steps) {
		f.t.Error("unexpected extra Tasks read")
		return store.TaskPage{}, errors.New("unexpected extra Tasks read")
	}
	step := f.steps[f.used]
	f.used++
	if ctx != f.ctx || project != f.project || !reflect.DeepEqual(actual, step.query) {
		f.t.Errorf("list query = %#v, want %#v; project = %s, want %s", actual, step.query, project, f.project)
		return store.TaskPage{}, errors.New("list query arguments differ")
	}
	f.returned += len(step.page.Items)
	return store.TaskPage{Items: selectionCopyTasks(step.page.Items), HasMore: step.page.HasMore}, nil
}

func (f *selectionReader) list(actor string, request ListRequest) (ListPage, error) {
	selection, err := SelectList(f.project, actor, request)
	if err != nil {
		return ListPage{}, err
	}
	page, refusal, err := ReadList(f.ctx, f, f.project, selection)
	if err != nil {
		return ListPage{}, err
	}
	if refusal != nil {
		return ListPage{}, refusal
	}
	return ProjectList(selection, page)
}

func selectionTaskModels() (model.Task, string) {
	actor := "11111111-1111-4111-8111-111111111111"
	at := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	return model.Task{
		ID: "55555555-5555-4555-8555-555555555555", ProjectID: "33333333-3333-4333-8333-333333333333",
		Title: "Task", Description: "Preserved material", Properties: model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Evidence"}]`)},
		Status: model.TaskTodo, Version: 1, CreatedAt: at, UpdatedAt: at,
		DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: &actor, Ready: true,
	}, actor
}

func selectionTaskIDs(tasks []model.Task) []string {
	ids := make([]string, len(tasks))
	for i, task := range tasks {
		ids[i] = task.ID
	}
	return ids
}

func selectionCursorFields(t *testing.T, cursor string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.Strict().DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func selectionCursorMutation(t *testing.T, cursor string, mutate func(map[string]any)) string {
	t.Helper()
	value := selectionCursorFields(t, cursor)
	mutate(value)
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func selectionInvalidInput(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" || fault.Message == "" || err.Error() != fault.Message {
		t.Fatalf("expected invalid_input fault, got %#v", err)
	}
}

func TestTaskAssignedToFilterComposesBeforePagination(t *testing.T) {
	row, actor := selectionTaskModels()
	alice, bob := "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"
	for _, selector := range []*string{nil, ptr("unassigned"), ptr("me"), ptr(strings.ToUpper(alice)), &bob} {
		for _, status := range []*model.TaskStatus{nil, ptr(model.TaskTodo), ptr(model.TaskInProgress), ptr(model.TaskDone)} {
			for _, allowed := range []*bool{nil, ptr(false), ptr(true)} {
				for _, ready := range []*bool{nil, ptr(false), ptr(true)} {
					for _, platform := range []*model.TaskPlatform{nil, ptr(model.PlatformLinux)} {
						assignment := model.TaskAssignmentFilter{}
						if selector != nil {
							switch *selector {
							case "unassigned":
								assignment.Mode = model.TaskAssignmentUnassigned
							case "me":
								assignment = model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: actor}
							default:
								assignment = model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: strings.ToLower(*selector)}
							}
						}
						reader := newSelectionReader(t, row.ProjectID, selectionReadStep{
							query: store.TaskQuery{Page: store.Page{Limit: 100}, AssignedTo: assignment, Status: status, AllowAgents: allowed, Ready: ready, CompatiblePlatform: platform},
							page:  store.TaskPage{Items: []model.Task{row}},
						})
						page, err := reader.list(actor, ListRequest{PageRequest: model.PageRequest{Limit: 100}, AssignedTo: selector, Status: status, AllowAgents: allowed, Ready: ready, CompatiblePlatform: platform})
						if err != nil || !reflect.DeepEqual(page.Items, []model.Task{row}) || page.NextCursor != nil {
							t.Fatalf("composed selection result: %#v %v", page, err)
						}
					}
				}
			}
		}
	}
	first, second := row, row
	first.AssignedTo, second.AssignedTo = &alice, &alice
	second.ID = "88888888-8888-4888-8888-888888888888"
	second.CreatedAt = first.CreatedAt.Add(1)
	wanted := store.TaskQuery{Page: store.Page{Limit: 1}, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: alice}, Status: ptr(model.TaskTodo), Ready: ptr(true), AllowAgents: ptr(true), CompatiblePlatform: ptr(model.PlatformLinux)}
	continued := wanted
	continued.Page.After = &store.Position{ID: first.ID, CreatedAt: first.CreatedAt}
	reader := newSelectionReader(t, row.ProjectID,
		selectionReadStep{query: wanted, page: store.TaskPage{Items: []model.Task{first}, HasMore: true}},
		selectionReadStep{query: continued, page: store.TaskPage{Items: []model.Task{second}}},
	)
	request := ListRequest{PageRequest: model.PageRequest{Limit: 1}, AssignedTo: &alice, Status: wanted.Status, Ready: wanted.Ready, AllowAgents: wanted.AllowAgents, CompatiblePlatform: wanted.CompatiblePlatform}
	var ids []string
	for {
		page, err := reader.list(actor, request)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, selectionTaskIDs(page.Items)...)
		if page.NextCursor == nil {
			break
		}
		request.Cursor = page.NextCursor
	}
	if !slices.Equal(ids, []string{first.ID, second.ID}) {
		t.Fatalf("assignment pagination: %v", ids)
	}
	// Historical responsibility selects stored Task facts without requalifying membership.
	reader = newSelectionReader(t, row.ProjectID, selectionReadStep{
		query: store.TaskQuery{Page: store.Page{Limit: 100}, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: alice}},
		page:  store.TaskPage{Items: []model.Task{first}},
	})
	page, err := reader.list(actor, ListRequest{PageRequest: model.PageRequest{Limit: 100}, AssignedTo: &alice})
	if err != nil || len(page.Items) != 1 || page.Items[0].AssignedTo == nil || *page.Items[0].AssignedTo != alice {
		t.Fatalf("former assignee selection: %#v %v", page, err)
	}
}

func TestTaskAssignedToWorkerInventoryUsesExplicitSelectionOnly(t *testing.T) {
	base, actor := selectionTaskModels()
	alice, bob, workerID := "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"
	active := []model.Task{base, base, base}
	for i := range active {
		active[i].ID = []string{base.ID, "88888888-8888-4888-8888-888888888888", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}[i]
		active[i].CreatedAt = base.CreatedAt.Add(time.Duration(i))
		active[i].AssignedTo = []*string{&bob, nil, &alice}[i]
	}
	worker := &store.WorkerQuery{UserID: actor, WorkerID: workerID}
	reader := newSelectionReader(t, base.ProjectID, selectionReadStep{query: store.TaskQuery{Page: store.Page{Limit: 100}, Worker: worker}, page: store.TaskPage{Items: active}})
	all, err := reader.list(actor, ListRequest{PageRequest: model.PageRequest{Limit: 100}, WorkerID: &workerID})
	if err != nil || !reflect.DeepEqual(selectionTaskIDs(all.Items), selectionTaskIDs(active)) || !reflect.DeepEqual(all.Items, active) {
		t.Fatalf("default worker inventory: %#v %v", all, err)
	}
	reader = newSelectionReader(t, base.ProjectID, selectionReadStep{
		query: store.TaskQuery{Page: store.Page{Limit: 1}, Worker: worker, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: alice}},
		page:  store.TaskPage{Items: []model.Task{active[2]}},
	})
	filtered, err := reader.list(actor, ListRequest{PageRequest: model.PageRequest{Limit: 1}, WorkerID: &workerID, AssignedTo: &alice})
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].ID != active[2].ID || filtered.NextCursor != nil || !reflect.DeepEqual(filtered.Items, []model.Task{active[2]}) {
		t.Fatalf("explicit worker assignment: %#v %v", filtered, err)
	}
	reader = newSelectionReader(t, base.ProjectID, selectionReadStep{
		query: store.TaskQuery{Page: store.Page{Limit: 100}, Ready: ptr(true), AllowAgents: ptr(true)},
		page:  store.TaskPage{Items: active},
	})
	candidates, err := reader.list(actor, ListRequest{PageRequest: model.PageRequest{Limit: 100}, Ready: ptr(true), AllowAgents: ptr(true)})
	if err != nil || len(candidates.Items) != 3 || !reflect.DeepEqual(candidates.Items, active) {
		t.Fatalf("implicit responsibility filter: %#v %v", candidates, err)
	}
}

func TestTaskAssignedToCursorScopeAndVersion(t *testing.T) {
	first, _ := selectionTaskModels()
	project, actor := "abcdef22-2222-4222-8222-222222222222", "abcdef11-1111-4111-8111-111111111111"
	first.ID, first.ProjectID, first.AssignedTo = "abcdef33-3333-4333-8333-333333333333", project, &actor
	second := first
	second.ID = "abcdef44-4444-4444-8444-444444444444"
	second.CreatedAt = first.CreatedAt.Add(time.Second)
	firstQuery := store.TaskQuery{Page: store.Page{Limit: 1}, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: actor}}
	secondQuery := firstQuery
	secondQuery.Page.After = &store.Position{ID: first.ID, CreatedAt: first.CreatedAt}
	reader := newSelectionReader(t, project,
		selectionReadStep{query: firstQuery, page: store.TaskPage{Items: []model.Task{first}, HasMore: true}},
		selectionReadStep{query: secondQuery, page: store.TaskPage{Items: []model.Task{second}}},
	)
	request := ListRequest{PageRequest: model.PageRequest{Limit: 1}, AssignedTo: ptr("me")}
	page, err := reader.list(actor, request)
	if err != nil || page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatalf("self-filtered cursor: %#v %v", page, err)
	}
	fields := selectionCursorFields(t, *page.NextCursor)
	if fields["version"] != float64(3) || fields["kind"] != "tasks" {
		t.Fatalf("task cursor version/kind: %#v", fields)
	}
	request.Cursor, request.AssignedTo = page.NextCursor, ptr(strings.ToUpper(actor))
	continued, err := reader.list(actor, request)
	if err != nil || len(continued.Items) != 1 || continued.Items[0].ID == page.Items[0].ID {
		t.Fatalf("canonical UUID and me cursor scope differ: %#v %v", continued, err)
	}
	for _, changed := range []*string{nil, ptr("unassigned"), ptr("66666666-6666-4666-8666-666666666666")} {
		invalid := request
		invalid.AssignedTo = changed
		_, err := reader.list(actor, invalid)
		selectionInvalidInput(t, err)
	}
	other := "66666666-6666-4666-8666-666666666666"
	request.AssignedTo = ptr("me")
	_, err = reader.list(other, request)
	selectionInvalidInput(t, err)
	old := selectionCursorMutation(t, *page.NextCursor, func(value map[string]any) { value["version"] = 1 })
	request.Cursor = &old
	_, err = reader.list(actor, request)
	selectionInvalidInput(t, err)
	for _, invalid := range []string{"", "ME", "Unassigned", " me", "null", "bad", strings.Repeat("a", 36)} {
		_, err := reader.list(actor, ListRequest{PageRequest: model.PageRequest{Limit: 1}, AssignedTo: &invalid})
		selectionInvalidInput(t, err)
	}
}

func TestTaskResourceCursorScope(t *testing.T) {
	project, actor := "abcdef22-2222-4222-8222-222222222222", "abcdef11-1111-4111-8111-111111111111"
	parent := "abcdef33-3333-4333-8333-333333333333"
	selection, err := SelectList(project, actor, ListRequest{PageRequest: model.PageRequest{Limit: 1}, Parent: &parent})
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := query.EncodeListCursor(selection.Scope, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), "abcdef44-4444-4444-8444-444444444444")
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []ListRequest{
		{PageRequest: model.PageRequest{Limit: 1, Cursor: &cursor}},
		{PageRequest: model.PageRequest{Limit: 1, Cursor: &cursor}, Parent: ptr("none")},
		{PageRequest: model.PageRequest{Limit: 1, Cursor: &cursor}, Type: model.TaskTypeGoal},
	} {
		if _, err := SelectList(project, actor, request); err == nil {
			t.Fatalf("accepted different scope: %#v", request)
		}
	}
	if _, err := SelectList(project, actor, ListRequest{PageRequest: model.PageRequest{Limit: 1}, Type: model.TaskTypeGoal, Parent: &parent}); err == nil {
		t.Fatal("accepted Goal parent")
	}
}
