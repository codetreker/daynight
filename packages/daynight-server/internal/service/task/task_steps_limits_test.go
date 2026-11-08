package task_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskStepsTextLimitsOnAddAndChange(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	var writes atomic.Int64
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
		return strings.HasPrefix(sql, "INSERT INTO task_steps") || strings.HasPrefix(sql, "UPDATE task_steps") || strings.HasPrefix(sql, "UPDATE tasks SET version=version+1,updated_at=$3")
	}, start: func() { writes.Add(1) }})
	steps := taskservice.NewTaskSteps(traced.store)
	version := task.Version
	cases := []struct {
		name, title, description string
		valid                    bool
	}{
		{"title boundary multibyte", strings.Repeat("界", 341) + "x", "", true},
		{"title over multibyte", strings.Repeat("界", 341) + "xx", "", false},
		{"description boundary multibyte", "x", strings.Repeat("界", 21845) + "x", true},
		{"description over multibyte", "x", strings.Repeat("界", 21845) + "xx", false},
		{"escaped boundary", strings.Repeat("<", 1024), strings.Repeat("<", 65536), true},
		{"title over escaped", strings.Repeat("<", 1025), "", false},
		{"description over escaped", "x", strings.Repeat("<", 65537), false},
		{"empty description", "title", "", true},
		{"whitespace title", " \u0085\t", "", false},
		{"nul title", "x\x00", "", false},
		{"nul description", "x", "\x00", false},
		{"invalid title UTF-8", string([]byte{0xff}), "", false},
		{"invalid description UTF-8", "x", string([]byte{0xff}), false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, operation := range []string{"add", "change"} {
				before := stepsStoredState(t, database, task.ID, false)
				writes.Store(0)
				var result taskservice.StepsWriteResult
				var err error
				if operation == "add" {
					result, err = steps.Add(context.Background(), principal, project.ID, task.ID, taskservice.AddTaskStep{Version: version, ID: fmt.Sprintf("%08x", i+2), Title: tc.title, Description: tc.description})
				} else {
					result, err = steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: version, Title: &tc.title, Description: &tc.description})
				}
				if !tc.valid {
					requireThreadFault(t, err, "invalid_input")
					if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil || writes.Load() != 0 || before != stepsStoredState(t, database, task.ID, false) {
						t.Fatalf("%s refusal changed stored state or executed a write: %+v", operation, result)
					}
					continue
				}
				if err != nil || result.TransactionOutcome != store.TransactionCommitted || !result.Changed || result.Resource.Version != version+1 {
					t.Fatalf("%s boundary failed: %+v %v", operation, result, err)
				}
				version = result.Resource.Version
				var found bool
				for _, step := range result.Resource.Steps {
					if (operation == "add" && step.ID == fmt.Sprintf("%08x", i+2)) || (operation == "change" && step.ID == "00000000") {
						found = step.Title == tc.title && step.Description == tc.description
					}
				}
				if !found {
					t.Fatalf("%s did not retain the exact admitted text", operation)
				}
			}
		})
	}
}

