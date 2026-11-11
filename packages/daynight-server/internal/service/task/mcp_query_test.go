package task_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestMCPListAuthorizationMaterializationAndFailures(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	visit := func(store.TaskPriorityItem, string, bool) bool { return true }
	request := taskcore.MCPListRequest{Limit: 2, View: "full"}
	for _, input := range []struct {
		principal model.Principal
		project   string
		request   taskcore.MCPListRequest
	}{
		{model.Principal{}, f.project.ID, request},
		{f.principal, "invalid", request},
		{f.principal, f.project.ID, taskcore.MCPListRequest{Limit: 101}},
	} {
		if err := f.tasks.MCPList(ctx, input.principal, input.project, input.request, visit); err == nil {
			t.Fatal("invalid list accepted")
		}
	}
	f.read(ctx)
	missing := "00000000-0000-4000-8000-000000000099"
	f.projectReader.ProjectAccessFn = func(actual context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		if actual != ctx || actor != f.principal || id != missing {
			t.Fatal("missing Project authorization changed")
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}
	if err := f.tasks.MCPList(ctx, f.principal, missing, request, visit); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Project cause: %v", err)
	}
	f.projectReader.ProjectAccessFn = func(actual context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		if actual != ctx || actor != f.principal || id != f.project.ID {
			t.Fatal("list authorization changed")
		}
		return taskMockAccess(f.project, f.principal), nil
	}
	first := f.target
	first.Description = "Complete description"
	second := ruleTask("a1111111-1111-4111-8111-111111111111", "Second")
	f.reader.TaskListFenceFn = func(actual context.Context, id string) (store.TaskListFence, error) {
		if actual != ctx || id != f.project.ID {
			t.Fatal("list fence changed snapshot identity")
		}
		return store.TaskListFence{Count: "2", VersionSum: "2"}, nil
	}
	f.reader.TaskPriorityListFn = func(actual context.Context, id string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
		if actual != ctx || id != f.project.ID || q.Limit != 2 || !q.ExcludeTerminal || q.After != nil {
			t.Fatalf("list query: %#v", q)
		}
		return store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: first}, {Task: second}}}, nil
	}
	fullReads := 0
	f.reader.TaskBodiesFn = func(actual context.Context, projectID string, ids []string) ([]model.Task, error) {
		fullReads++
		if actual != ctx || projectID != f.project.ID || !reflect.DeepEqual(ids, []string{first.ID, second.ID}) {
			t.Fatal("batch changed selected page")
		}
		return []model.Task{second, first}, nil
	}
	count := 0
	err := f.tasks.MCPList(ctx, f.principal, f.project.ID, request, func(item store.TaskPriorityItem, cursor string, more bool) bool {
		count++
		if !reflect.DeepEqual(item.Task, first) || cursor == "" || !more {
			t.Fatalf("full first item: %#v cursor=%q more=%v", item, cursor, more)
		}
		return false
	})
	if err != nil || count != 1 || fullReads != 1 {
		t.Fatalf("visitor stop: count=%d fullReads=%d err=%v", count, fullReads, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	defer cancel()
	f.read(cancelled)
	f.projectReader.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
		return taskMockAccess(f.project, f.principal), nil
	}
	f.reader.TaskListFenceFn = func(context.Context, string) (store.TaskListFence, error) {
		return store.TaskListFence{Count: "2", VersionSum: "2"}, nil
	}
	f.reader.TaskPriorityListFn = func(context.Context, string, store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
		return store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: first}}}, nil
	}
	f.reader.TaskBodiesFn = func(actual context.Context, projectID string, ids []string) ([]model.Task, error) {
		if actual != cancelled || projectID != f.project.ID || !reflect.DeepEqual(ids, []string{first.ID}) {
			t.Fatal("full materialization changed canceled scope")
		}
		cancel()
		return nil, actual.Err()
	}
	err = f.tasks.MCPList(cancelled, f.principal, f.project.ID, request, visit)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("full materialization cancellation lost: %v", err)
	}
	closed := errors.New("snapshot store closed")
	f.database.ReadSnapshotFn = func(context.Context, func(store.SnapshotScope) error) error { return closed }
	if err := f.tasks.MCPList(ctx, f.principal, f.project.ID, request, visit); !errors.Is(err, closed) {
		t.Fatalf("snapshot failure lost: %v", err)
	}
}

