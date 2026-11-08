package task_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

var moveStepIDs = []string{"00000000", "11111111", "abcdef01", "fedcba98"}

func moveStepRows() []model.TaskStep {
	result := make([]model.TaskStep, len(moveStepIDs))
	for index, id := range moveStepIDs {
		result[index] = model.TaskStep{ID: id, Position: int64(index), Title: "same", Description: "  # " + id + "\n<原值&>  ",
			Status:    []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index],
			CreatedAt: time.Date(2026, 1, 2+index, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 3+index, 4, 5, 6, 654321000, time.UTC)}
	}
	return result
}

func assertMoveResource(t *testing.T, actual, original taskcodec.StepsResource, order []string) {
	t.Helper()
	if len(actual.Steps) != len(order) || actual.ProjectID != original.ProjectID || actual.TaskID != original.TaskID {
		t.Fatal("move resource scope/count changed")
	}
	byID := make(map[string]taskcodec.Step, len(original.Steps))
	for _, step := range original.Steps {
		byID[step.ID] = step
	}
	for index, id := range order {
		if actual.Steps[index].ID != id || actual.Steps[index] != byID[id] {
			t.Fatalf("move changed a non-position field or wrong order at %d: %+v", index, actual.Steps[index])
		}
	}
}

func TestTaskStepsMovePreservesAllStepTimesAndParentPolicies(t *testing.T) {
	header := stepMutationHeader(1)
	originalRows := moveStepRows()
	original, _, err := taskcodec.EncodeCollection(header, originalRows)
	if err != nil {
		t.Fatal(err)
	}
	current := originalRows
	for index, tc := range []struct {
		target   string
		input    taskservice.MoveTaskStep
		from, to int64
		order    []string
	}{
		{moveStepIDs[0], taskservice.MoveTaskStep{After: pointer("ABCDEF01")}, 0, 2, []string{moveStepIDs[1], moveStepIDs[2], moveStepIDs[0], moveStepIDs[3]}},
		{"FEDCBA98", taskservice.MoveTaskStep{Before: pointer("ABCDEF01")}, 3, 1, []string{moveStepIDs[1], moveStepIDs[3], moveStepIDs[2], moveStepIDs[0]}},
		{"ABCDEF01", taskservice.MoveTaskStep{Position: pointer("first")}, 2, 0, []string{moveStepIDs[2], moveStepIDs[1], moveStepIDs[3], moveStepIDs[0]}},
		{"ABCDEF01", taskservice.MoveTaskStep{Position: pointer("last")}, 0, 3, []string{moveStepIDs[1], moveStepIDs[3], moveStepIDs[0], moveStepIDs[2]}},
	} {
		t.Run(tc.target+"/"+fmt.Sprint(index), func(t *testing.T) {
			header.Version = int64(index + 1)
			f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
			before := slices.Clone(current)
			at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
			f.Writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
				if ctx != f.Ctx {
					t.Fatal("move changed clock context")
				}
				return at, nil
			}
			f.Writer.MoveTaskStepFn = func(ctx context.Context, id, target string, from, to int64) error {
				if ctx != f.Ctx || id != header.ID || target != strings.ToLower(tc.target) || from != tc.from || to != tc.to {
					t.Fatal("move changed task-local target or final interval")
				}
				return nil
			}
			f.Writer.TouchTaskFn = func(ctx context.Context, id string, actual time.Time) error {
				if ctx != f.Ctx || id != header.ID || actual != at {
					t.Fatal("move changed parent touch identity/time")
				}
				return nil
			}
			post := header
			post.Version++
			f.ExpectCapture(post, func(fact protocol.Fact) {
				if fact.Type != protocol.StepUpdated || fact.Action != "moved" || fact.ProjectID != header.ProjectID || fact.TaskID != header.ID || fact.StepID != strings.ToLower(tc.target) || fact.TaskVersion != post.Version || fact.OccurredAt != at || fact.FromPosition == nil || *fact.FromPosition != tc.from || fact.ToPosition == nil || *fact.ToPosition != tc.to {
					t.Fatalf("move capture: %+v", fact)
				}
			})
			tc.input.Version = header.Version
			result, err := f.Steps.Move(f.Ctx, f.Principal, strings.ToUpper(header.ProjectID), strings.ToUpper(header.ID), tc.target, tc.input)
			requireChangeCommitted(t, result, err, true)
			if result.Resource.Version != post.Version {
				t.Fatal("move did not advance parent exactly once")
			}
			assertMoveResource(t, result.Resource, original, tc.order)
			if !reflect.DeepEqual(current, before) {
				t.Fatal("move mutated DAO-returned rows")
			}
			if actual := stepMutationCallTrace(f); !slices.Equal(actual, []string{"project.ProjectAccess", "task.TaskHeader", "task.TaskSteps", "task.ObservedAt", "task.MoveTaskStep", "task.TouchTask", "task.TaskHeader", "capture.CaptureBatch"}) {
				t.Fatalf("move consulted unrelated parent/execution state or changed write order: %v", actual)
			}
		})
		current = orderedMoveRows(t, originalRows, tc.order)
	}
}

