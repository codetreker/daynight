package task

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
)

var orderedStepIDs = []string{"00000000", "11111111", "abcdef01", "fedcba98"}

func orderedStepRows() []model.TaskStep {
	rows := make([]model.TaskStep, len(orderedStepIDs))
	statuses := []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}
	for i, id := range orderedStepIDs {
		rows[i] = model.TaskStep{ID: id, Position: int64(i), Title: "same", Description: "  # " + id + "\n<原值&>  ", Status: statuses[i], CreatedAt: time.Date(2026, 1, 2+i, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 3+i, 4, 5, 6, 654321000, time.UTC)}
	}
	return rows
}

func orderStepRows(t *testing.T, source []model.TaskStep, order []string) []model.TaskStep {
	t.Helper()
	rows := make([]model.TaskStep, len(order))
	for i, id := range order {
		index := slices.IndexFunc(source, func(s model.TaskStep) bool { return s.ID == id })
		if index < 0 {
			t.Fatalf("missing expected Step %s", id)
		}
		rows[i] = source[index]
		rows[i].Position = int64(i)
	}
	return rows
}

// orderedWrite adds only the ordering operations to the existing strict write
// capability. Completion is configured separately from the callback outcome.
type orderedWrite struct {
	*strictStepWrite
	target     string
	placement  tasksteps.Placement
	from, to   int64
	completion func(error) (store.Completion, error)
}

func newOrderedWrite(t *testing.T, h model.TaskHeader, rows []model.TaskStep) *orderedWrite {
	t.Helper()
	base := newStrictStepWrite(t, h, rows)
	f := &orderedWrite{strictStepWrite: base}
	if reflect.ValueOf(base.svc.writeOperations.admitMove).Pointer() != reflect.ValueOf(tasksteps.AdmitMove).Pointer() || reflect.ValueOf(base.svc.writeOperations.admitDelete).Pointer() != reflect.ValueOf(tasksteps.AdmitDelete).Pointer() {
		t.Fatal("production ordering admission bindings changed")
	}
	base.svc.store = f
	base.svc.writeOperations.admitMove = func(h model.TaskHeader, rows []model.TaskStep, id string, placement tasksteps.Placement) (tasksteps.Mutation, error) {
		f.scoped("admit")
		if h != f.header || !reflect.DeepEqual(rows, f.expectedCurrent) || id != f.target || !reflect.DeepEqual(placement, f.placement) {
			t.Fatalf("Move admission arguments: %+v %s %+v", h, id, placement)
		}
		return f.mutation, f.admitErr
	}
	base.svc.writeOperations.admitDelete = func(h model.TaskHeader, rows []model.TaskStep, id string) (tasksteps.Mutation, error) {
		f.scoped("admit")
		if h != f.header || !reflect.DeepEqual(rows, f.expectedCurrent) || id != f.target {
			t.Fatalf("Delete admission arguments: %+v %s", h, id)
		}
		return f.mutation, f.admitErr
	}
	return f
}
func (f *orderedWrite) TaskDAO() store.TaskWriteDAO { f.scoped("taskDAO"); return f }
func (f *orderedWrite) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	f.event("store")
	if ctx != f.ctx || id != f.projectID || work == nil || f.active || f.completion == nil {
		f.t.Fatal("project scope/context or completion changed")
	}
	var err error
	if f.startErr != nil {
		err = f.startErr
	} else {
		f.active = true
		err = work(f)
		f.active = false
	}
	f.event("complete")
	return f.completion(err)
}
func (f *orderedWrite) MoveTaskStep(ctx context.Context, id, target string, from, to int64) error {
	f.scoped("move")
	if ctx != f.ctx || id != f.taskID || target != f.target || from != f.from || to != f.to {
		f.t.Fatalf("Move DAO arguments: %s %s %d %d", id, target, from, to)
	}
	return f.writeErr
}
func (f *orderedWrite) DeleteTaskStep(ctx context.Context, id, target string, from, tail int64) error {
	f.scoped("delete")
	if ctx != f.ctx || id != f.taskID || target != f.target || from != f.from || tail != f.to {
		f.t.Fatalf("Delete DAO arguments: %s %s %d %d", id, target, from, tail)
	}
	return f.writeErr
}
func (f *orderedWrite) committed() {
	f.completion = func(err error) (store.Completion, error) {
		if err != nil {
			f.t.Fatalf("unexpected callback error: %v", err)
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}
func (f *orderedWrite) rejected() {
	f.completion = func(err error) (store.Completion, error) {
		if err == nil {
			f.t.Fatal("expected callback rejection")
		}
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
}
func (f *orderedWrite) fact(action string, at time.Time) {
	f.observed = at
	f.expectedFact = protocol.Fact{Type: protocol.StepUpdated, ProjectID: f.projectID, TaskID: f.taskID, TaskVersion: f.header.Version + 1, OccurredAt: at, StepID: f.target, Action: action}
	if action == "moved" {
		f.expectedFact.FromPosition = stepWritePtr(f.from)
		f.expectedFact.ToPosition = stepWritePtr(f.to)
	}
}
func orderedAt() time.Time { return time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC) }
func canonicalPlacement(input MoveTaskStep) tasksteps.Placement {
	p := tasksteps.Placement{Before: input.Before, After: input.After, Position: input.Position}
	if p.Before != nil {
		p.Before = stepWritePtr(strings.ToLower(*p.Before))
	}
	if p.After != nil {
		p.After = stepWritePtr(strings.ToLower(*p.After))
	}
	return p
}
func assertOrderedResource(t *testing.T, actual taskcodec.StepsResource, h model.TaskHeader, rows []model.TaskStep) {
	t.Helper()
	want := taskcodec.ProjectCollection(h, rows)
	if actual.Steps == nil || !reflect.DeepEqual(actual, want) {
		t.Fatalf("ordered resource: %+v, want %+v", actual, want)
	}
}
func expectOrderedRefusal(t *testing.T, r StepsWriteResult, err error, code string) {
	t.Helper()
	expectRefusal(t, r, err, code)
	if r.Changed || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) {
		t.Fatalf("refusal exposed mutation: %+v", r)
	}
}
func expectOrderedInternal(t *testing.T, r StepsWriteResult, err, cause error) {
	t.Helper()
	expectInternal(t, r, err, cause)
	if r.Changed || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) {
		t.Fatalf("failure exposed mutation: %+v", r)
	}
}

