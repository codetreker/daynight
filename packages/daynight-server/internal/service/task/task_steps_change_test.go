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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type stepWriteCapture struct {
	taskMockBase
	CaptureBatchFn func(context.Context, store.WebhookCaptureDAO, []protocol.Fact) error
}

func (capture *stepWriteCapture) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	capture.need("CaptureBatch", capture.CaptureBatchFn != nil)
	return capture.CaptureBatchFn(ctx, dao, facts)
}

type stepWriteFixture struct {
	T         *testing.T
	Ctx       context.Context
	Principal model.Principal
	Header    model.TaskHeader
	Current   []model.TaskStep
	Writer    *taskWriterMock
	Project   *projectWriterMock
	Scope     *taskProjectScopeMock
	Store     *taskStoreMock
	Capture   *stepWriteCapture
	Steps     *taskservice.TaskSteps
}

func newStepWriteFixture(t *testing.T, header model.TaskHeader, current []model.TaskStep, outcome store.TransactionOutcome) *stepWriteFixture {
	t.Helper()
	base := newTaskMockBase(t, "steps")
	f := &stepWriteFixture{T: t, Ctx: t.Context(), Header: header, Current: current,
		Principal: model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}}
	f.Writer = &taskWriterMock{taskMockBase: base.withLabel("task")}
	f.Project = &projectWriterMock{taskMockBase: base.withLabel("project")}
	f.Scope = &taskProjectScopeMock{taskMockBase: base.withLabel("scope")}
	f.Store = &taskStoreMock{taskMockBase: base.withLabel("store")}
	f.Capture = &stepWriteCapture{taskMockBase: base.withLabel("capture")}
	f.Scope.ProjectDAOFn = func() store.ProjectWriteDAO { return f.Project }
	f.Scope.TaskDAOFn = func() store.TaskWriteDAO { return f.Writer }
	f.Project.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
		if ctx != f.Ctx || p != f.Principal {
			t.Fatal("Step write changed authorization context or principal")
		}
		return model.ProjectAccess{ProjectID: f.Header.ProjectID, UserID: p.UserID, Role: model.ProjectMemberRole}, nil
	}
	f.Writer.TaskHeaderFn = func(ctx context.Context, id string) (model.TaskHeader, error) {
		if ctx != f.Ctx || id != f.Header.ID {
			t.Fatal("Step write changed parent identity or context")
		}
		return f.Header, nil
	}
	f.Writer.TaskStepsFn = func(ctx context.Context, id string) ([]model.TaskStep, error) {
		if ctx != f.Ctx || id != f.Header.ID {
			t.Fatal("Step write changed collection identity or context")
		}
		return f.Current, nil
	}
	f.Store.WriteProjectFn = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		if ctx != f.Ctx || id != f.Header.ProjectID || work == nil {
			t.Fatal("Step write changed Project scope or context")
		}
		if err := work(f.Scope); err != nil {
			failure := &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionNotCommitted}
			return store.Completion{Outcome: store.TransactionNotCommitted}, failure
		}
		return store.Completion{Outcome: outcome}, nil
	}
	f.Steps = taskservice.NewTaskSteps(f.Store, f.Capture)
	return f
}

func stepMutationHeader(version int64) model.TaskHeader {
	return model.TaskHeader{ProjectID: "22222222-2222-4222-8222-222222222222", ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: version}
}

func stepMutationRows() []model.TaskStep {
	return []model.TaskStep{
		{ID: "00000000", Position: 0, Title: "same", Description: "original body", Status: model.TaskStepTodo, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 3, 4, 5, 6, 654321000, time.UTC)},
		{ID: "abcdef01", Position: 1, Title: "same", Description: "other body", Status: model.TaskStepInProgress, CreatedAt: time.Date(2026, 1, 3, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 4, 4, 5, 6, 654321000, time.UTC)},
	}
}

