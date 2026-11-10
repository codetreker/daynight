package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// Completion and callback outcomes are independently supplied and observed.
type limitWriteStore struct {
	*strictStepWrite
	completion     store.Completion
	completionErr  error
	callbackErr    error
	transactionErr *store.TransactionError
}

func (s *limitWriteStore) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	f := s.strictStepWrite
	f.event("store")
	if ctx != f.ctx || id != f.projectID || work == nil || f.active {
		f.t.Fatal("project scope/context changed")
	}
	f.active = true
	s.callbackErr = work(f)
	f.active = false
	f.event("complete")
	if s.callbackErr != nil {
		s.transactionErr = &store.TransactionError{Phase: "operation", Outcome: s.completion.Outcome, Cause: s.callbackErr}
		return s.completion, errors.Join(s.transactionErr, s.completionErr)
	}
	return s.completion, s.completionErr
}

func newLimitWrite(t *testing.T, header model.TaskHeader, rows []model.TaskStep, outcome store.TransactionOutcome) (*strictStepWrite, *limitWriteStore) {
	t.Helper()
	f := newStrictStepWrite(t, header, rows)
	s := &limitWriteStore{strictStepWrite: f, completion: store.Completion{Outcome: outcome}}
	f.svc.store = s
	return f, s
}

func limitWriteInput(f *strictStepWrite, operation, id, title, description string) (StepsWriteResult, error) {
	if operation == "add" {
		return f.svc.Add(f.ctx, f.principal, f.projectID, f.taskID, AddTaskStep{Version: f.header.Version, ID: id, Title: title, Description: description})
	}
	return f.svc.Update(f.ctx, f.principal, f.projectID, f.taskID, id, UpdateTaskStep{Version: f.header.Version, Title: &title, Description: &description})
}

func configureLimitMutation(f *strictStepWrite, operation, id, title, description string, at time.Time) []model.TaskStep {
	candidate := slices.Clone(f.current)
	if operation == "add" {
		f.addStep = model.TaskStep{ID: id, Title: title, Description: description, Status: model.TaskStepTodo}
		candidate = append(candidate, model.TaskStep{ID: id, Position: 2, Title: title, Description: description, Status: model.TaskStepTodo})
		f.mutation = tasksteps.Mutation{Candidate: candidate, To: 2, Changed: true}
		written := candidate[2]
		written.CreatedAt, written.UpdatedAt = at, at
		f.changed(written, at, "created", nil, "", "")
		return []model.TaskStep{f.current[0], f.current[1], written}
	}
	f.changeID = id
	f.changes = tasksteps.Changes{Title: &title, Description: &description}
	candidate[0].Title, candidate[0].Description = title, description
	f.mutation = tasksteps.Mutation{Candidate: candidate, To: 0, Changed: true}
	written := candidate[0]
	written.UpdatedAt = at
	f.changed(written, at, "updated", []string{"description", "title"}, "", "")
	return []model.TaskStep{written, f.current[1]}
}

