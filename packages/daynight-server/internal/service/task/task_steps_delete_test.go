package task_test

import (
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

func assertDeleteResource(t *testing.T, actual, original taskcodec.StepsResource, order []string) {
	t.Helper()
	if actual.Steps == nil || len(actual.Steps) != len(order) || actual.ProjectID != original.ProjectID || actual.TaskID != original.TaskID {
		t.Fatal("delete resource scope/count/empty representation changed")
	}
	byID := make(map[string]taskcodec.Step, len(original.Steps))
	for _, step := range original.Steps {
		byID[step.ID] = step
	}
	for index, id := range order {
		if actual.Steps[index].ID != id || actual.Steps[index] != byID[id] {
			t.Fatalf("delete changed survivor identity/content/time or order at %d", index)
		}
	}
}

func orderedMoveRows(t *testing.T, source []model.TaskStep, order []string) []model.TaskStep {
	t.Helper()
	result := make([]model.TaskStep, len(order))
	for position, id := range order {
		index := slices.IndexFunc(source, func(row model.TaskStep) bool { return row.ID == id })
		if index < 0 {
			t.Fatalf("expected order references missing fixture Step %s", id)
		}
		row := source[index]
		row.Position = int64(position)
		result[position] = row
	}
	return result
}

func stepMutationCallTrace(f *stepWriteFixture) []string {
	var result []string
	for _, call := range f.Writer.trace.snapshot() {
		if strings.HasPrefix(call, "task.") || call == "project.ProjectAccess" || call == "capture.CaptureBatch" {
			result = append(result, call)
		}
	}
	return result
}

func TestTaskStepsDeletePreservesSurvivorsParentAndExecutionPolicies(t *testing.T) {
	header := stepMutationHeader(1)
	originalRows := moveStepRows()
	original, _, err := taskcodec.EncodeCollection(header, originalRows)
	if err != nil {
		t.Fatal(err)
	}
	current := originalRows
	for index, tc := range []struct {
		target     string
		from, tail int64
		order      []string
	}{
		{"ABCDEF01", 2, 1, []string{moveStepIDs[0], moveStepIDs[1], moveStepIDs[3]}},
		{moveStepIDs[0], 0, 2, []string{moveStepIDs[1], moveStepIDs[3]}},
		{"FEDCBA98", 1, 0, []string{moveStepIDs[1]}},
		{moveStepIDs[1], 0, 0, []string{}},
	} {
		t.Run(tc.target, func(t *testing.T) {
			header.Version = int64(index + 1)
			f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
			before := slices.Clone(current)
			at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
			f.Writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
				if ctx != f.Ctx {
					t.Fatal("delete changed clock context")
				}
				return at, nil
			}
			f.Writer.DeleteTaskStepFn = func(ctx context.Context, id, stepID string, position, tail int64) error {
				if ctx != f.Ctx || id != header.ID || stepID != strings.ToLower(tc.target) || position != tc.from || tail != tc.tail {
					t.Fatal("delete changed task-local target or tail interval")
				}
				return nil
			}
			f.Writer.TouchTaskFn = func(ctx context.Context, id string, actual time.Time) error {
				if ctx != f.Ctx || id != header.ID || actual != at {
					t.Fatal("delete changed parent touch identity or time")
				}
				return nil
			}
			post := header
			post.Version++
			f.ExpectCapture(post, func(fact protocol.Fact) {
				if fact.Type != protocol.StepUpdated || fact.Action != "deleted" || fact.ProjectID != header.ProjectID || fact.TaskID != header.ID || fact.StepID != strings.ToLower(tc.target) || fact.TaskVersion != post.Version || fact.OccurredAt != at || fact.FromPosition != nil || fact.ToPosition != nil {
					t.Fatalf("delete capture: %+v", fact)
				}
			})
			result, err := f.Steps.Delete(f.Ctx, f.Principal, strings.ToUpper(header.ProjectID), strings.ToUpper(header.ID), tc.target, taskservice.DeleteTaskStep{Version: header.Version})
			requireChangeCommitted(t, result, err, true)
			if result.Resource.Version != post.Version {
				t.Fatal("delete did not advance parent exactly once")
			}
			assertDeleteResource(t, result.Resource, original, tc.order)
			if !reflect.DeepEqual(current, before) {
				t.Fatal("delete mutated DAO-returned rows")
			}
			if actual := stepMutationCallTrace(f); !slices.Equal(actual, []string{"project.ProjectAccess", "task.TaskHeader", "task.TaskSteps", "task.ObservedAt", "task.DeleteTaskStep", "task.TouchTask", "task.TaskHeader", "capture.CaptureBatch"}) {
				t.Fatalf("delete consulted unrelated parent/execution state or changed write order: %v", actual)
			}
		})
		current = orderedMoveRows(t, originalRows, tc.order)
	}
}