func TestMCPReadyCandidatesAndFullSnapshot(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	f.read(ctx)
	first := f.target
	first.Title, first.Description, first.AllowAgents = "First allowed", strings.Repeat("d", 16<<10), true
	first.RequiredPlatform = pointer(model.PlatformLinux)
	second := ruleTask("a1111111-1111-4111-8111-111111111111", "Second allowed")
	second.AllowAgents = true
	request := taskcore.MCPReadyRequest{Limit: 1, View: "full", AllowAgents: pointer(true), CompatiblePlatform: pointer(model.PlatformLinux)}
	queryCalls, fullReads := 0, 0
	f.reader.TaskPriorityListFn = func(actual context.Context, id string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
		queryCalls++
		if actual != ctx || id != f.project.ID || q.Limit != request.Limit || q.Status == nil || *q.Status != model.TaskTodo || q.Ready == nil || !*q.Ready || !reflect.DeepEqual(q.AllowAgents, request.AllowAgents) || !reflect.DeepEqual(q.CompatiblePlatform, request.CompatiblePlatform) || q.After != nil || q.ExcludeTerminal || q.AssignedTo.Mode != model.TaskAssignmentAll {
			t.Fatalf("ready selection: %#v", q)
		}
		summary := first
		summary.Description = ""
		items := []store.TaskPriorityItem{{Task: summary}}
		if q.Limit > 1 {
			items = append(items, store.TaskPriorityItem{Task: second})
		}
		return store.TaskPriorityPage{Items: items}, nil
	}
	f.reader.TaskBodiesFn = func(actual context.Context, projectID string, ids []string) ([]model.Task, error) {
		fullReads++
		if actual != ctx || projectID != f.project.ID {
			t.Fatal("full read changed selection snapshot")
		}
		if reflect.DeepEqual(ids, []string{first.ID}) {
			return []model.Task{first}, nil
		}
		if reflect.DeepEqual(ids, []string{first.ID, second.ID}) {
			return []model.Task{second, first}, nil
		}
		t.Fatalf("unselected tasks materialized: %v", ids)
		return nil, nil
	}
	items, err := f.tasks.MCPReady(ctx, f.principal, f.project.ID, request)
	if err != nil || len(items) != 1 || !reflect.DeepEqual(items[0].Task, first) || fullReads != 1 {
		t.Fatalf("first filtered full candidate: %#v %v reads=%d", items, err, fullReads)
	}
	request.Limit = 20
	items, err = f.tasks.MCPReady(ctx, f.principal, f.project.ID, request)
	if err != nil || len(items) != 2 || !reflect.DeepEqual(items[0].Task, first) || !reflect.DeepEqual(items[1].Task, second) || fullReads != 2 {
		t.Fatalf("ordered filtered candidates: %#v %v reads=%d", items, err, fullReads)
	}
	request.View = "summary"
	f.reader.TaskBodiesFn = nil
	items, err = f.tasks.MCPReady(ctx, f.principal, f.project.ID, request)
	if err != nil || len(items) != 2 || items[0].Task.Description != "" || !items[0].Task.Ready || queryCalls != 3 {
		t.Fatalf("bounded summary projections: %#v %v", items, err)
	}
}

func TestMCPReadyAuthorizationAndFailures(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	request := taskcore.MCPReadyRequest{Limit: 5, View: "full"}
	f.read(ctx)
	f.reader.TaskPriorityListFn = func(actual context.Context, id string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
		if actual != ctx || id != f.project.ID || q.Limit != 5 {
			t.Fatal("empty ready query changed")
		}
		return store.TaskPriorityPage{Items: []store.TaskPriorityItem{}}, nil
	}
	if items, err := f.tasks.MCPReady(ctx, f.principal, f.project.ID, request); err != nil || items == nil || len(items) != 0 {
		t.Fatalf("empty: %#v %v", items, err)
	}
	for _, input := range []struct {
		principal model.Principal
		project   string
		request   taskcore.MCPReadyRequest
	}{
		{model.Principal{}, f.project.ID, request},
		{f.principal, "invalid", request},
		{f.principal, f.project.ID, taskcore.MCPReadyRequest{Limit: 21, View: "full"}},
	} {
		if items, err := f.tasks.MCPReady(ctx, input.principal, input.project, input.request); err == nil || len(items) != 0 {
			t.Fatalf("invalid read returned candidates: %#v %v", items, err)
		}
	}
	f.projectReader.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
		return model.ProjectAccess{}, model.ErrNotFound
	}
	if items, err := f.tasks.MCPReady(ctx, f.principal, "00000000-0000-4000-8000-000000000099", request); !errors.Is(err, model.ErrNotFound) || len(items) != 0 {
		t.Fatalf("missing Project candidates: %#v %v", items, err)
	}
	for _, phase := range []string{"authorization", "selection", "full read"} {
		t.Run(phase, func(t *testing.T) {
			f := newTaskRuleFixture(t)
			cancelled, cancel := context.WithCancel(t.Context())
			defer cancel()
			f.read(cancelled)
			f.projectReader.ProjectAccessFn = func(actual context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
				if phase == "authorization" {
					cancel()
					return model.ProjectAccess{}, actual.Err()
				}
				return taskMockAccess(f.project, f.principal), nil
			}
			f.reader.TaskPriorityListFn = func(actual context.Context, id string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
				if phase == "selection" {
					cancel()
					return store.TaskPriorityPage{}, actual.Err()
				}
				return store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: f.target}}}, nil
			}
			f.reader.TaskBodiesFn = func(actual context.Context, projectID string, ids []string) ([]model.Task, error) {
				if actual != cancelled || projectID != f.project.ID || !reflect.DeepEqual(ids, []string{f.target.ID}) {
					t.Fatal("cancellation scope changed")
				}
				cancel()
				return nil, actual.Err()
			}
			items, err := f.tasks.MCPReady(cancelled, f.principal, f.project.ID, request)
			if !errors.Is(err, context.Canceled) || len(items) != 0 {
				t.Fatalf("%s cancellation lost: %#v %v", phase, items, err)
			}
		})
	}
	closed := errors.New("snapshot store closed")
	f.database.ReadSnapshotFn = func(context.Context, func(store.SnapshotScope) error) error { return closed }
	if items, err := f.tasks.MCPReady(ctx, f.principal, f.project.ID, request); !errors.Is(err, closed) || len(items) != 0 {
		t.Fatalf("snapshot failure returned candidates: %#v %v", items, err)
	}
}