func expectedLimitResource(header model.TaskHeader, rows []model.TaskStep) taskcodec.StepsResource {
	resource := taskcodec.StepsResource{ProjectID: header.ProjectID, TaskID: header.ID, Version: header.Version, Steps: make([]taskcodec.Step, len(rows))}
	for i, row := range rows {
		resource.Steps[i] = taskcodec.Step{ID: row.ID, Title: row.Title, Description: row.Description, Status: row.Status, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
	}
	return resource
}

func TestTaskStepsTextLimitsOnAddAndChange(t *testing.T) {
	cases := []struct {
		name, title, description string
		valid, parserReject      bool
	}{
		{"title boundary multibyte", strings.Repeat("界", 341) + "x", "", true, false},
		{"title over multibyte", strings.Repeat("界", 341) + "xx", "", false, false},
		{"description boundary multibyte", "x", strings.Repeat("界", 21845) + "x", true, false},
		{"description over multibyte", "x", strings.Repeat("界", 21845) + "xx", false, false},
		{"escaped boundary", strings.Repeat("<", 1024), strings.Repeat("<", 65536), true, false},
		{"title over escaped", strings.Repeat("<", 1025), "", false, false},
		{"description over escaped", "x", strings.Repeat("<", 65537), false, false},
		{"empty description", "title", "", true, false},
		{"whitespace title", " \u0085\t", "", false, true},
		{"nul title", "x\x00", "", false, true},
		{"nul description", "x", "\x00", false, true},
		{"invalid title UTF-8", string([]byte{0xff}), "", false, true},
		{"invalid description UTF-8", "x", string([]byte{0xff}), false, true},
	}
	for i, tc := range cases {
		for _, operation := range []string{"add", "change"} {
			t.Run(tc.name+"/"+operation, func(t *testing.T) {
				header, rows := writeHeader(1), writeRows()
				before := slices.Clone(rows)
				outcome := store.TransactionNotCommitted
				if tc.valid {
					outcome = store.TransactionCommitted
				}
				f, s := newLimitWrite(t, header, rows, outcome)
				id := fmt.Sprintf("%08x", i+2)
				if operation == "change" {
					id = "00000000"
				}
				at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
				expected := configureLimitMutation(f, operation, id, tc.title, tc.description, at)
				if tc.parserReject {
					f.begin()
				} else if !tc.valid {
					f.admitErr = &model.Fault{Code: "invalid_input", Message: "controlled text byte limit"}
					f.begin(writePath("admit")...)
				} else if operation == "add" {
					f.begin(writePath("insert")...)
				} else {
					f.begin(writePath("update")...)
				}
				r, err := limitWriteInput(f, operation, id, tc.title, tc.description)
				f.end()
				if header != f.header || !reflect.DeepEqual(rows, before) {
					t.Fatal("text write changed header or current")
				}
				if !tc.valid {
					expectRefusal(t, r, err, "invalid_input")
					if r.Changed || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) || (!tc.parserReject && (s.callbackErr == nil || !errors.Is(err, s.callbackErr))) || (tc.parserReject && s.callbackErr != nil) {
						t.Fatalf("text refusal lost result or callback: %+v %v", r, err)
					}
					return
				}
				expectReceipt(t, r, err, true)
				post := header
				post.Version++
				want := expectedLimitResource(post, expected)
				var decoded taskcodec.StepsResource
				if err := json.Unmarshal(r.JSON, &decoded); err != nil {
					t.Fatalf("decode actual JSON: %v", err)
				}
				if s.callbackErr != nil || !reflect.DeepEqual(r.Resource, want) || !reflect.DeepEqual(decoded, want) || !reflect.DeepEqual(f.mutation.Candidate, expected) {
					t.Fatal("text write lost exact candidate or resource")
				}
			})
		}
	}
}

func TestTaskStepsCollectionFactsForwardedBeforeAdmissionFailure(t *testing.T) {
	const count = 170
	body := strings.Repeat("<", 65536)
	at := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	header := writeHeader(1)
	current := make([]model.TaskStep, count+1)
	for i := range current {
		current[i] = model.TaskStep{ID: fmt.Sprintf("%08x", i), Position: int64(i), Title: "x", Description: body, Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	}
	current[count].Description = ""
	before := slices.Clone(current)
	for _, operation := range []string{"add", "change"} {
		t.Run(operation, func(t *testing.T) {
			f, s := newLimitWrite(t, header, slices.Clone(current), store.TransactionNotCommitted)
			sentinel := errors.New("controlled admission failure")
			f.admitErr = sentinel
			id := fmt.Sprintf("%08x", count+1)
			if operation == "add" {
				f.addStep = model.TaskStep{ID: id, Title: "x", Description: body, Status: model.TaskStepTodo}
			} else {
				id = fmt.Sprintf("%08x", count)
				f.changeID = id
				f.changes = tasksteps.Changes{Description: &body}
			}
			f.begin(writePath("admit")...)
			var r StepsWriteResult
			var err error
			if operation == "add" {
				r, err = f.svc.Add(f.ctx, f.principal, header.ProjectID, header.ID, AddTaskStep{Version: 1, ID: id, Title: "x", Description: body})
			} else {
				r, err = f.svc.Update(f.ctx, f.principal, header.ProjectID, header.ID, id, UpdateTaskStep{Version: 1, Description: &body})
			}
			f.end()
			if s.callbackErr != sentinel || !errors.Is(err, sentinel) || !errors.Is(err, s.transactionErr) || r.Phase != "prepare" || r.CleanupFailed || r.TransactionOutcome != store.TransactionNotCommitted || r.Changed || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) || f.header != header || !reflect.DeepEqual(f.current, before) || !reflect.DeepEqual(current, before) {
				t.Fatalf("%s forwarding failure: %+v %v", operation, r, err)
			}
			if _, pure := TaskStepsFault(err); pure {
				t.Fatal("operational failure became a business refusal")
			}
		})
	}
}