func TestTaskStepsDeleteMissingStaleExhaustionAndLocalIdentity(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		for _, tc := range []struct {
			name, id, code string
			inputVersion   int64
		}{
			{"stale missing target", "ffffffff", "version_conflict", version - 1},
			{"missing current target", "ffffffff", "not_found", version},
			{"exhausted current target", moveStepIDs[0], "version_exhausted", version},
		} {
			if tc.code == "version_exhausted" && version != math.MaxInt64 {
				continue
			}
			t.Run(tc.name+"/"+fmt.Sprint(version), func(t *testing.T) {
				f := newStepWriteFixture(t, stepMutationHeader(version), moveStepRows(), store.TransactionCommitted)
				if tc.code == "version_conflict" {
					f.Writer.TaskStepsFn = nil
				}
				result, err := f.Steps.Delete(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, tc.id, taskservice.DeleteTaskStep{Version: tc.inputVersion})
				requireThreadFault(t, err, tc.code)
				var absence *tasksteps.StepAbsence
				if tc.code == "not_found" && (!errors.As(err, &absence) || absence.Version != version) {
					t.Fatal("target absence lost admitted parent version")
				}
				if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil || result.Changed {
					t.Fatal("refusal exposed a mutation or unconfirmed response")
				}
			})
		}
	}
	f := newStepWriteFixture(t, stepMutationHeader(2), moveStepRows(), store.TransactionCommitted)
	deleted := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	f.Header.DeletedAt = &deleted
	f.Writer.TaskStepsFn = nil
	_, err := f.Steps.Delete(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "ffffffff", taskservice.DeleteTaskStep{Version: 1})
	requireThreadFault(t, err, "task_deleted")
}

func TestTaskStepsDeleteReleasesIdentityForANewRecord(t *testing.T) {
	header := stepMutationHeader(2)
	original := moveStepRows()
	current := orderedMoveRows(t, original, []string{moveStepIDs[0], moveStepIDs[1], moveStepIDs[3]})
	for _, version := range []int64{1, 2} {
		f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
		if version == 1 {
			f.Writer.TaskStepsFn = nil
		}
		_, err := f.Steps.Delete(f.Ctx, f.Principal, header.ProjectID, header.ID, "abcdef01", taskservice.DeleteTaskStep{Version: version})
		code := "not_found"
		if version == 1 {
			code = "version_conflict"
		}
		requireThreadFault(t, err, code)
	}
	f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
	at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	f.Writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		if ctx != f.Ctx {
			t.Fatal("recreated Step changed clock context")
		}
		return at, nil
	}
	f.Writer.InsertTaskStepFn = func(ctx context.Context, id string, row model.TaskStep) error {
		if ctx != f.Ctx || id != header.ID || row.ID != "abcdef01" || row.Position != 3 || row.Title != "New record" || row.Description != "" || row.Status != model.TaskStepTodo || row.CreatedAt != at || row.UpdatedAt != at {
			t.Fatalf("recreated Step reused stale data: %+v", row)
		}
		return nil
	}
	f.Writer.TouchTaskFn = func(ctx context.Context, id string, actual time.Time) error {
		if ctx != f.Ctx || id != header.ID || actual != at {
			t.Fatal("recreation changed parent touch")
		}
		return nil
	}
	post := header
	post.Version++
	f.ExpectCapture(post, func(fact protocol.Fact) {
		if fact.Action != "created" || fact.StepID != "abcdef01" || fact.TaskVersion != 3 || fact.TaskID != header.ID {
			t.Fatalf("recreation capture: %+v", fact)
		}
	})
	result, err := f.Steps.Add(f.Ctx, f.Principal, header.ProjectID, header.ID, taskservice.AddTaskStep{Version: 2, ID: "ABCDEF01", Title: "New record"})
	requireChangeCommitted(t, result, err, true)
	if result.Resource.Version != 3 || len(result.Resource.Steps) != 4 {
		t.Fatal("reused ID did not create an independent current record")
	}
	reference, _, err := taskcodec.EncodeCollection(header, original)
	if err != nil {
		t.Fatal(err)
	}
	fresh := result.Resource.Steps[3]
	if fresh.ID != "abcdef01" || fresh.Title != "New record" || fresh.Description != "" || fresh.Status != model.TaskStepTodo || fresh.CreatedAt != fresh.UpdatedAt || fresh.CreatedAt == reference.Steps[2].CreatedAt || fresh.UpdatedAt == reference.Steps[2].UpdatedAt {
		t.Fatal("reused ID restored old content/status/times")
	}
	for index, source := range []int{0, 1, 3} {
		if result.Resource.Steps[index] != reference.Steps[source] {
			t.Fatal("recreation changed a retained record")
		}
	}
}

