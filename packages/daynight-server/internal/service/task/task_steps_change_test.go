package task

import (
	"bytes"
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
)

func TestTaskStepsChangeNoOpPreservesAllBytesBeforeClockAndWrites(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			h := writeHeader(version)
			rows := writeRows()
			original := slices.Clone(rows)
			resource, document, err := taskcodec.EncodeCollection(h, rows)
			if err != nil {
				t.Fatal(err)
			}
			for _, kind := range []string{"title", "description", "paired", "status"} {
				f := newStrictStepWrite(t, h, rows)
				f.changeID = "00000000"
				candidate := slices.Clone(rows)
				candidate[0].Title = "different candidate"
				f.mutation = tasksteps.Mutation{Candidate: candidate, To: 0, Changed: false}
				input := UpdateTaskStep{Version: version}
				if kind != "status" {
					if kind != "description" {
						input.Title = stepWritePtr("same")
					}
					if kind != "title" {
						input.Description = stepWritePtr("original body")
					}
					f.changes = tasksteps.Changes{Title: input.Title, Description: input.Description}
				} else {
					f.changes = tasksteps.Changes{Status: stepWritePtr(model.TaskStepTodo)}
				}
				f.begin(writePath("admit")...)
				var r StepsWriteResult
				if kind == "status" {
					r, err = f.svc.SetStatus(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", SetTaskStepStatus{Version: version, Status: model.TaskStepTodo})
				} else {
					r, err = f.svc.Update(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", input)
				}
				f.end()
				expectReceipt(t, r, err, false)
				if !bytes.Equal(r.JSON, document) || !reflect.DeepEqual(r.Resource, resource) || !reflect.DeepEqual(rows, original) {
					t.Fatal("no-op changed bytes, resource, or rows")
				}
			}
			for _, status := range []bool{false, true} {
				f := newStrictStepWrite(t, h, rows)
				f.begin(writePath("header")...)
				var r StepsWriteResult
				if status {
					r, err = f.svc.SetStatus(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", SetTaskStepStatus{Version: version - 1, Status: model.TaskStepTodo})
				} else {
					r, err = f.svc.Update(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", UpdateTaskStep{Version: version - 1, Title: stepWritePtr("same")})
				}
				f.end()
				expectRefusal(t, r, err, "version_conflict")
			}
			if version == math.MaxInt64 {
				for _, kind := range []string{"title", "status", "missing"} {
					f := newStrictStepWrite(t, h, rows)
					f.changeID = "00000000"
					code := "version_exhausted"
					if kind == "status" {
						f.changes = tasksteps.Changes{Status: stepWritePtr(model.TaskStepDone)}
					} else {
						f.changes = tasksteps.Changes{Title: stepWritePtr("changed")}
						if kind == "missing" {
							f.changeID = "ffffffff"
							code = "not_found"
						}
					}
					f.admitErr = &model.Fault{Code: code, Message: "controlled"}
					f.begin(writePath("admit")...)
					var r StepsWriteResult
					if kind == "status" {
						r, err = f.svc.SetStatus(f.ctx, f.principal, h.ProjectID, h.ID, f.changeID, SetTaskStepStatus{Version: version, Status: model.TaskStepDone})
					} else {
						r, err = f.svc.Update(f.ctx, f.principal, h.ProjectID, h.ID, f.changeID, UpdateTaskStep{Version: version, Title: stepWritePtr("changed")})
					}
					f.end()
					expectRefusal(t, r, err, code)
				}
			}
			if !reflect.DeepEqual(rows, original) {
				t.Fatal("refusal altered rows")
			}
		})
	}
}
func TestTaskStepsChangeUsesHeaderAndPreservesOtherRows(t *testing.T) {
	h := writeHeader(1)
	rows := writeRows()
	original := slices.Clone(rows)
	title, description := "  <原值&> 😀 \uFEFF  ", "  # Markdown\n\"\\\u2028\u2029  "
	at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	desired := rows[0]
	desired.Title, desired.Description = title, description
	f := newStrictStepWrite(t, h, rows)
	f.changeID = "00000000"
	f.changes = tasksteps.Changes{Title: &title, Description: &description}
	f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{desired, rows[1]}, To: 0, Changed: true}
	written := desired
	written.UpdatedAt = at
	f.changed(written, at, "updated", []string{"description", "title"}, "", "")
	f.begin(writePath("update")...)
	r, err := f.svc.Update(f.ctx, f.principal, strings.ToUpper(h.ProjectID), strings.ToUpper(h.ID), "00000000", UpdateTaskStep{Version: h.Version, Title: &title, Description: &description})
	f.end()
	expectReceipt(t, r, err, true)
	post := h
	post.Version++
	if !reflect.DeepEqual(r.Resource, taskcodec.ProjectCollection(post, []model.TaskStep{written, rows[1]})) || !reflect.DeepEqual(rows, original) {
		t.Fatal("paired change altered content or rows")
	}
	for _, status := range []model.TaskStepStatus{model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped, model.TaskStepTodo} {
		h.Version++
		previous := written
		rows = []model.TaskStep{previous, original[1]}
		before := slices.Clone(rows)
		at = at.Add(time.Microsecond)
		desired = previous
		desired.Status = status
		f = newStrictStepWrite(t, h, rows)
		f.changeID = "00000000"
		f.changes = tasksteps.Changes{Status: &status}
		f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{desired, rows[1]}, To: 0, Changed: true}
		written = desired
		written.UpdatedAt = at
		f.changed(written, at, "status_changed", nil, string(previous.Status), string(status))
		f.begin(writePath("update")...)
		r, err = f.svc.SetStatus(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", SetTaskStepStatus{Version: h.Version, Status: status})
		f.end()
		expectReceipt(t, r, err, true)
		post = h
		post.Version++
		if !reflect.DeepEqual(r.Resource, taskcodec.ProjectCollection(post, []model.TaskStep{written, rows[1]})) || !reflect.DeepEqual(rows, before) {
			t.Fatal("status change altered content or rows")
		}
	}
	h.Version++
	previous := written
	rows = []model.TaskStep{previous, original[1]}
	before := slices.Clone(rows)
	at = at.Add(time.Microsecond)
	desired = previous
	desired.Description = ""
	f = newStrictStepWrite(t, h, rows)
	f.changeID = "00000000"
	f.changes = tasksteps.Changes{Description: stepWritePtr("")}
	f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{desired, rows[1]}, To: 0, Changed: true}
	written = desired
	written.UpdatedAt = at
	f.changed(written, at, "updated", []string{"description"}, "", "")
	f.begin(writePath("update")...)
	r, err = f.svc.Update(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", UpdateTaskStep{Version: h.Version, Description: stepWritePtr("")})
	f.end()
	expectReceipt(t, r, err, true)
	post = h
	post.Version++
	if !reflect.DeepEqual(r.Resource, taskcodec.ProjectCollection(post, []model.TaskStep{written, rows[1]})) || !reflect.DeepEqual(rows, before) {
		t.Fatal("clear altered title or rows")
	}
}
func TestTaskStepsChangeAdmissionInputAndStorageFailures(t *testing.T) {
	for _, input := range []UpdateTaskStep{{Version: 1}, {Version: 1, Title: stepWritePtr("\u0085")}, {Version: 1, Title: stepWritePtr("\x00")}, {Version: 1, Title: stepWritePtr(string([]byte{0xff}))}, {Version: 1, Description: stepWritePtr("\x00")}, {Version: 1, Description: stepWritePtr(string([]byte{0xff}))}} {
		f := newStrictStepWrite(t, writeHeader(1), writeRows())
		f.begin()
		r, err := f.svc.Update(f.ctx, f.principal, f.projectID, f.taskID, "00000000", input)
		f.end()
		expectRefusal(t, r, err, "invalid_input")
	}
	f := newStrictStepWrite(t, writeHeader(1), writeRows())
	f.begin()
	r, err := f.svc.SetStatus(f.ctx, f.principal, f.projectID, f.taskID, "00000000", SetTaskStepStatus{Version: 1, Status: "invalid"})
	f.end()
	expectRefusal(t, r, err, "invalid_input")
	for _, stage := range []string{"principal", "project ID", "task ID", "step ID", "version", "missing project", "missing task", "project access", "missing step", "deleted task"} {
		t.Run(stage, func(t *testing.T) {
			f := newStrictStepWrite(t, writeHeader(1), writeRows())
			p, project, task, id, version, code := f.principal, f.projectID, f.taskID, "00000000", int64(1), "not_found"
			stop := ""
			switch stage {
			case "principal":
				p = model.Principal{}
				code = "unauthenticated"
			case "project ID":
				project = "bad"
				code = "invalid_input"
			case "task ID":
				task = "bad"
				code = "invalid_input"
			case "step ID":
				id = "bad"
				code = "invalid_input"
			case "version":
				version = 0
				code = "invalid_input"
			case "missing project":
				project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.projectID = project
				f.startErr = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
				stop = "store"
			case "missing task":
				task = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.taskID = task
				f.headerErr = model.ErrNotFound
				stop = "header"
			case "project access":
				p.UserID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.principal = p
				f.authErr = &model.Fault{Code: "not_found", Message: "controlled"}
				stop = "auth"
			case "missing step":
				id = "ffffffff"
				f.changeID = id
				f.changes = tasksteps.Changes{Title: stepWritePtr("changed")}
				f.admitErr = tasksteps.NotFound(f.header.Version, model.ErrNotFound)
				stop = "admit"
			case "deleted task":
				d := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
				f.header.DeletedAt = &d
				id = "ffffffff"
				version = 99
				code = "task_deleted"
				stop = "header"
			}
			if stop == "" {
				f.begin()
			} else {
				f.begin(writePath(stop)...)
			}
			r, err := f.svc.Update(f.ctx, p, project, task, id, UpdateTaskStep{Version: version, Title: stepWritePtr("changed")})
			f.end()
			expectRefusal(t, r, err, code)
			if stage == "missing step" {
				var absence *tasksteps.StepAbsence
				if !errors.As(err, &absence) || absence.Version != f.header.Version {
					t.Fatalf("missing child version: %v", err)
				}
			}
		})
	}
	rows := writeRows()
	rows[1].Position = 3
	f = newStrictStepWrite(t, writeHeader(1), rows)
	cause := errors.New("corrupt collection")
	f.changeID = "00000000"
	f.changes = tasksteps.Changes{Status: stepWritePtr(model.TaskStepDone)}
	f.admitErr = cause
	f.begin(writePath("admit")...)
	r, err = f.svc.SetStatus(f.ctx, f.principal, f.projectID, f.taskID, "00000000", SetTaskStepStatus{Version: 1, Status: model.TaskStepDone})
	f.end()
	expectInternal(t, r, err, cause)
	f = newStrictStepWrite(t, writeHeader(1), rows)
	cause = errors.New("closed database")
	f.startErr = cause
	f.begin(writePath("store")...)
	r, err = f.svc.Update(f.ctx, f.principal, f.projectID, f.taskID, "00000000", UpdateTaskStep{Version: 1, Title: stepWritePtr("changed")})
	f.end()
	expectInternal(t, r, err, cause)
}
func TestTaskStepsChangeQueryFailuresRemainInternal(t *testing.T) {
	for _, stage := range []string{"header", "collection"} {
		t.Run(stage, func(t *testing.T) {
			f := newStrictStepWrite(t, writeHeader(1), writeRows())
			cause := errors.New(stage + " query failed")
			stop := "header"
			if stage == "header" {
				f.headerErr = cause
			} else {
				f.rowsErr = cause
				stop = "rows"
			}
			f.begin(writePath(stop)...)
			r, err := f.svc.Update(f.ctx, f.principal, f.projectID, f.taskID, "00000000", UpdateTaskStep{Version: 1, Title: stepWritePtr("changed")})
			f.end()
			expectInternal(t, r, err, cause)
		})
	}
}
func TestTaskStepsChangeUnexpectedTargetDisappearanceStaysInternal(t *testing.T) {
	h := writeHeader(1)
	rows := writeRows()
	f := newStrictStepWrite(t, h, rows)
	at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	desired := rows[0]
	desired.Title = "changed"
	f.changeID = desired.ID
	f.changes = tasksteps.Changes{Title: stepWritePtr("changed")}
	f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{desired, rows[1]}, To: 0, Changed: true}
	desired.UpdatedAt = at
	f.expectedWrite = desired
	f.observed = at
	f.writeErr = model.ErrNotFound
	f.begin(writePath("updateFail")...)
	r, err := f.svc.Update(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", UpdateTaskStep{Version: 1, Title: stepWritePtr("changed")})
	f.end()
	expectInternal(t, r, err, model.ErrNotFound)
}