func TestTaskStepsRealEncodingFailureStopsBeforeWrites(t *testing.T) {
	for _, operation := range []string{"add", "change"} {
		t.Run(operation, func(t *testing.T) {
			header, rows := writeHeader(1), writeRows()
			before := slices.Clone(rows)
			f, s := newLimitWrite(t, header, rows, store.TransactionNotCommitted)
			at := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			id := "00000002"
			if operation == "change" {
				id = "00000000"
			}
			configureLimitMutation(f, operation, id, "new title", "new body", at)
			f.begin("store", "projectDAO", "authorize", "taskDAO", "header", "taskDAO", "rows", "admit", "taskDAO", "clock", "complete")
			r, err := limitWriteInput(f, operation, id, "new title", "new body")
			f.end()
			if s.callbackErr == nil || !strings.Contains(s.callbackErr.Error(), "timestamp is not a finite microsecond timestamp") || !errors.Is(err, s.callbackErr) || !errors.Is(err, s.transactionErr) || r.Phase != "prepare" || r.TransactionOutcome != store.TransactionNotCommitted || r.Changed || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) || f.header != header || !reflect.DeepEqual(rows, before) {
				t.Fatalf("%s encoding failure: %+v %v callback=%v", operation, r, err, s.callbackErr)
			}
		})
	}
}

func TestTaskStepsLimitWritesCompletionSuppressesDocument(t *testing.T) {
	cause, cleanup := errors.New("completion cause"), errors.New("cleanup cause")
	refusal := &model.Fault{Code: "not_found", Message: "controlled refusal"}
	failures := []*store.TransactionError{
		{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause},
		{Phase: "cleanup", Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true, Cause: errors.Join(cause, cleanup)},
		{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.Join(refusal, cleanup)},
	}
	for _, operation := range []string{"add", "change"} {
		for _, failure := range failures {
			t.Run(operation+"/"+failure.Phase+"/"+string(failure.Outcome), func(t *testing.T) {
				header, rows := writeHeader(1), writeRows()
				before := slices.Clone(rows)
				f, s := newLimitWrite(t, header, rows, failure.Outcome)
				s.completionErr = failure
				at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
				id := "00000002"
				if operation == "change" {
					id = "00000000"
				}
				configureLimitMutation(f, operation, id, "new title", "new body", at)
				if operation == "add" {
					f.begin(writePath("insert")...)
				} else {
					f.begin(writePath("update")...)
				}
				r, err := limitWriteInput(f, operation, id, "new title", "new body")
				f.end()
				phase := "persist"
				if failure.CommitAttempted {
					phase = "commit"
				}
				if s.callbackErr != nil || !errors.Is(err, failure) || r.Phase != phase || !r.Changed || r.TransactionOutcome != failure.Outcome || r.CleanupFailed != failure.CleanupFailed || !reflect.DeepEqual(r.StepsDocument, StepsDocument{}) || !reflect.DeepEqual(rows, before) {
					t.Fatalf("completion: %+v %v", r, err)
				}
				if _, pure := TaskStepsFault(err); pure {
					t.Fatal("completion became refusal")
				}
				for _, child := range []error{cause, cleanup, refusal} {
					if errors.Is(failure, child) && !errors.Is(err, child) {
						t.Fatal("completion cause lost")
					}
				}
			})
		}
	}
}