func orderedFault(code string, cause error) error {
	return &model.Fault{Code: code, Message: "controlled ordering refusal", Cause: cause}
}
func orderedMissing(version int64) error {
	return tasksteps.NotFound(version, tasksteps.ErrTargetNotFound)
}

func TestTaskStepsMovePreservesAllStepTimesAndParentPolicies(t *testing.T) {
	original := orderedStepRows()
	current := original
	for i, tc := range []struct {
		target   string
		input    MoveTaskStep
		from, to int64
		order    []string
	}{
		{"00000000", MoveTaskStep{After: stepWritePtr("ABCDEF01")}, 0, 2, []string{"11111111", "abcdef01", "00000000", "fedcba98"}},
		{"FEDCBA98", MoveTaskStep{Before: stepWritePtr("ABCDEF01")}, 3, 1, []string{"11111111", "fedcba98", "abcdef01", "00000000"}},
		{"ABCDEF01", MoveTaskStep{Position: stepWritePtr("first")}, 2, 0, []string{"abcdef01", "11111111", "fedcba98", "00000000"}},
		{"ABCDEF01", MoveTaskStep{Position: stepWritePtr("last")}, 0, 3, []string{"11111111", "fedcba98", "00000000", "abcdef01"}},
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			h := writeHeader(int64(i + 1))
			before := slices.Clone(current)
			candidate := orderStepRows(t, original, tc.order)
			expected := slices.Clone(candidate)
			f := newOrderedWrite(t, h, current)
			f.target = strings.ToLower(tc.target)
			f.placement = canonicalPlacement(tc.input)
			f.from, f.to = tc.from, tc.to
			f.mutation = tasksteps.Mutation{Candidate: candidate, From: int(tc.from), To: int(tc.to), Changed: true}
			f.fact("moved", orderedAt())
			f.committed()
			f.begin(writePath("move")...)
			tc.input.Version = h.Version
			result, err := f.svc.Move(f.ctx, f.principal, strings.ToUpper(h.ProjectID), strings.ToUpper(h.ID), tc.target, tc.input)
			f.end()
			expectReceipt(t, result, err, true)
			h.Version++
			assertOrderedResource(t, result.Resource, h, expected)
			if !reflect.DeepEqual(candidate, expected) {
				t.Fatal("Move encoder changed candidate rows")
			}
			if !reflect.DeepEqual(current, before) {
				t.Fatal("Move mutated current rows")
			}
		})
		current = orderStepRows(t, original, tc.order)
	}
}