func TestTaskStepsCollectionLimitRejectsLegalFieldsBeforeWrites(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	// Each description is legal on its own. The production JSON encoder expands
	// '<' to six bytes, so 170 rows fit while one more crosses 64 MiB.
	const count = 170
	body := strings.Repeat("<", 65536)
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 SELECT $1,lpad(to_hex(n),8,'0'),n,'x',CASE WHEN n=$3 THEN '' ELSE $2 END,'todo','2026-01-02T03:04:05.123456Z','2026-01-02T03:04:05.123456Z' FROM generate_series(0,$3) n`, task.ID, body, count); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	header := model.TaskHeader{ID: task.ID, ProjectID: project.ID, Version: task.Version}
	candidate := make([]model.TaskStep, count+1)
	for i := range candidate {
		candidate[i] = model.TaskStep{ID: fmt.Sprintf("%08x", i), Position: int64(i), Title: "x", Description: body, Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	}
	_, encoded, err := taskcodec.EncodeCollection(header, candidate[:count])
	if err != nil || len(encoded) >= taskcodec.MaxEncodedBytes {
		t.Fatalf("existing collection must fit actual codec: size=%d err=%v", len(encoded), err)
	}
	encoded = nil
	_, _, err = taskcodec.EncodeCollection(header, candidate)
	var limit *taskcodec.LimitError
	if !errors.As(err, &limit) || limit.EncodedBytes <= taskcodec.MaxEncodedBytes {
		t.Fatalf("candidate must exceed actual codec limit: %v", err)
	}
	var before, after string
	snapshot := func(dest *string) {
		t.Helper()
		err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('version',t.version,'updated',t.updated_at,
 'steps',(SELECT jsonb_agg(jsonb_build_array(id,position,title,md5(description),status,created_at,updated_at) ORDER BY position) FROM task_steps WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(dest)
		if err != nil {
			t.Fatal(err)
		}
	}
	snapshot(&before)
	var writes atomic.Int64
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool {
		return strings.HasPrefix(sql, "INSERT INTO task_steps") || strings.HasPrefix(sql, "UPDATE task_steps") || strings.HasPrefix(sql, "UPDATE tasks SET version=version+1,updated_at=$3")
	}, start: func() { writes.Add(1) }})
	steps := taskservice.NewTaskSteps(traced.store)
	for _, operation := range []string{"add", "change"} {
		var result taskservice.StepsWriteResult
		if operation == "add" {
			result, err = steps.Add(context.Background(), principal, project.ID, task.ID, taskservice.AddTaskStep{Version: task.Version, ID: fmt.Sprintf("%08x", count+1), Title: "x", Description: body})
		} else {
			result, err = steps.Update(context.Background(), principal, project.ID, task.ID, fmt.Sprintf("%08x", count), taskservice.UpdateTaskStep{Version: task.Version, Description: &body})
		}
		requireThreadFault(t, err, "steps_limit_exceeded")
		snapshot(&after)
		if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil || writes.Load() != 0 || before != after {
			t.Fatalf("%s collection refusal changed stored state or executed a write: %+v", operation, result)
		}
	}
}

func TestTaskStepsLegacyLongTextRemainsReadableAndMovable(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Parent")
	seedChangeSteps(t, database, task.ID)
	title, description := strings.Repeat("t", 1025), strings.Repeat("d", 65537)
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_steps SET title=$2,description=$3 WHERE task_id=$1 AND id='00000000'`, task.ID, title, description); err != nil {
		t.Fatal(err)
	}
	steps := taskservice.NewTaskSteps(database)
	read, err := steps.List(context.Background(), principal, project.ID, task.ID)
	if err != nil || len(read.Resource.Steps) != 2 || read.Resource.Steps[0].Title != title || read.Resource.Steps[0].Description != description {
		t.Fatalf("legacy content was not readable: %v", err)
	}
	moved, err := steps.Move(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.MoveTaskStep{Version: task.Version, After: pointer("abcdef01")})
	requireChangeCommitted(t, moved, err, true)
	if moved.Resource.Steps[1].Title != title || moved.Resource.Steps[1].Description != description {
		t.Fatal("move altered legacy content")
	}
	deleted, err := steps.Delete(context.Background(), principal, project.ID, task.ID, "abcdef01", taskservice.DeleteTaskStep{Version: moved.Resource.Version})
	requireChangeCommitted(t, deleted, err, true)
	if len(deleted.Resource.Steps) != 1 || deleted.Resource.Steps[0].Title != title || deleted.Resource.Steps[0].Description != description {
		t.Fatal("delete altered legacy content")
	}
	corrected, err := steps.Update(context.Background(), principal, project.ID, task.ID, "00000000", taskservice.UpdateTaskStep{Version: deleted.Resource.Version, Title: pointer("corrected"), Description: pointer("")})
	requireChangeCommitted(t, corrected, err, true)
	if corrected.Resource.Steps[0].Title != "corrected" || corrected.Resource.Steps[0].Description != "" {
		t.Fatal("could not correct legacy content")
	}
}
