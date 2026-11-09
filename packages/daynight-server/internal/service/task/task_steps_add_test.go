package task_test

import (
	"context"
	"errors"
	"math"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func addServiceStep(t *testing.T, steps *taskservice.TaskSteps, principal model.Principal, task model.Task, input taskservice.AddTaskStep) taskservice.StepsWriteResult {
	t.Helper()
	result, err := steps.Add(t.Context(), principal, task.ProjectID, task.ID, input)
	requireChangeCommitted(t, result, err, true)
	return result
}

func expectAddedStep(t *testing.T, f *stepWriteFixture, expected model.TaskStep, observed time.Time) {
	t.Helper()
	calls := []string{}
	f.Writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		if ctx != f.Ctx {
			t.Fatal("clock context changed")
		}
		calls = append(calls, "clock")
		return observed, nil
	}
	f.Writer.InsertTaskStepFn = func(ctx context.Context, id string, step model.TaskStep) error {
		calls = append(calls, "insert")
		if ctx != f.Ctx || id != f.Header.ID || step != expected {
			t.Fatalf("insert changed candidate: %+v want %+v", step, expected)
		}
		return nil
	}
	f.Writer.TouchTaskFn = func(ctx context.Context, id string, at time.Time) error {
		calls = append(calls, "touch")
		if ctx != f.Ctx || id != f.Header.ID || at != observed {
			t.Fatal("parent and child did not share admitted clock")
		}
		return nil
	}
	post := f.Header
	post.Version++
	f.ExpectCapture(post, func(fact protocol.Fact) {
		calls = append(calls, "capture")
		if fact.ProjectID != f.Header.ProjectID || fact.TaskID != f.Header.ID || fact.TaskVersion != post.Version || fact.StepID != expected.ID || fact.Action != "created" || fact.OccurredAt != observed {
			t.Fatalf("capture changed source: %+v", fact)
		}
	})
	t.Cleanup(func() {
		if !slices.Equal(calls, []string{"clock", "insert", "touch", "capture"}) {
			t.Errorf("write order: %v", calls)
		}
	})
}

func TestTaskStepsAddUsesHeaderAndPreservesExistingContent(t *testing.T) {
	header := stepMutationHeader(1)
	firstAt := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	first := model.TaskStep{ID: "abcdef01", Position: 0, Title: "same", Status: model.TaskStepTodo, CreatedAt: firstAt, UpdatedAt: firstAt}
	firstFixture := newStepWriteFixture(t, header, []model.TaskStep{}, store.TransactionCommitted)
	expectAddedStep(t, firstFixture, first, firstAt)
	firstResult, err := firstFixture.Steps.Add(firstFixture.Ctx, firstFixture.Principal, header.ProjectID, header.ID, taskservice.AddTaskStep{Version: header.Version, ID: "ABCDEF01", Title: "same"})
	requireChangeCommitted(t, firstResult, err, true)
	if firstResult.Resource.Version != header.Version+1 || len(firstResult.Resource.Steps) != 1 || firstResult.Resource.Steps[0].ID != "abcdef01" || firstResult.Resource.Steps[0].Status != model.TaskStepTodo || firstResult.Resource.Steps[0].Description != "" {
		t.Fatalf("first Add defaults/canonical ID: %+v", firstResult.Resource)
	}
	header.Version++
	current := []model.TaskStep{first}
	before := slices.Clone(current)
	f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
	observed := firstAt.Add(time.Microsecond)
	expected := model.TaskStep{ID: "00000000", Position: 0, Title: "same", Description: "  # 原值\n<>&  ", Status: model.TaskStepSkipped, CreatedAt: observed, UpdatedAt: observed}
	expectAddedStep(t, f, expected, observed)
	result, err := f.Steps.Add(f.Ctx, f.Principal, header.ProjectID, header.ID, taskservice.AddTaskStep{Version: header.Version, ID: "00000000", Title: "same", Description: "  # 原值\n<>&  ", Status: pointer(model.TaskStepSkipped), Before: pointer("ABCDEF01")})
	requireChangeCommitted(t, result, err, true)
	if result.Resource.Version != header.Version+1 || len(result.Resource.Steps) != 2 || result.Resource.Steps[0].Status != model.TaskStepSkipped || result.Resource.Steps[0].CreatedAt != observed || result.Resource.Steps[0].UpdatedAt != observed || result.Resource.Steps[1] != firstResult.Resource.Steps[0] || !reflect.DeepEqual(current, before) {
		t.Fatalf("add changed parent revision or existing content: %+v", result.Resource)
	}
}