func TestTaskStepsMoveNoOpBeforeExhaustionClockAndWrites(t *testing.T) {
	cases := []struct {
		target string
		input  MoveTaskStep
	}{
		{"00000000", MoveTaskStep{Position: stepWritePtr("first")}}, {"fedcba98", MoveTaskStep{Position: stepWritePtr("last")}},
		{"11111111", MoveTaskStep{Before: stepWritePtr("ABCDEF01")}}, {"ABCDEF01", MoveTaskStep{After: stepWritePtr("11111111")}},
	}
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		for i, tc := range cases {
			t.Run(fmt.Sprintf("%d/%d", version, i), func(t *testing.T) {
				h := writeHeader(version)
				rows := orderedStepRows()
				before := slices.Clone(rows)
				_, original, err := taskcodec.EncodeCollection(h, rows)
				if err != nil {
					t.Fatal(err)
				}
				f := newOrderedWrite(t, h, rows)
				f.target = strings.ToLower(tc.target)
				f.placement = canonicalPlacement(tc.input)
				f.mutation = tasksteps.Mutation{Candidate: slices.Clone(rows), Changed: false}
				f.committed()
				f.begin(writePath("admit")...)
				tc.input.Version = version
				result, err := f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, tc.target, tc.input)
				f.end()
				expectReceipt(t, result, err, false)
				if !bytes.Equal(result.JSON, original) || !reflect.DeepEqual(rows, before) {
					t.Fatal("no-op changed full bytes or source rows")
				}
				stale := newOrderedWrite(t, h, rows)
				stale.rejected()
				stale.begin(writePath("header")...)
				tc.input.Version = version - 1
				result, err = stale.svc.Move(stale.ctx, stale.principal, h.ProjectID, h.ID, tc.target, tc.input)
				stale.end()
				expectOrderedRefusal(t, result, err, "version_conflict")
			})
		}
		if version == math.MaxInt64 {
			for _, tc := range []struct {
				target, code string
				input        MoveTaskStep
				cause        error
				absent       bool
			}{
				{"00000000", "version_exhausted", MoveTaskStep{Position: stepWritePtr("last")}, nil, false},
				{"ffffffff", "not_found", MoveTaskStep{Before: stepWritePtr("eeeeeeee")}, tasksteps.ErrTargetNotFound, true},
				{"00000000", "not_found", MoveTaskStep{Before: stepWritePtr("ffffffff")}, tasksteps.ErrAnchorNotFound, false},
			} {
				t.Run(tc.target+tc.code, func(t *testing.T) {
					h := writeHeader(version)
					f := newOrderedWrite(t, h, orderedStepRows())
					f.target = tc.target
					f.placement = canonicalPlacement(tc.input)
					f.admitErr = orderedFault(tc.code, tc.cause)
					if tc.absent {
						f.admitErr = orderedMissing(version)
					}
					f.rejected()
					f.begin(writePath("admit")...)
					tc.input.Version = version
					result, err := f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, tc.target, tc.input)
					f.end()
					expectOrderedRefusal(t, result, err, tc.code)
					var absence *tasksteps.StepAbsence
					if errors.As(err, &absence) != tc.absent || tc.absent && absence.Version != version || tc.cause != nil && !errors.Is(err, tc.cause) {
						t.Fatal("Move refusal cause/absence changed")
					}
				})
			}
		}
	}
	for _, position := range []string{"first", "last"} {
		t.Run("singleton/"+position, func(t *testing.T) {
			h := writeHeader(1)
			rows := orderedStepRows()[:1]
			f := newOrderedWrite(t, h, rows)
			f.target = "00000000"
			f.placement = tasksteps.Placement{Position: &position}
			f.mutation = tasksteps.Mutation{Candidate: slices.Clone(rows)}
			f.committed()
			f.begin(writePath("admit")...)
			r, err := f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, f.target, MoveTaskStep{Version: 1, Position: &position})
			f.end()
			expectReceipt(t, r, err, false)
			assertOrderedResource(t, r.Resource, h, rows)
		})
	}
}

