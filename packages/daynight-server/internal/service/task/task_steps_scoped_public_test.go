package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type scopedStepPublicDB struct {
	store.SnapshotReader
	store.ProjectWriter
	t             *testing.T
	principal     model.Principal
	project, task string
	calls         int
}
type scopedStepPublicRead struct {
	store.SnapshotScope
	db *scopedStepPublicDB
}
type scopedStepPublicWrite struct {
	store.ProjectWriteScope
	db *scopedStepPublicDB
}
type scopedStepPublicProjectRead struct {
	store.ProjectReader
	db *scopedStepPublicDB
}
type scopedStepPublicProjectWrite struct {
	store.ProjectWriteDAO
	db *scopedStepPublicDB
}
type scopedStepPublicTaskRead struct {
	store.TaskReader
	db *scopedStepPublicDB
}
type scopedStepPublicTaskWrite struct {
	store.TaskWriteDAO
	db *scopedStepPublicDB
}

func (d *scopedStepPublicDB) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	return fn(scopedStepPublicRead{db: d})
}
func (d *scopedStepPublicDB) WriteProject(ctx context.Context, id string, fn func(store.ProjectWriteScope) error) (store.Completion, error) {
	if id != d.project {
		d.t.Fatal("project identity lost")
	}
	err := fn(scopedStepPublicWrite{db: d})
	return store.Completion{Outcome: store.TransactionNotCommitted}, err
}
func (s scopedStepPublicRead) ProjectDAO() store.ProjectReader {
	return scopedStepPublicProjectRead{db: s.db}
}
func (s scopedStepPublicRead) TaskDAO() store.TaskReader { return scopedStepPublicTaskRead{db: s.db} }
func (s scopedStepPublicWrite) ProjectDAO() store.ProjectWriteDAO {
	return scopedStepPublicProjectWrite{db: s.db}
}
func (s scopedStepPublicWrite) TaskDAO() store.TaskWriteDAO {
	return scopedStepPublicTaskWrite{db: s.db}
}
func (p scopedStepPublicProjectRead) ProjectAccess(_ context.Context, actor model.Principal, project string) (model.ProjectAccess, error) {
	if actor != p.db.principal || project != p.db.project {
		p.db.t.Fatal("read identity lost")
	}
	p.db.calls++
	return model.ProjectAccess{}, nil
}
func (p scopedStepPublicProjectWrite) ProjectAccess(_ context.Context, actor model.Principal) (model.ProjectAccess, error) {
	if actor != p.db.principal {
		p.db.t.Fatal("write identity lost")
	}
	p.db.calls++
	return model.ProjectAccess{}, nil
}
func (d scopedStepPublicTaskRead) TaskHeader(_ context.Context, project, task string) (model.TaskHeader, error) {
	if project != d.db.project || task != d.db.task {
		d.db.t.Fatal("read target lost")
	}
	return model.TaskHeader{ProjectID: project, ID: task, Version: 7}, nil
}
func (d scopedStepPublicTaskWrite) TaskHeader(_ context.Context, task string) (model.TaskHeader, error) {
	if task != d.db.task {
		d.db.t.Fatal("write target lost")
	}
	return model.TaskHeader{ProjectID: d.db.project, ID: task, Version: 7}, nil
}
func (d scopedStepPublicTaskRead) TaskSteps(_ context.Context, task string) ([]model.TaskStep, error) {
	if task != d.db.task {
		d.db.t.Fatal("list target lost")
	}
	return []model.TaskStep{stepReadValue("abcdef12", 0)}, nil
}
func (d scopedStepPublicTaskRead) TaskStep(_ context.Context, task, step string) (model.TaskStep, error) {
	if task != d.db.task || step != "abcdef12" {
		d.db.t.Fatal("item identity lost")
	}
	return stepReadValue(step, 0), nil
}
func (d scopedStepPublicTaskRead) TaskStepSummary(_ context.Context, task, step string) (store.TaskStepProjection, error) {
	if task != d.db.task || step != "abcdef12" {
		d.db.t.Fatal("summary identity lost")
	}
	return store.TaskStepProjection{Step: stepReadValue(step, 0)}, nil
}
func (d scopedStepPublicTaskRead) TaskStepPage(_ context.Context, task string, after int64, limit int, summary bool) ([]store.TaskStepProjection, error) {
	if task != d.db.task || after != 2 || limit != 4 || !summary {
		d.db.t.Fatal("page input lost")
	}
	return []store.TaskStepProjection{{Step: stepReadValue("abcdef12", 3)}}, nil
}

func TestScopedStepServicePublicOperations(t *testing.T) {
	_, _, p := stepReadModels()
	a := stepPolicy(t, p, "step:read")
	d := &scopedStepPublicDB{t: t, principal: a.Principal, project: stepReadHeader(1).ProjectID, task: stepReadHeader(1).ID}
	s := NewScopedTaskSteps(d)
	list, err := s.List(t.Context(), a, d.project, d.task)
	if err != nil || len(list.Resource.Steps) != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}
	item, err := s.Get(t.Context(), a, d.project, d.task, "abcdef12")
	if err != nil || item.Resource.Step.ID != "abcdef12" {
		t.Fatalf("get: %+v %v", item, err)
	}
	page, err := s.ListPage(t.Context(), a, d.project, d.task, 2, 3, stepWritePtr(int64(7)), true)
	if err != nil || len(page.Items) != 1 || page.Header.Version != 7 {
		t.Fatalf("page: %+v %v", page, err)
	}
	summary, err := s.GetSummary(t.Context(), a, d.project, d.task, "abcdef12")
	if err != nil || summary.Item.Step.ID != "abcdef12" {
		t.Fatalf("summary: %+v %v", summary, err)
	}
	for _, name := range []string{"add", "update", "status", "move", "delete"} {
		var result StepsWriteResult
		switch name {
		case "add":
			result, err = s.Add(t.Context(), a, d.project, d.task, AddTaskStep{Version: 7, ID: "abcdef12", Title: "new"})
		case "update":
			result, err = s.Update(t.Context(), a, d.project, d.task, "abcdef12", UpdateTaskStep{Version: 7, Title: stepWritePtr("new")})
		case "status":
			result, err = s.SetStatus(t.Context(), a, d.project, d.task, "abcdef12", SetTaskStepStatus{Version: 7, Status: model.TaskStepDone})
		case "move":
			result, err = s.Move(t.Context(), a, d.project, d.task, "abcdef12", MoveTaskStep{Version: 7, Position: stepWritePtr("last")})
		case "delete":
			result, err = s.Delete(t.Context(), a, d.project, d.task, "abcdef12", DeleteTaskStep{Version: 7})
		}
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "insufficient_scope" || result.TransactionOutcome != store.TransactionNotCommitted {
			t.Fatalf("%s: %+v %v", name, result, err)
		}
	}
	if d.calls != 9 {
		t.Fatalf("project checks: %d", d.calls)
	}
}