func (f *stepWriteFixture) ExpectCapture(post model.TaskHeader, check func(protocol.Fact)) {
	f.T.Helper()
	headerCalls, captures := 0, 0
	f.Writer.TaskHeaderFn = func(ctx context.Context, id string) (model.TaskHeader, error) {
		if ctx != f.Ctx || id != f.Header.ID {
			f.T.Fatal("Step capture changed parent identity or context")
		}
		headerCalls++
		switch headerCalls {
		case 1:
			return f.Header, nil
		case 2:
			return post, nil
		default:
			f.T.Fatal("Step write unexpectedly reread its parent")
			panic("unexpected parent read")
		}
	}
	dao := &captureDAOMock{taskMockBase: f.Writer.taskMockBase.withLabel("captureDAO")}
	f.Scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return dao }
	f.Capture.CaptureBatchFn = func(ctx context.Context, actual store.WebhookCaptureDAO, facts []protocol.Fact) error {
		if ctx != f.Ctx || actual != dao || len(facts) != 1 {
			f.T.Fatal("Step write changed captured scope, context or fact count")
		}
		captures++
		check(facts[0])
		return nil
	}
	f.T.Cleanup(func() {
		if headerCalls != 2 || captures != 1 {
			f.T.Errorf("Step write capture calls: headers=%d captures=%d", headerCalls, captures)
		}
	})
}

func requireChangeCommitted(t *testing.T, result taskservice.StepsWriteResult, err error, changed bool) {
	t.Helper()
	if err != nil || result.Changed != changed || result.TransactionOutcome != store.TransactionCommitted || result.Phase != "commit" || result.CleanupFailed || len(result.JSON) == 0 {
		t.Fatalf("change receipt: %+v %v", result, err)
	}
}

func expectChangedStep(t *testing.T, f *stepWriteFixture, expected model.TaskStep, observed time.Time, factCheck func(protocol.Fact)) {
	t.Helper()
	calls := []string{}
	f.Writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		if ctx != f.Ctx {
			t.Fatal("changed Step clock context changed")
		}
		calls = append(calls, "clock")
		return observed, nil
	}
	f.Writer.UpdateTaskStepFn = func(ctx context.Context, id string, actual model.TaskStep) error {
		calls = append(calls, "update")
		if ctx != f.Ctx || id != f.Header.ID || actual != expected {
			t.Fatalf("changed Step parameters: %+v want %+v", actual, expected)
		}
		return nil
	}
	f.Writer.TouchTaskFn = func(ctx context.Context, id string, at time.Time) error {
		calls = append(calls, "touch")
		if ctx != f.Ctx || id != f.Header.ID || at != observed {
			t.Fatal("changed Step and parent clock differed")
		}
		return nil
	}
	post := f.Header
	post.Version++
	f.ExpectCapture(post, func(fact protocol.Fact) { calls = append(calls, "capture"); factCheck(fact) })
	t.Cleanup(func() {
		if !slices.Equal(calls, []string{"clock", "update", "touch", "capture"}) {
			t.Errorf("changed Step call order: %v", calls)
		}
	})
}

