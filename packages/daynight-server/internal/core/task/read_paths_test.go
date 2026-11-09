package task

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type readFixture struct {
	err  error
	task model.Task
	page store.TaskPage
}

func (f readFixture) Task(context.Context, string, string) (model.Task, error) { return f.task, f.err }
func (f readFixture) Tasks(context.Context, string, store.TaskQuery) (store.TaskPage, error) {
	return f.page, f.err
}

type projectionFixture struct {
	err     error
	facts   []model.TaskAssigneeFact
	epoch   string
	records []model.TaskViewRecord
}

func (f projectionFixture) TaskCacheEpoch(context.Context, string) (string, error) {
	return f.epoch, f.err
}
func (f projectionFixture) TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error) {
	return f.records, f.err
}
func (f projectionFixture) TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error) {
	return f.facts, f.err
}
func (f projectionFixture) ResolveTaskAssignees(context.Context, string, []string) ([]model.TaskAssigneeFact, error) {
	return f.facts, f.err
}
func TestReadAndListBoundaries(t *testing.T) {
	ctx := context.Background()
	id := "00000000-0000-4000-8000-000000000001"
	selection, err := SelectList(id, id, ListRequest{PageRequest: model.PageRequest{Limit: 2}})
	if err != nil {
		t.Fatal(err)
	}
	_, refusal, err := ReadTask(ctx, readFixture{err: model.ErrNotFound}, id, id)
	if err != nil || refusal == nil || refusal.Code != "not_found" {
		t.Fatal(refusal, err)
	}
	_, refusal, err = ReadTask(ctx, readFixture{err: model.ErrTaskDeleted}, id, id)
	if err != nil || refusal == nil || refusal.Code != "task_deleted" {
		t.Fatal(refusal, err)
	}
	sentinel := errors.New("read")
	_, refusal, err = ReadTask(ctx, readFixture{err: sentinel}, id, id)
	if !errors.Is(err, sentinel) || refusal != nil {
		t.Fatal(refusal, err)
	}
	_, refusal, err = ReadList(ctx, readFixture{err: sentinel}, id, selection)
	if !errors.Is(err, sentinel) || refusal != nil {
		t.Fatal(refusal, err)
	}
	task := model.Task{ID: id, CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	page, refusal, err := ReadList(ctx, readFixture{page: store.TaskPage{Items: []model.Task{task}, HasMore: true}}, id, selection)
	if err != nil || refusal != nil {
		t.Fatal(refusal, err)
	}
	projected, err := ProjectList(selection, page)
	if err != nil || projected.NextCursor == nil {
		t.Fatal(projected, err)
	}
	if _, err = ProjectList(selection, store.TaskPage{Items: []model.Task{task}}); err != nil {
		t.Fatal(err)
	}
	if _, err = SelectList(id, id, ListRequest{Status: ptr(model.TaskStatus("bad"))}); err == nil {
		t.Fatal("bad status")
	}
	if _, err = SelectList(id, id, ListRequest{CompatiblePlatform: ptr(model.TaskPlatform("bad"))}); err == nil {
		t.Fatal("bad platform")
	}
	if _, err = SelectList(id, id, ListRequest{WorkerID: ptr("bad")}); err == nil {
		t.Fatal("bad worker")
	}
	if _, err = AssignmentFilter(ptr("bad"), id); err == nil {
		t.Fatal("bad assignee")
	}
}
func TestSyncAndAssigneesProjection(t *testing.T) {
	ctx := context.Background()
	id := "00000000-0000-4000-8000-000000000001"
	f := projectionFixture{epoch: id, facts: []model.TaskAssigneeFact{{UserID: id, ProfileID: &id, HasProjectAccess: true, Qualified: true}}}
	result, err := ReadAssignees(ctx, f, id, nil)
	if err != nil || len(result.Items) != 1 {
		t.Fatal(result, err)
	}
	result, err = ReadAssignees(ctx, f, id, []string{id})
	if err != nil || len(result.Items) != 1 {
		t.Fatal(result, err)
	}
	clock := func(context.Context) (time.Time, error) { return time.Unix(1, 0), nil }
	sync, refusal, err := ReadSync(ctx, f, clock, id, "", nil, time.Second, model.TaskSync{})
	if err != nil || refusal != nil || sync.Mode != "snapshot" || len(sync.AssigneeVersions) != 1 {
		t.Fatal(sync, refusal, err)
	}
	f.err = errors.New("database")
	if _, err = ReadAssignees(ctx, f, id, nil); err == nil {
		t.Fatal("hidden error")
	}
	if _, err = ReadAssignees(ctx, f, id, []string{id}); err == nil {
		t.Fatal("hidden error")
	}
	_, _, err = ReadSync(ctx, f, clock, id, id, nil, time.Second, model.TaskSync{})
	if err == nil {
		t.Fatal("hidden error")
	}
}

func TestProjectionFailurePropagation(t *testing.T) {
	ctx := context.Background()
	sentinel := errors.New("clock failure")
	fixture := &graphFixture{present: store.TaskPresence{Found: true}}
	_, _, err := ReadGraph(ctx, fixture, func(context.Context) (time.Time, error) { return time.Time{}, sentinel }, "project", "task", model.Project{})
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	f := projectionFixture{epoch: "epoch"}
	_, _, err = ReadSync(ctx, f, func(context.Context) (time.Time, error) { return time.Time{}, sentinel }, "project", "epoch", nil, time.Second, model.TaskSync{})
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	if got := PropertyInputError(sentinel); !errors.Is(got, sentinel) {
		t.Fatal(got)
	}
}

func TestSelectListPreservesPlatformSpecificTier(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	for _, tier := range []*bool{nil, ptr(false), ptr(true)} {
		selection, err := SelectList(id, id, ListRequest{PageRequest: model.PageRequest{Limit: 1}, CompatiblePlatform: ptr(model.PlatformMacOS), PlatformSpecific: tier})
		if err != nil || !model.EqualOptional(selection.Query.PlatformSpecific, tier) || !model.EqualOptional(selection.Scope.PlatformSpecific, tier) {
			t.Fatalf("tier lost: %#v %v", selection, err)
		}
	}
}
