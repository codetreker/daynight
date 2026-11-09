package task_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type taskReadFixture struct {
	t             *testing.T
	ctx           context.Context
	project       model.Project
	principal     model.Principal
	observed      time.Time
	base          taskMockBase
	store         *taskStoreMock
	snapshot      *taskSnapshotScopeMock
	projectReader *projectReaderMock
	reader        *taskReaderMock
	active        bool
	reads         int
}

func newTaskReadFixture(t *testing.T) *taskReadFixture {
	t.Helper()
	project, _, principal := taskMockModels()
	base := newTaskMockBase(t, "read store")
	f := &taskReadFixture{t: t, ctx: t.Context(), project: project, principal: principal, observed: project.UpdatedAt, base: base}
	f.projectReader = &projectReaderMock{taskMockBase: base.withLabel("project reader")}
	f.reader = &taskReaderMock{taskMockBase: base.withLabel("task reader")}
	f.snapshot = &taskSnapshotScopeMock{taskMockBase: base.withLabel("snapshot")}
	f.projectReader.ProjectAccessFn = func(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
		f.requireProject(ctx, id)
		if principal != f.principal {
			t.Fatalf("project access principal = %#v", principal)
		}
		return taskMockAccess(f.project, principal), nil
	}
	f.projectReader.ProjectFn = func(ctx context.Context, id string) (model.Project, error) {
		f.requireProject(ctx, id)
		return f.project, nil
	}
	f.snapshot.ProjectDAOFn = func() store.ProjectReader { f.requireActive(); return f.projectReader }
	f.snapshot.TaskDAOFn = func() store.TaskReader { f.requireActive(); return f.reader }
	f.snapshot.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		f.requireProject(ctx, f.project.ID)
		return f.observed, nil
	}
	f.store = &taskStoreMock{taskMockBase: base, ReadSnapshotFn: func(ctx context.Context, run func(store.SnapshotScope) error) error {
		if ctx != f.ctx || run == nil || f.active {
			t.Fatal("read did not enter one independent callback with its original context")
		}
		f.reads++
		f.active = true
		defer func() { f.active = false }()
		return run(f.snapshot)
	}}
	return f
}

func (f *taskReadFixture) requireActive() {
	f.t.Helper()
	if !f.active {
		f.t.Fatal("DAO escaped its snapshot callback")
	}
}
func (f *taskReadFixture) requireProject(ctx context.Context, id string) {
	f.t.Helper()
	f.requireActive()
	if ctx != f.ctx || id != f.project.ID {
		f.t.Fatalf("read context or Project identity changed: %s", id)
	}
}
func taskReadID(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }
