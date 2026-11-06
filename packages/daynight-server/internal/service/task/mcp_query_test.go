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
