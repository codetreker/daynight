package task_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
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
	if _, err := steps.GetSummary(ctx, principal, project.ID, task.ID, "00abcdef"); err == nil {
		t.Fatal("corrupt item became a successful summary")
	}
}

func TestTaskStepsBoundedPagesAndVersionFence(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	parent := createTask(t, tasks, principal, project.ID, "Parent")
	steps := taskservice.NewTaskSteps(database)
	ctx := context.Background()
	longTitle := strings.Repeat("界", 600)
	for i, title := range []string{"First", longTitle, "Last"} {
		_, err := database.Pool.Exec(ctx, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,'todo',clock_timestamp(),clock_timestamp())`, parent.ID, fmt.Sprintf("%08x", i), i, title, strings.Repeat("x", 10000))
		if err != nil {
			t.Fatal(err)
		}
	}
	page, err := steps.ListPage(ctx, principal, project.ID, parent.ID, -1, 2, nil, true)
	if err != nil || len(page.Items) != 2 || !page.HasMore || page.Header.Version != parent.Version {
		t.Fatalf("first page: %+v %v", page, err)
	}
	if page.Items[0].Step.Description != "" || page.Items[0].TitleTruncated || !page.Items[1].TitleTruncated || utf8.RuneCountInString(page.Items[1].Step.Title) != 512 || page.Items[1].Step.Description != "" {
		t.Fatalf("summary projection was not bounded: %+v", page.Items)
	}
	version := page.Header.Version
	next, err := steps.ListPage(ctx, principal, project.ID, parent.ID, page.Items[1].Step.Position, 2, &version, false)
	if err != nil || len(next.Items) != 1 || next.HasMore || next.Items[0].Step.ID != "00000002" || len(next.Items[0].Step.Description) != 10000 {
		t.Fatalf("full next page: %+v %v", next, err)
	}
	single, err := steps.GetSummary(ctx, principal, project.ID, parent.ID, "00000001")
	if err != nil || single.Header.Version != version || !single.Item.TitleTruncated || single.Item.Step.Position != 1 || single.Item.Step.Description != "" {
		t.Fatalf("single summary: %+v %v", single, err)
	}
	_, err = steps.GetSummary(ctx, principal, project.ID, parent.ID, "ffffffff")
	var absence *tasksteps.StepAbsence
	if !errors.As(err, &absence) || absence.Version != version {
		t.Fatalf("missing step version: %v", err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET version=version+1 WHERE id=$1`, parent.ID); err != nil {
		t.Fatal(err)
	}
	_, err = steps.ListPage(ctx, principal, project.ID, parent.ID, 1, 2, &version, true)
	requireThreadFault(t, err, "version_conflict")
	for _, bounds := range [][2]int64{{-2, 1}, {-1, 0}, {-1, 101}} {
		_, err := steps.ListPage(ctx, principal, project.ID, parent.ID, bounds[0], int(bounds[1]), nil, true)
		requireThreadFault(t, err, "invalid_input")
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
	_, err = steps.GetSummary(ctx, model.Principal{}, project.ID, task.ID, "00000000")
	requireThreadFault(t, err, "unauthenticated")
	for _, id := range []string{"bad", "00000000-0000-4000-8000-000000000001"} {
		_, err := steps.Get(ctx, principal, project.ID, task.ID, id)
		requireThreadFault(t, err, "invalid_input")
		_, err = steps.GetSummary(ctx, principal, project.ID, task.ID, id)
		requireThreadFault(t, err, "invalid_input")
	}
	_, err = steps.Get(ctx, principal, project.ID, task.ID, "00000000")
	requireThreadFault(t, err, "not_found")
	if _, err := database.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	_, err = steps.List(ctx, principal, project.ID, task.ID)
	requireThreadFault(t, err, "task_deleted")
	_, err = steps.GetSummary(ctx, principal, project.ID, task.ID, "00000000")
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
	if _, err := steps.GetSummary(ctx, principal, project.ID, task.ID, "00000000"); err == nil {
		t.Fatal("summary storage failure concealed")
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