func TestTaskStepsDeleteAdmissionAndStorageFailuresStayExplicit(t *testing.T) {
	header := stepMutationHeader(1)
	_, _, principal := taskMockModels()
	for _, tc := range []struct {
		name                  string
		principal             model.Principal
		project, task, target string
		version               int64
	}{
		{"unauthenticated", model.Principal{}, header.ProjectID, header.ID, moveStepIDs[0], 1},
		{"project identity", principal, "bad", header.ID, moveStepIDs[0], 1},
		{"task identity", principal, header.ProjectID, "bad", moveStepIDs[0], 1},
		{"step identity", principal, header.ProjectID, header.ID, "bad", 1},
		{"version", principal, header.ProjectID, header.ID, moveStepIDs[0], 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newStepWriteFixture(t, header, moveStepRows(), store.TransactionCommitted)
			f.Store.WriteProjectFn = nil
			_, err := f.Steps.Delete(f.Ctx, tc.principal, tc.project, tc.task, tc.target, taskservice.DeleteTaskStep{Version: tc.version})
			code := "invalid_input"
			if tc.name == "unauthenticated" {
				code = "unauthenticated"
			}
			requireThreadFault(t, err, code)
		})
	}
	for _, stage := range []string{"project", "task", "permission", "collection"} {
		t.Run(stage, func(t *testing.T) {
			f := newStepWriteFixture(t, header, moveStepRows(), store.TransactionCommitted)
			switch stage {
			case "project":
				f.Store.WriteProjectFn = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
					if ctx != f.Ctx || id != header.ProjectID || work == nil {
						t.Fatal("missing project changed writer request")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
				}
			case "task":
				f.Writer.TaskHeaderFn = func(ctx context.Context, id string) (model.TaskHeader, error) {
					if ctx != f.Ctx || id != header.ID {
						t.Fatal("missing parent changed lookup")
					}
					return model.TaskHeader{}, model.ErrNotFound
				}
				f.Writer.TaskStepsFn = nil
			case "permission":
				f.Project.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
					if ctx != f.Ctx || p != f.Principal {
						t.Fatal("permission rejection changed request")
					}
					return model.ProjectAccess{}, model.ErrNotFound
				}
				f.Writer.TaskHeaderFn, f.Writer.TaskStepsFn = nil, nil
			case "collection":
				f.Current[2].Position = 9
			}
			result, err := f.Steps.Delete(f.Ctx, f.Principal, header.ProjectID, header.ID, moveStepIDs[0], taskservice.DeleteTaskStep{Version: 1})
			if stage == "collection" {
				if err == nil {
					t.Fatal("corrupt collection became successful delete")
				}
				if _, pure := taskservice.TaskStepsFault(err); pure {
					t.Fatal("corrupt collection became business refusal")
				}
			} else {
				requireThreadFault(t, err, "not_found")
			}
			if result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("admission/storage failure exposed response bytes")
			}
		})
	}
}

func TestTaskStepsDeleteQueryFailuresRemainInternal(t *testing.T) {
	for _, stage := range []string{"header", "rows", "writer"} {
		t.Run(stage, func(t *testing.T) {
			f := newStepWriteFixture(t, stepMutationHeader(1), moveStepRows(), store.TransactionCommitted)
			sentinel := errors.New(stage + " storage failure")
			switch stage {
			case "header":
				f.Writer.TaskHeaderFn = func(context.Context, string) (model.TaskHeader, error) { return model.TaskHeader{}, sentinel }
				f.Writer.TaskStepsFn = nil
			case "rows":
				f.Writer.TaskStepsFn = func(context.Context, string) ([]model.TaskStep, error) { return nil, sentinel }
			case "writer":
				f.Store.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
					return store.Completion{Outcome: store.TransactionNotCommitted}, sentinel
				}
			}
			result, err := f.Steps.Delete(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, moveStepIDs[0], taskservice.DeleteTaskStep{Version: 1})
			if !errors.Is(err, sentinel) || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("storage failure or original cause was concealed")
			}
			if _, pure := taskservice.TaskStepsFault(err); pure {
				t.Fatal("storage failure became business refusal")
			}
		})
	}
}