func TestTaskStepsMoveNoOpBeforeExhaustionClockAndWrites(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		header := stepMutationHeader(version)
		current := moveStepRows()
		_, original, err := taskcodec.EncodeCollection(header, current)
		if err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			target string
			input  taskservice.MoveTaskStep
		}{
			{moveStepIDs[0], taskservice.MoveTaskStep{Position: pointer("first")}},
			{moveStepIDs[3], taskservice.MoveTaskStep{Position: pointer("last")}},
			{moveStepIDs[1], taskservice.MoveTaskStep{Before: pointer("ABCDEF01")}},
			{"ABCDEF01", taskservice.MoveTaskStep{After: &moveStepIDs[1]}},
		} {
			t.Run(fmt.Sprint(version)+"/"+tc.target, func(t *testing.T) {
				f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
				tc.input.Version = version
				result, err := f.Steps.Move(f.Ctx, f.Principal, header.ProjectID, header.ID, tc.target, tc.input)
				requireChangeCommitted(t, result, err, false)
				if !bytes.Equal(result.JSON, original) {
					t.Fatal("no-op changed full resource bytes")
				}
				if actual := stepMutationCallTrace(f); !slices.Equal(actual, []string{"project.ProjectAccess", "task.TaskHeader", "task.TaskSteps"}) {
					t.Fatalf("no-op sampled clock or reached write/capture: %v", actual)
				}
				stale := newStepWriteFixture(t, header, current, store.TransactionCommitted)
				stale.Writer.TaskStepsFn = nil
				tc.input.Version = version - 1
				_, err = stale.Steps.Move(stale.Ctx, stale.Principal, header.ProjectID, header.ID, tc.target, tc.input)
				requireThreadFault(t, err, "version_conflict")
			})
		}
		if version == math.MaxInt64 {
			for _, tc := range []struct {
				target, code string
				input        taskservice.MoveTaskStep
			}{
				{moveStepIDs[0], "version_exhausted", taskservice.MoveTaskStep{Position: pointer("last")}},
				{"ffffffff", "not_found", taskservice.MoveTaskStep{Before: pointer("eeeeeeee")}},
				{moveStepIDs[0], "not_found", taskservice.MoveTaskStep{Before: pointer("ffffffff")}},
			} {
				f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
				tc.input.Version = version
				result, err := f.Steps.Move(f.Ctx, f.Principal, header.ProjectID, header.ID, tc.target, tc.input)
				requireThreadFault(t, err, tc.code)
				if result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
					t.Fatal("refusal exposed unconfirmed move")
				}
			}
		}
	}
	for _, position := range []string{"first", "last"} {
		f := newStepWriteFixture(t, stepMutationHeader(1), moveStepRows()[:1], store.TransactionCommitted)
		result, err := f.Steps.Move(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, moveStepIDs[0], taskservice.MoveTaskStep{Version: 1, Position: &position})
		requireChangeCommitted(t, result, err, false)
	}
}