func TestTaskStepsAddAdmissionAndRefusalOrder(t *testing.T) {
	for _, tc := range []struct {
		version, actual int64
		id              string
		before          *string
		code            string
	}{
		{1, 2, "00000000", pointer("ffffffff"), "version_conflict"},
		{2, 2, "00000000", pointer("ffffffff"), "step_id_conflict"},
		{2, 2, "12345678", pointer("ffffffff"), "not_found"},
		{2, math.MaxInt64, "00000000", nil, "version_conflict"},
		{math.MaxInt64, math.MaxInt64, "00000000", nil, "step_id_conflict"},
		{math.MaxInt64, math.MaxInt64, "12345678", pointer("ffffffff"), "not_found"},
		{math.MaxInt64, math.MaxInt64, "12345678", nil, "version_exhausted"},
	} {
		t.Run(tc.code+"/"+tc.id, func(t *testing.T) {
			current := stepMutationRows()[:1]
			before := slices.Clone(current)
			f := newStepWriteFixture(t, stepMutationHeader(tc.actual), current, store.TransactionNotCommitted)
			result, err := f.Steps.Add(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, taskservice.AddTaskStep{Version: tc.version, ID: tc.id, Title: "x", Before: tc.before})
			requireThreadFault(t, err, tc.code)
			if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil || !reflect.DeepEqual(current, before) {
				t.Fatalf("refusal changed input or returned unconfirmed bytes: %+v", result)
			}
		})
	}
	for _, stage := range []string{"principal", "project ID", "task ID", "missing project", "missing task", "project access", "deleted task"} {
		t.Run(stage, func(t *testing.T) {
			f := newStepWriteFixture(t, stepMutationHeader(2), stepMutationRows()[:1], store.TransactionNotCommitted)
			principal, projectID, taskID, code := f.Principal, f.Header.ProjectID, f.Header.ID, "not_found"
			switch stage {
			case "principal":
				principal = model.Principal{}
				code = "unauthenticated"
				f.Store.WriteProjectFn = nil
			case "project ID":
				projectID = "bad"
				code = "invalid_input"
				f.Store.WriteProjectFn = nil
			case "task ID":
				taskID = "bad"
				code = "invalid_input"
				f.Store.WriteProjectFn = nil
			case "missing project":
				projectID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.Store.WriteProjectFn = func(ctx context.Context, id string, _ func(store.ProjectWriteScope) error) (store.Completion, error) {
					if ctx != f.Ctx || id != projectID {
						t.Fatal("missing Project scope changed")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
				}
			case "missing task":
				taskID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.Writer.TaskHeaderFn = func(ctx context.Context, id string) (model.TaskHeader, error) {
					if ctx != f.Ctx || id != taskID {
						t.Fatal("missing Task identity or context changed")
					}
					return model.TaskHeader{}, model.ErrNotFound
				}
			case "project access":
				principal.UserID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.Project.ProjectAccessFn = func(ctx context.Context, actual model.Principal) (model.ProjectAccess, error) {
					if ctx != f.Ctx || actual != principal {
						t.Fatal("inaccessible Project principal or context changed")
					}
					return model.ProjectAccess{}, model.ErrNotFound
				}
			case "deleted task":
				at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
				f.Header.DeletedAt = &at
				f.Header.Version = math.MaxInt64
				code = "task_deleted"
			}
			result, err := f.Steps.Add(f.Ctx, principal, projectID, taskID, taskservice.AddTaskStep{Version: 2, ID: "12345678", Title: "x"})
			requireThreadFault(t, err, code)
			if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil {
				t.Fatalf("invalid scope receipt: %+v", result)
			}
		})
	}
}

func TestTaskStepsAddInputAndStorageFailures(t *testing.T) {
	for _, input := range []taskservice.AddTaskStep{{Version: 0, ID: "00000000", Title: "x"}, {Version: 1, ID: "bad", Title: "x"}, {Version: 1, ID: "00000000", Title: "\u0085"}, {Version: 1, ID: "00000000", Title: "x", Description: "\x00"}, {Version: 1, ID: "00000000", Title: "x", Status: pointer(model.TaskStepStatus(""))}, {Version: 1, ID: "00000000", Title: "x", Before: pointer("00000001"), After: pointer("00000002")}, {Version: 1, ID: "00000000", Title: "x", Before: pointer("bad")}} {
		f := newStepWriteFixture(t, stepMutationHeader(1), nil, store.TransactionNotCommitted)
		f.Store.WriteProjectFn = nil
		result, err := f.Steps.Add(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, input)
		requireThreadFault(t, err, "invalid_input")
		if result.TransactionOutcome != store.TransactionNotCommitted || result.JSON != nil {
			t.Fatal("invalid input exposed bytes")
		}
	}
	current := stepMutationRows()[:1]
	current[0].Position = 2
	f := newStepWriteFixture(t, stepMutationHeader(2), current, store.TransactionNotCommitted)
	result, err := f.Steps.Add(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, taskservice.AddTaskStep{Version: 2, ID: "abcdef01", Title: "x"})
	if err == nil || result.JSON != nil {
		t.Fatal("corrupt collection was repaired or ignored")
	}
	if _, pure := taskservice.TaskStepsFault(err); pure {
		t.Fatal("corrupt collection became business refusal")
	}
	cause := errors.New("closed store")
	f.Store.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, cause
	}
	_, err = f.Steps.Add(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, taskservice.AddTaskStep{Version: 2, ID: "abcdef01", Title: "x"})
	if !errors.Is(err, cause) {
		t.Fatal("closed-store cause was lost")
	}
}

