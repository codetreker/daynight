package task_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestMCPListAuthorizationMaterializationAndFailures(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	visit := func(store.TaskPriorityItem, string, bool) bool { return true }
	request := taskcore.MCPListRequest{Limit: 2, View: "full"}
	if err := tasks.MCPList(ctx, model.Principal{}, project.ID, request, visit); err == nil {
		t.Fatal("missing principal accepted")
	}
	if err := tasks.MCPList(ctx, principal, "invalid", request, visit); err == nil {
		t.Fatal("invalid project accepted")
	}
	if err := tasks.MCPList(ctx, principal, project.ID, taskcore.MCPListRequest{Limit: 101}, visit); err == nil {
		t.Fatal("invalid limit accepted")
	}
	if err := tasks.MCPList(ctx, principal, "00000000-0000-4000-8000-000000000099", request, visit); err == nil {
		t.Fatal("missing project accepted")
	}
	created, err := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "First", Description: "Complete description"})
	if err != nil {
		t.Fatal(err)
	}
	createTask(t, tasks, principal, project.ID, "Second")
	count := 0
	err = tasks.MCPList(ctx, principal, project.ID, request, func(item store.TaskPriorityItem, cursor string, more bool) bool {
		count++
		if item.Task.ID != created.ID || item.Task.Description != "Complete description" || cursor == "" || !more {
			t.Fatalf("full first item: %#v cursor=%q more=%v", item, cursor, more)
		}
		return false
	})
	if err != nil || count != 1 {
		t.Fatalf("visitor stop: count=%d err=%v", count, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	defer cancel()
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "t.title, t.description") },
		start: cancel,
	})
	err = traced.MCPList(cancelled, principal, project.ID, request, visit)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("full materialization cancellation lost: %v", err)
	}
	database.Close()
	if err := tasks.MCPList(ctx, principal, project.ID, request, visit); err == nil {
		t.Fatal("closed snapshot store accepted")
	}
}

func TestMCPReadyCandidatesAndFullSnapshot(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	dependency := createTask(t, tasks, principal, project.ID, "Incomplete dependency")
	createTask(t, tasks, principal, project.ID, "Blocked", dependency.ID)
	first, err := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "First allowed", Description: strings.Repeat("d", 16<<10), RequiredPlatform: pointer(model.PlatformLinux)})
	if err != nil {
		t.Fatal(err)
	}
	first = updateTask(t, tasks, principal, first, taskcore.UpdateTask{AllowAgents: pointer(true)})
	second := createTask(t, tasks, principal, project.ID, "Second allowed")
	second = updateTask(t, tasks, principal, second, taskcore.UpdateTask{AllowAgents: pointer(true)})
	windows, err := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "Windows only", RequiredPlatform: pointer(model.PlatformWindows)})
	if err != nil {
		t.Fatal(err)
	}
	updateTask(t, tasks, principal, windows, taskcore.UpdateTask{AllowAgents: pointer(true)})
	request := taskcore.MCPReadyRequest{Limit: 1, View: "full", AllowAgents: pointer(true), CompatiblePlatform: pointer(model.PlatformLinux)}
	items, err := tasks.MCPReady(ctx, principal, project.ID, request)
	if err != nil || len(items) != 1 || items[0].Task.ID != first.ID || items[0].Task.Description != first.Description {
		t.Fatalf("first filtered full candidate: %#v %v", items, err)
	}
	request.Limit = 20
	items, err = tasks.MCPReady(ctx, principal, project.ID, request)
	if err != nil || len(items) != 2 || items[0].Task.ID != first.ID || items[1].Task.ID != second.ID {
		t.Fatalf("ordered filtered candidates: %#v %v", items, err)
	}
	request.View = "summary"
	items, err = tasks.MCPReady(ctx, principal, project.ID, request)
	if err != nil || len(items) != 2 || items[0].Task.Description != "" || !items[0].Task.Ready {
		t.Fatalf("bounded summary projections: %#v %v", items, err)
	}
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool {
			return strings.Contains(sql, "FROM tasks t WHERE") && strings.Contains(sql, "left(t.title,513)")
		},
		end: func() {
			if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET description='Changed after selection',version=version+1 WHERE id=$1", first.ID); err != nil {
				t.Fatal(err)
			}
		},
	})
	request.View = "full"
	items, err = traced.MCPReady(ctx, principal, project.ID, request)
	if err != nil || len(items) != 2 || items[0].Task.Description != first.Description || items[0].Task.Version != first.Version {
		t.Fatalf("full read mixed snapshots: %#v %v", items, err)
	}
	fresh, err := tasks.Get(ctx, principal, project.ID, first.ID)
	if err != nil || fresh.Description != "Changed after selection" {
		t.Fatalf("concurrent update did not happen: %#v %v", fresh, err)
	}
}

func TestMCPReadyAuthorizationAndFailures(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	request := taskcore.MCPReadyRequest{Limit: 5, View: "full"}
	if items, err := tasks.MCPReady(ctx, principal, project.ID, request); err != nil || len(items) != 0 {
		t.Fatalf("empty: %#v %v", items, err)
	}
	for _, input := range []struct {
		principal model.Principal
		project   string
		request   taskcore.MCPReadyRequest
	}{
		{model.Principal{}, project.ID, request},
		{principal, "invalid", request},
		{principal, project.ID, taskcore.MCPReadyRequest{Limit: 21, View: "full"}},
		{principal, "00000000-0000-4000-8000-000000000099", request},
	} {
		if items, err := tasks.MCPReady(ctx, input.principal, input.project, input.request); err == nil || len(items) != 0 {
			t.Fatalf("invalid read returned candidates: %#v %v", items, err)
		}
	}
	createTask(t, tasks, principal, project.ID, "Ready")
	for _, fragment := range []string{"left(t.title,513)", "t.title, t.description", "FROM project_grants"} {
		cancelled, cancel := context.WithCancel(ctx)
		traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, start: cancel})
		items, err := traced.MCPReady(cancelled, principal, project.ID, request)
		cancel()
		if !errors.Is(err, context.Canceled) || len(items) != 0 {
			t.Fatalf("%s cancellation lost: %#v %v", fragment, items, err)
		}
	}
	database.Close()
	if items, err := tasks.MCPReady(ctx, principal, project.ID, request); err == nil || len(items) != 0 {
		t.Fatalf("closed snapshot store returned candidates: %#v %v", items, err)
	}
}