func TestTaskStepsMoveAdmissionPlacementAndTaskLocalErrors(t *testing.T) {
	h := writeHeader(1)
	inputs := []MoveTaskStep{
		{Version: 1}, {Version: 1, Before: stepWritePtr("bad")}, {Version: 1, After: stepWritePtr("bad")},
		{Version: 1, Position: stepWritePtr("")}, {Version: 1, Position: stepWritePtr("FIRST")}, {Version: 1, Position: stepWritePtr("middle")},
		{Version: 1, Before: stepWritePtr("11111111"), After: stepWritePtr("abcdef01")}, {Version: 1, Before: stepWritePtr("11111111"), Position: stepWritePtr("first")}, {Version: 1, After: stepWritePtr("11111111"), Position: stepWritePtr("last")},
	}
	for i, input := range inputs {
		t.Run(fmt.Sprintf("placement/%d", i), func(t *testing.T) {
			f := newOrderedWrite(t, h, orderedStepRows())
			f.begin()
			r, err := f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", input)
			f.end()
			expectOrderedRefusal(t, r, err, "invalid_input")
		})
	}
	for _, tc := range []struct {
		name, project, task, target string
		version                     int64
	}{
		{"principal", h.ProjectID, h.ID, "00000000", 1}, {"project", "bad", h.ID, "00000000", 1}, {"task", h.ProjectID, "bad", "00000000", 1}, {"target", h.ProjectID, h.ID, "bad", 1}, {"version", h.ProjectID, h.ID, "00000000", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newOrderedWrite(t, h, orderedStepRows())
			p := f.principal
			code := "invalid_input"
			if tc.name == "principal" {
				p = model.Principal{}
				code = "unauthenticated"
			}
			f.begin()
			r, err := f.svc.Move(f.ctx, p, tc.project, tc.task, tc.target, MoveTaskStep{Version: tc.version, Position: stepWritePtr("first")})
			f.end()
			expectOrderedRefusal(t, r, err, code)
		})
	}
	for _, tc := range []struct {
		target, code string
		input        MoveTaskStep
		cause        error
		absent       bool
	}{
		{"ffffffff", "not_found", MoveTaskStep{Before: stepWritePtr("ffffffff")}, tasksteps.ErrTargetNotFound, true},
		{"00000000", "not_found", MoveTaskStep{Before: stepWritePtr("ffffffff")}, tasksteps.ErrAnchorNotFound, false},
		{"abcdef01", "invalid_input", MoveTaskStep{Before: stepWritePtr("ABCDEF01")}, tasksteps.ErrSelfAnchor, false},
		{"abcdef01", "invalid_input", MoveTaskStep{After: stepWritePtr("ABCDEF01")}, tasksteps.ErrSelfAnchor, false},
	} {
		t.Run(tc.target+fmt.Sprint(tc.input), func(t *testing.T) {
			f := newOrderedWrite(t, h, orderedStepRows())
			f.target = tc.target
			f.placement = canonicalPlacement(tc.input)
			f.admitErr = orderedFault(tc.code, tc.cause)
			if tc.absent {
				f.admitErr = orderedMissing(1)
			}
			f.rejected()
			f.begin(writePath("admit")...)
			tc.input.Version = 1
			r, err := f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, tc.target, tc.input)
			f.end()
			expectOrderedRefusal(t, r, err, tc.code)
			var absent *tasksteps.StepAbsence
			if errors.As(err, &absent) != tc.absent || tc.absent && absent.Version != 1 || !errors.Is(err, tc.cause) {
				t.Fatal("Move local cause/absence changed")
			}
		})
	}
	f := newOrderedWrite(t, h, orderedStepRows())
	deleted := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	f.header.DeletedAt = &deleted
	f.rejected()
	f.begin(writePath("header")...)
	r, err := f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, "ffffffff", MoveTaskStep{Version: 99, Before: stepWritePtr("ffffffff")})
	f.end()
	expectOrderedRefusal(t, r, err, "task_deleted")
}

func TestTaskStepsMoveQueryAndStoredCollectionFailuresStayInternal(t *testing.T) {
	for _, stage := range []string{"header", "rows", "collection", "writer", "project", "permission"} {
		t.Run(stage, func(t *testing.T) {
			h := writeHeader(1)
			rows := orderedStepRows()
			if stage == "collection" {
				rows[2].Position = 9
			}
			f := newOrderedWrite(t, h, rows)
			f.target = "00000000"
			f.placement = tasksteps.Placement{Position: stepWritePtr("last")}
			cause := errors.New(stage + " storage failure")
			stop := "admit"
			switch stage {
			case "header":
				f.headerErr = cause
				stop = "header"
			case "rows":
				f.rowsErr = cause
				stop = "rows"
			case "collection":
				f.admitErr = cause
			case "writer":
				f.startErr = cause
				stop = "store"
			case "project":
				f.startErr = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
				stop = "store"
			case "permission":
				f.authErr = orderedFault("not_found", model.ErrNotFound)
				stop = "auth"
			}
			if stage == "writer" || stage == "project" {
				f.completion = func(err error) (store.Completion, error) {
					if err != f.startErr {
						t.Fatal("start error changed")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
			} else {
				f.rejected()
			}
			f.begin(writePath(stop)...)
			r, err := f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, f.target, MoveTaskStep{Version: 1, Position: stepWritePtr("last")})
			f.end()
			if stage == "project" || stage == "permission" {
				expectOrderedRefusal(t, r, err, "not_found")
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("not-found cause lost")
				}
			} else {
				expectOrderedInternal(t, r, err, cause)
			}
		})
	}
}

