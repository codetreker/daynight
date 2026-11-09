package server

import (
	"context"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
)

const taskHTTPEpoch = "88888888-8888-4888-8888-888888888888"

func copyTaskHTTPPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func copyTaskHTTPSlice[T any](values []T) []T {
	if values == nil {
		return nil
	}
	result := make([]T, len(values))
	copy(result, values)
	return result
}

func copyTaskHTTPProperties(values model.TaskProperties) model.TaskProperties {
	if values == nil {
		return nil
	}
	result := make(model.TaskProperties, len(values))
	for name, raw := range values {
		result[name] = copyTaskHTTPSlice(raw)
	}
	return result
}

func copyTaskHTTPTask(row model.Task) model.Task {
	row.Properties = copyTaskHTTPProperties(row.Properties)
	row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
	row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
	row.BlockedBy = copyTaskHTTPSlice(row.BlockedBy)
	row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
	row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
	row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
	row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
	row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	return row
}

func copyTaskHTTPWrite(values store.TaskWrite) store.TaskWrite {
	values.Properties = copyTaskHTTPProperties(values.Properties)
	values.DependsOn = copyTaskHTTPSlice(values.DependsOn)
	values.ExternalDependsOn = copyTaskHTTPSlice(values.ExternalDependsOn)
	values.AssignedTo = copyTaskHTTPPointer(values.AssignedTo)
	values.RequiredPlatform = copyTaskHTTPPointer(values.RequiredPlatform)
	return values
}

func copyTaskHTTPRows(rows []model.Task) []model.Task {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		result[index] = copyTaskHTTPTask(rows[index])
	}
	return result
}

func copyTaskHTTPGraphRows(rows []model.GraphTask) []model.GraphTask {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
		row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
		row.BlockedBy = copyTaskHTTPSlice(row.BlockedBy)
		row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
		row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
		row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
		row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
		row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	}
	return result
}

func copyTaskHTTPSyncRows(rows []model.TaskViewRecord) []model.TaskViewRecord {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.Properties = copyTaskHTTPProperties(row.Properties)
		row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
		row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
		row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
		row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
		row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
		row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
		row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	}
	return result
}

func copyTaskHTTPAssigneeFacts(rows []model.TaskAssigneeFact) []model.TaskAssigneeFact {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.ProfileID = copyTaskHTTPPointer(row.ProfileID)
		row.Name = copyTaskHTTPPointer(row.Name)
		row.AvatarURL = copyTaskHTTPPointer(row.AvatarURL)
	}
	return result
}

type taskHTTPFixture struct {
	t         *testing.T
	store     *httpTestStore
	handler   *resourceTestHandler
	project   model.Project
	target    model.Task
	principal model.Principal
	observed  time.Time
	ctx       context.Context
	active    bool
}

func newTaskHTTPFixture(t *testing.T) *taskHTTPFixture {
	return newTaskHTTPFixtureForPrincipal(t, defaultHTTPPrincipal())
}

func newTaskHTTPFixtureForPrincipal(t *testing.T, principal model.Principal) *taskHTTPFixture {
	t.Helper()
	project, target, _ := taskHTTPMockModels()
	f := &taskHTTPFixture{t: t, store: newHTTPTestStoreForPrincipal(t, principal), project: project, target: target, principal: principal, observed: project.UpdatedAt.Add(time.Minute)}
	f.handler = resourceTestServerForPrincipal(t, f.store, attachmentTestFiles(t), io.Discard, principal)
	return f
}

func (f *taskHTTPFixture) require(ctx context.Context, projectID string) {
	f.t.Helper()
	if !f.active || ctx != f.ctx || projectID != f.project.ID {
		f.t.Errorf("DAO context, scope or Project changed: active=%t, project=%q", f.active, projectID)
		panic("invalid Task HTTP DAO scope")
	}
}

func (f *taskHTTPFixture) expectSnapshot(want map[string]int, configure func(*taskHTTPReaderMock, *taskHTTPProjectReaderMock, *taskHTTPSessionReaderMock, *taskHTTPSnapshotScopeMock, *httpCallPlan)) {
	f.t.Helper()
	counts := make(map[string]int, len(want)+2)
	for name, count := range want {
		counts[name] = count
	}
	counts["snapshot"], counts["access"] = 1, 1
	plan := newHTTPCallPlan(f.t, counts)
	base := newTaskHTTPMockBase(f.t, "Task HTTP snapshot")
	reader := &taskHTTPReaderMock{taskHTTPMockBase: base.withLabel("tasks")}
	projects := &taskHTTPProjectReaderMock{taskHTTPMockBase: base.withLabel("projects")}
	sessions := &taskHTTPSessionReaderMock{taskHTTPMockBase: base.withLabel("sessions")}
	scope := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: base.withLabel("scope")}
	projects.ProjectAccessFn = func(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
		f.require(ctx, id)
		plan.Called("access")
		if principal != f.principal {
			unexpectedHTTPCall(f.t, "ProjectAccess principal")
		}
		return taskHTTPMockAccess(f.project, principal), nil
	}
	if counts["project"] != 0 {
		projects.ProjectFn = func(ctx context.Context, id string) (model.Project, error) {
			f.require(ctx, id)
			plan.Called("project")
			return f.project, nil
		}
	}
	if counts["observed"] != 0 {
		scope.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			f.require(ctx, f.project.ID)
			plan.Called("observed")
			return f.observed, nil
		}
	}
	scope.ProjectDAOFn = func() store.ProjectReader { return projects }
	scope.TaskDAOFn = func() store.TaskReader { return reader }
	scope.SessionDAOFn = func() store.SessionReader { return sessions }
	configure(reader, projects, sessions, scope, plan)
	f.store.ReadSnapshotCall = func(ctx context.Context, run func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		if run == nil || f.active {
			unexpectedHTTPCall(f.t, "snapshot callback")
		}
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		return run(scope)
	}
}