func TestTaskStepsChangeNoOpPreservesAllBytesBeforeClockAndWrites(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			header := stepMutationHeader(version)
			current := stepMutationRows()
			before := slices.Clone(current)
			_, document, err := taskcodec.EncodeCollection(header, current)
			if err != nil {
				t.Fatal(err)
			}
			for _, kind := range []string{"title", "description", "paired", "status"} {
				f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
				var result taskservice.StepsWriteResult
				if kind == "status" {
					result, err = f.Steps.SetStatus(f.Ctx, f.Principal, header.ProjectID, header.ID, "00000000", taskservice.SetTaskStepStatus{Version: version, Status: model.TaskStepTodo})
				} else {
					input := taskservice.UpdateTaskStep{Version: version}
					if kind != "description" {
						input.Title = pointer("same")
					}
					if kind != "title" {
						input.Description = pointer("original body")
					}
					result, err = f.Steps.Update(f.Ctx, f.Principal, header.ProjectID, header.ID, "00000000", input)
				}
				requireChangeCommitted(t, result, err, false)
				if !bytes.Equal(result.JSON, document) || !reflect.DeepEqual(current, before) {
					t.Fatal("no-op changed resource or source collection")
				}
			}
			for _, status := range []bool{false, true} {
				f := newStepWriteFixture(t, header, current, store.TransactionNotCommitted)
				f.Writer.TaskStepsFn = nil
				if status {
					_, err = f.Steps.SetStatus(f.Ctx, f.Principal, header.ProjectID, header.ID, "00000000", taskservice.SetTaskStepStatus{Version: version - 1, Status: model.TaskStepTodo})
				} else {
					_, err = f.Steps.Update(f.Ctx, f.Principal, header.ProjectID, header.ID, "00000000", taskservice.UpdateTaskStep{Version: version - 1, Title: pointer("same")})
				}
				requireThreadFault(t, err, "version_conflict")
			}
			if version == math.MaxInt64 {
				for _, kind := range []string{"title", "status", "missing"} {
					f := newStepWriteFixture(t, header, current, store.TransactionNotCommitted)
					if kind == "status" {
						_, err = f.Steps.SetStatus(f.Ctx, f.Principal, header.ProjectID, header.ID, "00000000", taskservice.SetTaskStepStatus{Version: version, Status: model.TaskStepDone})
					} else {
						id := "00000000"
						if kind == "missing" {
							id = "ffffffff"
						}
						_, err = f.Steps.Update(f.Ctx, f.Principal, header.ProjectID, header.ID, id, taskservice.UpdateTaskStep{Version: version, Title: pointer("changed")})
					}
					code := "version_exhausted"
					if kind == "missing" {
						code = "not_found"
					}
					requireThreadFault(t, err, code)
				}
			}
			if !reflect.DeepEqual(current, before) {
				t.Fatal("refusal altered source rows")
			}
		})
	}
}