func TestTaskStepsMoveAdmissionPlacementAndTaskLocalErrors(t *testing.T) {
	header := stepMutationHeader(1)
	for _, input := range []taskservice.MoveTaskStep{
		{Version: 1}, {Version: 1, Before: pointer("bad")}, {Version: 1, After: pointer("bad")}, {Version: 1, Position: pointer("")}, {Version: 1, Position: pointer("FIRST")}, {Version: 1, Position: pointer("middle")},
		{Version: 1, Before: &moveStepIDs[1], After: &moveStepIDs[2]}, {Version: 1, Before: &moveStepIDs[1], Position: pointer("first")}, {Version: 1, After: &moveStepIDs[1], Position: pointer("last")},
	} {
		f := newStepWriteFixture(t, header, moveStepRows(), store.TransactionCommitted)
		f.Store.WriteProjectFn = nil
		_, err := f.Steps.Move(f.Ctx, f.Principal, header.ProjectID, header.ID, moveStepIDs[0], input)
		requireThreadFault(t, err, "invalid_input")
	}
	for _, tc := range []struct {
		name, project, task, target string
		version                     int64
	}{
		{"principal", header.ProjectID, header.ID, moveStepIDs[0], 1},
		{"project", "bad", header.ID, moveStepIDs[0], 1},
		{"task", header.ProjectID, "bad", moveStepIDs[0], 1},
		{"target", header.ProjectID, header.ID, "bad", 1},
		{"version", header.ProjectID, header.ID, moveStepIDs[0], 0},
	} {
		f := newStepWriteFixture(t, header, moveStepRows(), store.TransactionCommitted)
		f.Store.WriteProjectFn = nil
		principal := f.Principal
		code := "invalid_input"
		if tc.name == "principal" {
			principal = model.Principal{}
			code = "unauthenticated"
		}
		_, err := f.Steps.Move(f.Ctx, principal, tc.project, tc.task, tc.target, taskservice.MoveTaskStep{Version: tc.version, Position: pointer("first")})
		requireThreadFault(t, err, code)
	}
	for _, tc := range []struct {
		target, code string
		input        taskservice.MoveTaskStep
		absent       bool
	}{
		{"ffffffff", "not_found", taskservice.MoveTaskStep{Before: pointer("ffffffff")}, true},
		{moveStepIDs[0], "not_found", taskservice.MoveTaskStep{Before: pointer("ffffffff")}, false},
		{"abcdef01", "invalid_input", taskservice.MoveTaskStep{Before: pointer("ABCDEF01")}, false},
		{"abcdef01", "invalid_input", taskservice.MoveTaskStep{After: pointer("ABCDEF01")}, false},
	} {
		f := newStepWriteFixture(t, header, moveStepRows(), store.TransactionCommitted)
		tc.input.Version = 1
		_, err := f.Steps.Move(f.Ctx, f.Principal, header.ProjectID, header.ID, tc.target, tc.input)
		requireThreadFault(t, err, tc.code)
		var absence *tasksteps.StepAbsence
		if errors.As(err, &absence) != tc.absent || tc.absent && absence.Version != 1 {
			t.Fatal("missing anchor/target distinction or admitted version lost")
		}
	}
	f := newStepWriteFixture(t, header, moveStepRows(), store.TransactionCommitted)
	deleted := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	f.Header.DeletedAt = &deleted
	f.Writer.TaskStepsFn = nil
	_, err := f.Steps.Move(f.Ctx, f.Principal, header.ProjectID, header.ID, "ffffffff", taskservice.MoveTaskStep{Version: 99, Before: pointer("ffffffff")})
	requireThreadFault(t, err, "task_deleted")
}

func TestTaskStepsMoveQueryAndStoredCollectionFailuresStayInternal(t *testing.T) {
	for _, stage := range []string{"header", "rows", "collection", "writer", "project", "permission"} {
		t.Run(stage, func(t *testing.T) {
			f := newStepWriteFixture(t, stepMutationHeader(1), moveStepRows(), store.TransactionCommitted)
			sentinel := errors.New(stage + " storage failure")
			switch stage {
			case "header":
				f.Writer.TaskHeaderFn = func(context.Context, string) (model.TaskHeader, error) { return model.TaskHeader{}, sentinel }
				f.Writer.TaskStepsFn = nil
			case "rows":
				f.Writer.TaskStepsFn = func(context.Context, string) ([]model.TaskStep, error) { return nil, sentinel }
			case "collection":
				f.Current[2].Position = 9
			case "writer":
				f.Store.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
					return store.Completion{Outcome: store.TransactionNotCommitted}, sentinel
				}
			case "project":
				f.Store.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
					return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
				}
			case "permission":
				f.Project.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, model.ErrNotFound
				}
				f.Writer.TaskHeaderFn, f.Writer.TaskStepsFn = nil, nil
			}
			result, err := f.Steps.Move(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, moveStepIDs[0], taskservice.MoveTaskStep{Version: 1, Position: pointer("last")})
			if err == nil || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("storage/corrupt collection concealed")
			}
			if stage == "project" || stage == "permission" {
				requireThreadFault(t, err, "not_found")
				return
			}
			if stage != "collection" && !errors.Is(err, sentinel) {
				t.Fatal("storage cause replaced")
			}
			if _, pure := taskservice.TaskStepsFault(err); pure {
				t.Fatal("storage/corrupt collection became business refusal")
			}
		})
	}
}