func TestTaskStepsOrderingCompletionFailures(t *testing.T) {
	for _, operation := range []string{"move", "delete", "add", "noop"} {
		for _, kind := range []string{"commit", "cleanup committed", "cleanup refusal"} {
			t.Run(operation+"/"+kind, func(t *testing.T) {
				h := writeHeader(1)
				rows := orderedStepRows()
				f := newOrderedWrite(t, h, rows)
				f.target = "00000000"
				f.placement = tasksteps.Placement{Position: stepWritePtr("last")}
				f.from = 0
				f.to = 3
				candidate := orderStepRows(t, rows, []string{"11111111", "abcdef01", "fedcba98", "00000000"})
				f.mutation = tasksteps.Mutation{Candidate: candidate, From: 0, To: 3, Changed: true}
				f.fact("moved", orderedAt())
				stop := "move"
				if operation == "delete" {
					f.to = 3
					f.mutation = tasksteps.Mutation{Candidate: orderStepRows(t, rows, []string{"11111111", "abcdef01", "fedcba98"}), From: 0, Changed: true}
					f.fact("deleted", orderedAt())
					stop = "delete"
				}
				if operation == "add" {
					f.addStep = model.TaskStep{ID: "12345678", Title: "new", Status: model.TaskStepTodo}
					f.mutation = tasksteps.Mutation{Candidate: append(slices.Clone(rows), f.addStep), To: 4, Changed: true}
					written := f.addStep
					written.Position = 4
					f.mutation.Candidate[4].Position = 4
					written.CreatedAt = orderedAt()
					written.UpdatedAt = orderedAt()
					f.changed(written, orderedAt(), "created", nil, "", "")
					stop = "insert"
				}
				if operation == "noop" {
					f.placement = tasksteps.Placement{Position: stepWritePtr("first")}
					f.mutation = tasksteps.Mutation{Candidate: slices.Clone(rows)}
					stop = "admit"
				}
				cause := errors.New("completion-cause-sentinel")
				cleanup := errors.New("cleanup-cause-sentinel")
				refusal := orderedFault("not_found", tasksteps.ErrAnchorNotFound)
				failure := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}
				if kind == "cleanup committed" {
					failure = &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true, Cause: errors.Join(cause, cleanup)}
				}
				if kind == "cleanup refusal" {
					f.admitErr = refusal
					stop = "admit"
					failure = &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.Join(refusal, cleanup)}
				}
				f.completion = func(callback error) (store.Completion, error) {
					if kind == "cleanup refusal" && !errors.Is(callback, refusal) || kind != "cleanup refusal" && callback != nil {
						t.Fatalf("unexpected callback: %v", callback)
					}
					return store.Completion{Outcome: failure.Outcome}, failure
				}
				f.begin(writePath(stop)...)
				var r StepsWriteResult
				var err error
				switch operation {
				case "move":
					r, err = f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, f.target, MoveTaskStep{Version: 1, Position: stepWritePtr("last")})
				case "delete":
					r, err = f.svc.Delete(f.ctx, f.principal, h.ProjectID, h.ID, f.target, DeleteTaskStep{Version: 1})
				case "add":
					r, err = f.svc.Add(f.ctx, f.principal, h.ProjectID, h.ID, AddTaskStep{Version: 1, ID: "12345678", Title: "new"})
				case "noop":
					r, err = f.svc.Move(f.ctx, f.principal, h.ProjectID, h.ID, f.target, MoveTaskStep{Version: 1, Position: stepWritePtr("first")})
				}
				f.end()
				changed := operation != "noop" && kind != "cleanup refusal"
				phase := "prepare"
				if changed {
					phase = "persist"
				}
				if failure.CommitAttempted {
					phase = "commit"
				}
				if !errors.Is(err, failure) || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) || r.Changed != changed || r.Phase != phase || r.TransactionOutcome != failure.Outcome || r.CleanupFailed != failure.CleanupFailed {
					t.Fatalf("completion result %+v %v", r, err)
				}
				if _, pure := TaskStepsFault(err); pure {
					t.Fatal("completion became business refusal")
				}
				if kind == "cleanup refusal" {
					if !errors.Is(err, refusal) || !errors.Is(err, cleanup) {
						t.Fatal("cleanup/refusal causes lost")
					}
				} else if !errors.Is(err, cause) || kind == "cleanup committed" && !errors.Is(err, cleanup) {
					t.Fatal("completion causes lost")
				}
			})
		}
	}
}
