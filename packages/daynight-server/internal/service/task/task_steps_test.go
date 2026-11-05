package task_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTaskStepsReadWithoutHydratingTaskPolicyAndPreserveParent(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	steps := taskservice.NewTaskSteps(database)
	ctx := context.Background()
	empty, err := steps.List(ctx, principal, project.ID, task.ID)
	if err != nil || empty.Resource.Steps == nil || len(empty.Resource.Steps) != 0 {
		t.Fatalf("empty: %+v %v", empty, err)
	}
	for _, query := range []string{
		`INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','invalid JSON')`,
		`INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'00abcdef',0,E'  \ufeff  ','# Markdown','skipped','2026-11-03T10:11:12.123456Z','2026-11-03T10:12:13Z')`,
		`UPDATE tasks SET status='done',version=9007199254740993 WHERE id=$1`,
	} {
		if _, err := database.Pool.Exec(ctx, query, task.ID); err != nil {
			t.Fatal(err)
		}
	}

	var before, after string
	if err := database.Pool.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, task.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	result, err := steps.List(ctx, principal, strings.ToUpper(project.ID), strings.ToUpper(task.ID))
	if err != nil || result.Resource.Version != 9007199254740993 || len(result.Resource.Steps) != 1 || result.Resource.Steps[0].ID != "00abcdef" {
		t.Fatalf("independent read: %+v %v", result.Resource, err)
	}
	single, err := steps.Get(ctx, principal, project.ID, task.ID, "00ABCDEF")
	if err != nil || single.Resource.Step != result.Resource.Steps[0] || single.Resource.Version != result.Resource.Version {
		t.Fatalf("single: %+v %v", single, err)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, task.ID).Scan(&after); err != nil || before != after {
		t.Fatalf("read changed parent: %v", err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE task_steps SET title=E'\u0085' WHERE task_id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := steps.List(ctx, principal, project.ID, task.ID); err == nil {
		t.Fatal("corrupt title became an empty/successful read")
	}
	if _, err := steps.Get(ctx, principal, project.ID, task.ID, "00abcdef"); err == nil {
		t.Fatal("corrupt item became successful")
	}
}

func TestTaskStepsAdmissionScopeAndFailures(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	steps := taskservice.NewTaskSteps(database)
	ctx := context.Background()
	for _, tc := range []struct {
		principal model.Principal
		projectID string
		taskID    string
		code      string
	}{
		{model.Principal{}, project.ID, task.ID, "unauthenticated"},
		{principal, "bad", task.ID, "invalid_input"},
		{principal, project.ID, "bad", "invalid_input"},
		{principal, uuid.NewString(), task.ID, "not_found"},
		{principal, project.ID, uuid.NewString(), "not_found"},
		{servicePrincipal(t, database), project.ID, task.ID, "not_found"},
	} {
		_, err := steps.List(ctx, tc.principal, tc.projectID, tc.taskID)
		requireThreadFault(t, err, tc.code)
	}
	_, err := steps.Get(ctx, model.Principal{}, project.ID, task.ID, "00000000")
	requireThreadFault(t, err, "unauthenticated")
	for _, id := range []string{"bad", "00000000-0000-4000-8000-000000000001"} {
		_, err := steps.Get(ctx, principal, project.ID, task.ID, id)
		requireThreadFault(t, err, "invalid_input")
	}
	_, err = steps.Get(ctx, principal, project.ID, task.ID, "00000000")
	requireThreadFault(t, err, "not_found")
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err = steps.List(ctx, principal, project.ID, task.ID)
	requireThreadFault(t, err, "task_deleted")
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=NULL WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `DROP TABLE task_steps`); err != nil {
		t.Fatal(err)
	}
	if _, err := steps.Get(ctx, principal, project.ID, task.ID, "00000000"); err == nil {
		t.Fatal("storage failure concealed")
	}
	if _, err := steps.List(ctx, principal, project.ID, task.ID); err == nil {
		t.Fatal("collection storage failure concealed")
	}
	database.Close()
	if _, err := steps.List(ctx, principal, project.ID, task.ID); err == nil {
		t.Fatal("snapshot failure concealed")
	}
}

func TestTaskStepsFaultDoesNotHideCleanupFailure(t *testing.T) {
	refusal := &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: model.ErrNotFound}
	wrapped := fmt.Errorf("read: %w", &store.Error{Phase: "snapshot", Cause: refusal})
	if actual, ok := taskservice.TaskStepsFault(wrapped); !ok || actual != refusal {
		t.Fatal("pure refusal lost")
	}
	if actual, ok := taskservice.TaskStepsFault(fmt.Errorf("snapshot: %w", errors.Join(model.ErrNotFound, wrapped))); !ok || actual != refusal {
		t.Fatal("store not-found marker hid a pure refusal")
	}
	cleanup := errors.New("cleanup failed")
	for _, err := range []error{nil, cleanup, model.ErrNotFound, fmt.Errorf("read: %w", errors.Join(refusal, cleanup))} {
		if _, ok := taskservice.TaskStepsFault(err); ok {
			t.Fatal("internal cleanup error downgraded")
		}
	}
	joined := errors.Join(refusal, cleanup)
	if !errors.Is(joined, cleanup) || !errors.Is(joined, model.ErrNotFound) {
		t.Fatal("error chain changed")
	}
}