func TestTaskStepsPublicWritesCompletionOverridesDocument(t *testing.T) {
	cause := errors.New("completion-cause-sentinel")
	cleanup := errors.New("cleanup-cause-sentinel")
	refusal := &model.Fault{Code: "not_found", Message: "business refusal"}
	for _, method := range []string{"add", "update"} {
		for _, failure := range []*store.TransactionError{{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}, {Phase: "cleanup", Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true, Cause: errors.Join(cause, cleanup)}, {Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.Join(refusal, cleanup)}} {
			t.Run(method+"/"+failure.Phase+"/"+string(failure.Outcome), func(t *testing.T) {
				h := writeHeader(1)
				rows := writeRows()
				f := newStrictStepWrite(t, h, rows)
				at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
				f.outcome = failure.Outcome
				f.completionErr = failure
				var r StepsWriteResult
				var err error
				if method == "add" {
					f.addStep = model.TaskStep{ID: "12345678", Title: "x", Status: model.TaskStepTodo}
					f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{rows[0], rows[1], {ID: "12345678", Position: 2, Title: "x", Status: model.TaskStepTodo}}, To: 2, Changed: true}
					written := f.mutation.Candidate[2]
					written.CreatedAt = at
					written.UpdatedAt = at
					f.changed(written, at, "created", nil, "", "")
					f.begin(writePath("insert")...)
					r, err = f.svc.Add(f.ctx, f.principal, h.ProjectID, h.ID, AddTaskStep{Version: 1, ID: "12345678", Title: "x"})
				} else {
					desired := rows[0]
					desired.Title = "changed"
					f.changeID = desired.ID
					f.changes = tasksteps.Changes{Title: stepWritePtr("changed")}
					f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{desired, rows[1]}, To: 0, Changed: true}
					desired.UpdatedAt = at
					f.changed(desired, at, "updated", []string{"title"}, "", "")
					f.begin(writePath("update")...)
					r, err = f.svc.Update(f.ctx, f.principal, h.ProjectID, h.ID, "00000000", UpdateTaskStep{Version: 1, Title: stepWritePtr("changed")})
				}
				f.end()
				phase := "persist"
				if failure.CommitAttempted {
					phase = "commit"
				}
				if !errors.Is(err, failure) || r.Phase != phase || !r.Changed || r.TransactionOutcome != failure.Outcome || r.CleanupFailed != failure.CleanupFailed || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) {
					t.Fatalf("completion receipt: %+v %v", r, err)
				}
				if _, pure := TaskStepsFault(err); pure {
					t.Fatal("completion became refusal")
				}
				if errors.Is(failure, cause) && !errors.Is(err, cause) || errors.Is(failure, cleanup) && !errors.Is(err, cleanup) || errors.Is(failure, refusal) && !errors.Is(err, refusal) {
					t.Fatal("completion cause lost")
				}
			})
		}
	}
}