func (f *taskHTTPFixture) expectRead(target model.Task) {
	f.t.Helper()
	target = copyTaskHTTPTask(target)
	f.expectSnapshot(map[string]int{"task": 1, "epoch": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		reader.TaskFn = func(ctx context.Context, projectID, id string) (model.Task, error) {
			f.require(ctx, projectID)
			plan.Called("task")
			if id != target.ID {
				unexpectedHTTPCall(f.t, "Task identity")
			}
			return copyTaskHTTPTask(target), nil
		}
		reader.TaskCacheEpochFn = func(ctx context.Context, projectID string) (string, error) {
			f.require(ctx, projectID)
			plan.Called("epoch")
			return taskHTTPEpoch, nil
		}
	})
}

func (f *taskHTTPFixture) expectList(want []store.TaskQuery, pages []store.TaskPage) {
	f.t.Helper()
	if len(want) != len(pages) || len(want) == 0 {
		f.t.Fatal("a Task HTTP page requires an explicit query and result for every DAO read")
	}
	want = copyTaskHTTPSlice(want)
	pages = copyTaskHTTPSlice(pages)
	for index := range want {
		query := &want[index]
		query.Page.After = copyTaskHTTPPointer(query.Page.After)
		query.Status = copyTaskHTTPPointer(query.Status)
		query.Ready = copyTaskHTTPPointer(query.Ready)
		query.AllowAgents = copyTaskHTTPPointer(query.AllowAgents)
		query.CompatiblePlatform = copyTaskHTTPPointer(query.CompatiblePlatform)
		query.Worker = copyTaskHTTPPointer(query.Worker)
		pages[index].Items = copyTaskHTTPRows(pages[index].Items)
	}
	f.expectSnapshot(map[string]int{"tasks": len(want)}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		index := 0
		reader.TasksFn = func(ctx context.Context, projectID string, query store.TaskQuery) (store.TaskPage, error) {
			f.require(ctx, projectID)
			plan.Called("tasks")
			if index >= len(want) || !reflect.DeepEqual(query, want[index]) {
				f.t.Errorf("Task query %d: got %#v, want %#v", index, query, want)
				panic("unexpected Task HTTP page query")
			}
			result := pages[index]
			result.Items = copyTaskHTTPRows(result.Items)
			index++
			return result, nil
		}
	})
}

func (f *taskHTTPFixture) expectGraph(root string, rows []model.GraphTask) {
	f.t.Helper()
	rows = copyTaskHTTPGraphRows(rows)
	f.expectSnapshot(map[string]int{"project": 1, "presence": 1, "graphSize": 1, "graph": 1, "observed": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, IncludeExternalEdges: true, LiveOnly: true}
		reader.TaskPresenceFn = func(ctx context.Context, projectID, id string) (store.TaskPresence, error) {
			f.require(ctx, projectID)
			plan.Called("presence")
			if id != root {
				unexpectedHTTPCall(f.t, "Graph root identity")
			}
			return store.TaskPresence{Found: true}, nil
		}
		reader.TaskGraphProjectionSizeFn = func(ctx context.Context, projectID, id string, got store.TaskGraphSelection) (store.TaskGraphSize, error) {
			f.require(ctx, projectID)
			plan.Called("graphSize")
			if id != root || got != selection {
				unexpectedHTTPCall(f.t, "Graph selection")
			}
			return store.TaskGraphSize{NodeCount: int64(len(rows))}, nil
		}
		reader.TaskGraphTasksFn = func(ctx context.Context, projectID, id string, got store.TaskGraphSelection, preview int) ([]model.GraphTask, error) {
			f.require(ctx, projectID)
			plan.Called("graph")
			if id != root || got != selection || preview != projection.TitlePreviewCharacters {
				unexpectedHTTPCall(f.t, "Graph projection arguments")
			}
			return copyTaskHTTPGraphRows(rows), nil
		}
	})
}

func (f *taskHTTPFixture) expectSync(rows []model.TaskViewRecord, facts []model.TaskAssigneeFact, lower *time.Time, size store.TaskGraphSize) {
	f.t.Helper()
	rows, facts, lower = copyTaskHTTPSyncRows(rows), copyTaskHTTPAssigneeFacts(facts), copyTaskHTTPPointer(lower)
	f.expectSnapshot(map[string]int{"project": 1, "epoch": 1, "graphSize": 1, "sync": 1, "people": 1, "observed": 1, "sessions": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, sessions *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		reader.TaskCacheEpochFn = func(ctx context.Context, id string) (string, error) {
			f.require(ctx, id)
			plan.Called("epoch")
			return taskHTTPEpoch, nil
		}
		reader.TaskGraphSizeFn = func(ctx context.Context, id string) (store.TaskGraphSize, error) {
			f.require(ctx, id)
			plan.Called("graphSize")
			return size, nil
		}
		reader.TaskSyncTasksFn = func(ctx context.Context, id string, since *time.Time, preview int) ([]model.TaskViewRecord, error) {
			f.require(ctx, id)
			plan.Called("sync")
			if !reflect.DeepEqual(since, lower) || preview != projection.TitlePreviewCharacters {
				unexpectedHTTPCall(f.t, "TaskSync arguments")
			}
			return copyTaskHTTPSyncRows(rows), nil
		}
		reader.TaskAssigneesFn = func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
			f.require(ctx, id)
			plan.Called("people")
			return copyTaskHTTPAssigneeFacts(facts), nil
		}
		sessions.CurrentTaskSessionSourcesFn = func(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
			f.require(ctx, id)
			plan.Called("sessions")
			return []store.TaskSessionSource{}, nil
		}
	})
}