func TestTaskStepsChangeUsesHeaderAndPreservesOtherRows(t *testing.T) {
	header := stepMutationHeader(1)
	current := stepMutationRows()
	original := slices.Clone(current)
	originalDocument, _, err := taskcodec.EncodeCollection(header, original)
	if err != nil {
		t.Fatal(err)
	}
	title, description := "  <原值&> 😀 \uFEFF  ", "  # Markdown\n\"\\\u2028\u2029  "
	observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	expected := current[0]
	expected.Title, expected.Description, expected.UpdatedAt = title, description, observed
	f := newStepWriteFixture(t, header, current, store.TransactionCommitted)
	expectChangedStep(t, f, expected, observed, func(fact protocol.Fact) {
		if fact.TaskVersion != header.Version+1 || fact.Action != "updated" || !slices.Equal(fact.ChangedFields, []string{"description", "title"}) || fact.OccurredAt != observed {
			t.Fatalf("paired change fact: %+v", fact)
		}
	})
	result, err := f.Steps.Update(f.Ctx, f.Principal, strings.ToUpper(header.ProjectID), strings.ToUpper(header.ID), "00000000", taskservice.UpdateTaskStep{Version: header.Version, Title: &title, Description: &description})
	requireChangeCommitted(t, result, err, true)
	target := result.Resource.Steps[0]
	if target.Title != title || target.Description != description || target.CreatedAt != original[0].CreatedAt || target.UpdatedAt != observed || result.Resource.Steps[1] != originalDocument.Steps[1] || result.Resource.Version != header.Version+1 || !reflect.DeepEqual(current, original) {
		t.Fatal("paired change changed unrelated fields or source rows")
	}
	for _, status := range []model.TaskStepStatus{model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped, model.TaskStepTodo} {
		previous := expected
		header.Version++
		rows := []model.TaskStep{previous, original[1]}
		observed = observed.Add(time.Microsecond)
		expected.Status, expected.UpdatedAt = status, observed
		f := newStepWriteFixture(t, header, rows, store.TransactionCommitted)
		expectChangedStep(t, f, expected, observed, func(fact protocol.Fact) {
			if fact.Action != "status_changed" || fact.PreviousStatus != string(previous.Status) || fact.Status != string(status) || fact.TaskVersion != header.Version+1 {
				t.Fatalf("status change fact: %+v", fact)
			}
		})
		result, err = f.Steps.SetStatus(f.Ctx, f.Principal, header.ProjectID, header.ID, "00000000", taskservice.SetTaskStepStatus{Version: header.Version, Status: status})
		requireChangeCommitted(t, result, err, true)
		got := result.Resource.Steps[0]
		if result.Resource.Version != header.Version+1 || got.Status != status || got.Title != title || got.Description != description || got.CreatedAt != original[0].CreatedAt || got.UpdatedAt != observed || result.Resource.Steps[1] != originalDocument.Steps[1] || !reflect.DeepEqual(rows, []model.TaskStep{previous, original[1]}) {
			t.Fatal("status change changed omitted content or other row")
		}
	}
	header.Version++
	previous := expected
	rows := []model.TaskStep{previous, original[1]}
	observed = observed.Add(time.Microsecond)
	expected.Description, expected.UpdatedAt = "", observed
	f = newStepWriteFixture(t, header, rows, store.TransactionCommitted)
	expectChangedStep(t, f, expected, observed, func(fact protocol.Fact) {
		if !slices.Equal(fact.ChangedFields, []string{"description"}) {
			t.Fatalf("clear fact: %+v", fact)
		}
	})
	result, err = f.Steps.Update(f.Ctx, f.Principal, header.ProjectID, header.ID, "00000000", taskservice.UpdateTaskStep{Version: header.Version, Description: pointer("")})
	requireChangeCommitted(t, result, err, true)
	if result.Resource.Steps[0].Description != "" || result.Resource.Steps[0].Title != title || result.Resource.Steps[0].CreatedAt != original[0].CreatedAt || result.Resource.Steps[0].UpdatedAt != observed || result.Resource.Steps[1] != originalDocument.Steps[1] || !reflect.DeepEqual(rows, []model.TaskStep{previous, original[1]}) {
		t.Fatal("clear altered omitted title")
	}
}