func TestTaskStepsFaultRejectsTypedCompletionFailures(t *testing.T) {
	refusal := &model.Fault{Code: "step_id_conflict", Message: "private business refusal"}
	for _, failure := range []*store.TransactionError{
		{Phase: "cleanup", Cause: refusal, Outcome: store.TransactionNotCommitted, CleanupFailed: true},
		{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
		{Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown},
	} {
		if _, pure := taskservice.TaskStepsFault(failure); pure {
			t.Fatal("transaction completion fault concealed")
		}
		if _, pure := taskservice.TaskStepsFault(&model.Fault{Code: "not_found", Message: "wrapped refusal", Cause: failure}); pure {
			t.Fatal("business wrapper concealed typed completion failure")
		}

	}
	failure := &store.TransactionError{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted}
	if actual, pure := taskservice.TaskStepsFault(failure); !pure || !reflect.DeepEqual(actual, refusal) {
		t.Fatal("confirmed pure refusal lost")
	}
}

func TestTaskStepsChildAbsenceKeepsIdentityAndCause(t *testing.T) {
	absence := &tasksteps.StepAbsence{Version: 9007199254740993, Cause: model.ErrNotFound}
	if absence.Error() != "step is currently absent" || !errors.Is(absence, model.ErrNotFound) {
		t.Fatal("child absence lost safe diagnostic or exact cause")
	}
}

func TestTaskStepsAddQueryFailuresRemainInternal(t *testing.T) {
	for _, stage := range []string{"header", "collection"} {
		t.Run(stage, func(t *testing.T) {
			f := newStepWriteFixture(t, stepMutationHeader(1), nil, store.TransactionNotCommitted)
			cause := errors.New(stage + " query failed")
			if stage == "header" {
				f.Writer.TaskHeaderFn = func(context.Context, string) (model.TaskHeader, error) { return model.TaskHeader{}, cause }
			} else {
				f.Writer.TaskStepsFn = func(context.Context, string) ([]model.TaskStep, error) { return nil, cause }
			}
			result, err := f.Steps.Add(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, taskservice.AddTaskStep{Version: 1, ID: "00000000", Title: "x"})
			if !errors.Is(err, cause) || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatalf("query failure concealed: %+v %v", result, err)
			}
			if _, pure := taskservice.TaskStepsFault(err); pure {
				t.Fatal("query failure became business refusal")
			}
		})
	}
}