func TestTaskStepsChangeAdmissionInputAndStorageFailures(t *testing.T) {
	for _, input := range []taskservice.UpdateTaskStep{{Version: 1}, {Version: 1, Title: pointer("\u0085")}, {Version: 1, Title: pointer("\x00")}, {Version: 1, Title: pointer(string([]byte{0xff}))}, {Version: 1, Description: pointer("\x00")}, {Version: 1, Description: pointer(string([]byte{0xff}))}} {
		f := newStepWriteFixture(t, stepMutationHeader(1), stepMutationRows(), store.TransactionNotCommitted)
		f.Store.WriteProjectFn = nil
		_, err := f.Steps.Update(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000", input)
		requireThreadFault(t, err, "invalid_input")
	}
	f := newStepWriteFixture(t, stepMutationHeader(1), stepMutationRows(), store.TransactionNotCommitted)
	f.Store.WriteProjectFn = nil
	_, err := f.Steps.SetStatus(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000", taskservice.SetTaskStepStatus{Version: 1, Status: "invalid"})
	requireThreadFault(t, err, "invalid_input")
	for _, stage := range []string{"principal", "project ID", "task ID", "step ID", "version", "missing project", "missing task", "project access", "missing step", "deleted task"} {
		t.Run(stage, func(t *testing.T) {
			f := newStepWriteFixture(t, stepMutationHeader(1), stepMutationRows(), store.TransactionNotCommitted)
			principal, projectID, taskID, stepID, version, code := f.Principal, f.Header.ProjectID, f.Header.ID, "00000000", int64(1), "not_found"
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
			case "step ID":
				stepID = "bad"
				code = "invalid_input"
				f.Store.WriteProjectFn = nil
			case "version":
				version = 0
				code = "invalid_input"
				f.Store.WriteProjectFn = nil
			case "missing project":
				projectID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.Store.WriteProjectFn = func(ctx context.Context, id string, _ func(store.ProjectWriteScope) error) (store.Completion, error) {
					if ctx != f.Ctx || id != projectID {
						t.Fatal("missing Project scope or context changed")
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
			case "missing step":
				stepID = "ffffffff"
			case "deleted task":
				at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
				f.Header.DeletedAt = &at
				stepID = "ffffffff"
				version = 99
				code = "task_deleted"
			}
			result, err := f.Steps.Update(f.Ctx, principal, projectID, taskID, stepID, taskservice.UpdateTaskStep{Version: version, Title: pointer("changed")})
			requireThreadFault(t, err, code)
			if result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("refusal exposed unconfirmed resource")
			}
		})
	}
	current := stepMutationRows()
	current[1].Position = 3
	f = newStepWriteFixture(t, stepMutationHeader(1), current, store.TransactionNotCommitted)
	_, err = f.Steps.SetStatus(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000", taskservice.SetTaskStepStatus{Version: 1, Status: model.TaskStepDone})
	if err == nil {
		t.Fatal("corrupt storage concealed")
	}
	if _, pure := taskservice.TaskStepsFault(err); pure {
		t.Fatal("corrupt storage became business refusal")
	}
	cause := errors.New("closed database")
	f.Store.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, cause
	}
	_, err = f.Steps.Update(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("changed")})
	if !errors.Is(err, cause) {
		t.Fatal("closed-store cause lost")
	}
}

func TestTaskStepsChangeQueryFailuresRemainInternal(t *testing.T) {
	for _, stage := range []string{"header", "collection"} {
		t.Run(stage, func(t *testing.T) {
			f := newStepWriteFixture(t, stepMutationHeader(1), stepMutationRows(), store.TransactionNotCommitted)
			cause := errors.New(stage + " query failed")
			if stage == "header" {
				f.Writer.TaskHeaderFn = func(context.Context, string) (model.TaskHeader, error) { return model.TaskHeader{}, cause }
			} else {
				f.Writer.TaskStepsFn = func(context.Context, string) ([]model.TaskStep, error) { return nil, cause }
			}
			result, err := f.Steps.Update(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("changed")})
			if !errors.Is(err, cause) || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatal("query failure concealed")
			}
			if _, pure := taskservice.TaskStepsFault(err); pure {
				t.Fatal("query failure became business refusal")
			}
		})
	}
}

func TestTaskStepsChangeUnexpectedTargetDisappearanceStaysInternal(t *testing.T) {
	f := newStepWriteFixture(t, stepMutationHeader(1), stepMutationRows(), store.TransactionNotCommitted)
	at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	f.Writer.ObservedAtFn = func(context.Context) (time.Time, error) { return at, nil }
	calls := 0
	f.Writer.UpdateTaskStepFn = func(ctx context.Context, id string, step model.TaskStep) error {
		calls++
		if ctx != f.Ctx || id != f.Header.ID || step.ID != "00000000" || step.Title != "changed" || step.UpdatedAt != at {
			t.Fatal("unexpected-disappearance parameters changed")
		}
		return model.ErrNotFound
	}
	result, err := f.Steps.Update(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000", taskservice.UpdateTaskStep{Version: 1, Title: pointer("changed")})
	if calls != 1 || !errors.Is(err, model.ErrNotFound) || result.JSON != nil || result.TransactionOutcome != store.TransactionNotCommitted {
		t.Fatalf("unexpected target result lost: %+v %v", result, err)
	}
	if _, pure := taskservice.TaskStepsFault(err); pure {
		t.Fatal("unexpected zero-row persistence became child visibility refusal")
	}
}
