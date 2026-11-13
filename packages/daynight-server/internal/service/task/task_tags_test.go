package task_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type tagServiceScope struct {
	store.ProjectWriteScope
	catalog      store.TagWriteDAO
	associations store.TaskTagWriteDAO
}

func (s tagServiceScope) TagDAO() store.TagWriteDAO         { return s.catalog }
func (s tagServiceScope) TaskTagDAO() store.TaskTagWriteDAO { return s.associations }

type tagCatalogStub struct {
	store.TagWriteDAO
	resolve func(context.Context, []string) ([]model.Tag, error)
}

func (s tagCatalogStub) ResolveTags(ctx context.Context, ids []string) ([]model.Tag, error) {
	return s.resolve(ctx, ids)
}

type tagAssociationsStub struct {
	store.TaskTagWriteDAO
	replace func(context.Context, string, []string) error
}

func (s tagAssociationsStub) ReplaceTaskTags(ctx context.Context, id string, ids []string) error {
	return s.replace(ctx, id, ids)
}

// Read results and completion outcomes are controlled independently; the fake
// records calls but does not model persistence.
type tagServiceFixture struct {
	*taskRuleFixture
	ctx                                                                         context.Context
	current, after                                                              model.Task
	events                                                                      []string
	authErr, readErr, resolveErr, clockErr, replaceErr, touchErr, completionErr error
	resolved                                                                    []model.Tag
	outcome                                                                     store.TransactionOutcome
	callbackErr                                                                 error
	ids                                                                         []string
	clock                                                                       time.Time
	reads                                                                       int
}

func newTagServiceFixture(t *testing.T, current model.Task) *tagServiceFixture {
	t.Helper()
	f := &tagServiceFixture{taskRuleFixture: newTaskRuleFixture(t), ctx: context.WithValue(t.Context(), struct{}{}, "tag-test"), current: current, outcome: store.TransactionCommitted, clock: current.UpdatedAt.Add(time.Second)}
	f.after = current
	f.after.Version++
	f.after.UpdatedAt = f.clock
	f.projectWriter.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
		f.events = append(f.events, "authorize")
		if ctx != f.ctx || p != f.principal {
			t.Fatal("authorization context or principal changed")
		}
		return taskMockAccess(f.project, p), f.authErr
	}
	f.writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		f.events = append(f.events, "task")
		if ctx != f.ctx || id != f.current.ID {
			t.Fatal("task read context or ID changed")
		}
		f.reads++
		if f.readErr != nil {
			return model.Task{}, f.readErr
		}
		if f.reads == 1 {
			return f.current, nil
		}
		return f.after, nil
	}
	f.writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		f.events = append(f.events, "clock")
		if ctx != f.ctx {
			t.Fatal("clock context changed")
		}
		return f.clock, f.clockErr
	}
	f.writer.TouchTaskFn = func(ctx context.Context, id string, at time.Time) error {
		f.events = append(f.events, "touch")
		if ctx != f.ctx || id != f.current.ID || at != f.clock {
			t.Fatal("touch context, ID or clock changed")
		}
		return f.touchErr
	}
	f.writer.GoalProgressesFn = func(ctx context.Context, project string, ids []string) (map[string]model.GoalProgress, error) {
		f.events = append(f.events, "progress")
		if ctx != f.ctx || project != f.project.ID || !slices.Equal(ids, []string{f.current.ID}) {
			t.Fatal("goal progress scope changed")
		}
		return map[string]model.GoalProgress{f.current.ID: {Total: 2, Done: 1, Unfinished: 1}}, nil
	}
	scope := tagServiceScope{ProjectWriteScope: f.scope,
		catalog: tagCatalogStub{resolve: func(ctx context.Context, ids []string) ([]model.Tag, error) {
			f.events = append(f.events, "resolve")
			if ctx != f.ctx || !slices.Equal(ids, f.ids) {
				t.Fatalf("resolve context or canonical IDs changed: %v", ids)
			}
			return f.resolved, f.resolveErr
		}},
		associations: tagAssociationsStub{replace: func(ctx context.Context, id string, ids []string) error {
			f.events = append(f.events, "replace")
			if ctx != f.ctx || id != f.current.ID || !slices.Equal(ids, f.ids) {
				t.Fatalf("replace context, ID or canonical set changed: %v", ids)
			}
			return f.replaceErr
		}},
	}
	f.database.WriteProjectFn = func(ctx context.Context, project string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		if ctx != f.ctx || project != f.project.ID {
			t.Fatal("write project context or ID changed")
		}
		f.callbackErr = work(scope)
		if f.completionErr != nil {
			return store.Completion{Outcome: f.outcome}, f.completionErr
		}
		if f.callbackErr != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: f.callbackErr}
		}
		return store.Completion{Outcome: f.outcome}, nil
	}
	return f
}
func (f *tagServiceFixture) run(version int64, input *[]string) (model.Task, error) {
	return f.tasks.ReplaceTags(f.ctx, f.principal, strings.ToUpper(f.project.ID), strings.ToUpper(f.current.ID), version, input)
}
func assertTagFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
func assertTagEvents(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("calls %v, want %v", got, want)
	}
}

func TestReplaceTagsUsesScopedReferencesAndPreservesTask(t *testing.T) {
	statuses := []struct {
		typ    model.TaskType
		status model.TaskStatus
	}{
		{model.TaskTypeTask, model.TaskProposed}, {model.TaskTypeTask, model.TaskTodo}, {model.TaskTypeTask, model.TaskInProgress}, {model.TaskTypeTask, model.TaskDone}, {model.TaskTypeTask, model.TaskCancelled},
		{model.TaskTypeGoal, model.TaskTodo}, {model.TaskTypeGoal, model.TaskInProgress}, {model.TaskTypeGoal, model.TaskDone}, {model.TaskTypeGoal, model.TaskCancelled},
	}
	for _, tc := range statuses {
		t.Run(string(tc.typ)+"/"+string(tc.status), func(t *testing.T) {
			_, current, _ := taskMockModels()
			current.Type, current.Status = tc.typ, tc.status
			if tc.typ == model.TaskTypeTask && tc.status == model.TaskInProgress {
				current, _, _ = workerTestCurrent(t, model.WorkerActive)
				current.Type = tc.typ
				worker := testWorker(t, current.Properties)
				worker.AgentControlMode = model.AgentControlModeWeb
				current.Properties = testWithWorker(t, current.Properties, worker)
			}
			id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			f := newTagServiceFixture(t, current)
			if tc.typ == model.TaskTypeTask && tc.status == model.TaskInProgress {
				// The legacy context would reject this active web Worker on the generic write path.
				f.ctx = taskcore.WithLegacyWorkerProtocol(f.ctx)
			}
			f.ids = []string{id}
			f.resolved = []model.Tag{{ID: id, Name: "actual"}}
			f.after.Tags = []model.TagReference{{ID: id, Name: "actual"}}
			input := []string{strings.ToUpper(id), id}
			got, err := f.run(current.Version, &input)
			if err != nil {
				t.Fatal(err)
			}
			want := f.after
			if tc.typ == model.TaskTypeGoal {
				want.Progress = &model.GoalProgress{Total: 2, Done: 1, Unfinished: 1}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("result\ngot  %#v\nwant %#v", got, want)
			}
			calls := []string{"authorize", "task", "resolve", "clock", "replace", "touch", "task"}
			if tc.typ == model.TaskTypeGoal {
				calls = append(calls, "progress")
			}
			assertTagEvents(t, f.events, calls...)
		})
	}
}
func TestReplaceTagsExplicitClear(t *testing.T) {
	_, current, _ := taskMockModels()
	current.Type = model.TaskTypeTask
	current.Tags = []model.TagReference{{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "previous"}}
	f := newTagServiceFixture(t, current)
	f.ids = []string{}
	f.after.Tags = []model.TagReference{}
	input := []string{}
	got, err := f.run(current.Version, &input)
	if err != nil || !reflect.DeepEqual(got, f.after) {
		t.Fatalf("clear result: %#v %v", got, err)
	}
	assertTagEvents(t, f.events, "authorize", "task", "resolve", "clock", "replace", "touch", "task")
}

func TestReplaceTagsRefusalsAndNoop(t *testing.T) {
	_, base, _ := taskMockModels()
	base.Type = model.TaskTypeTask
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	base.Tags = []model.TagReference{{ID: id, Name: "kept"}}
	for _, tc := range []struct {
		name    string
		input   *[]string
		version int64
		setup   func(*tagServiceFixture)
		code    string
		calls   []string
	}{
		{"omitted", nil, 1, nil, "", []string{"authorize", "task"}},
		{"same", &[]string{strings.ToUpper(id), id}, 1, func(f *tagServiceFixture) { f.ids = []string{id}; f.resolved = []model.Tag{{ID: id}} }, "", []string{"authorize", "task", "resolve"}},
		{"stale no-op", nil, 2, nil, "version_conflict", []string{"authorize", "task"}},
		{"invalid id", &[]string{"bad"}, 1, nil, "invalid_input", []string{"authorize", "task"}},
		{"missing or cross-project tag", &[]string{id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}, 1, func(f *tagServiceFixture) {
			f.ids = []string{id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}
			f.resolved = []model.Tag{{ID: id}}
		}, "tag_not_found", []string{"authorize", "task", "resolve"}},
		{"deleted task", nil, 1, func(f *tagServiceFixture) { f.readErr = model.ErrTaskDeleted }, "task_deleted", []string{"authorize", "task"}},
		{"permission", nil, 1, func(f *tagServiceFixture) { f.authErr = &model.Fault{Code: "forbidden", Message: "denied"} }, "forbidden", []string{"authorize"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTagServiceFixture(t, base)
			if tc.setup != nil {
				tc.setup(f)
			}
			got, err := f.run(tc.version, tc.input)
			if tc.code != "" {
				assertTagFault(t, err, tc.code)
				if !reflect.DeepEqual(got, model.Task{}) {
					t.Fatal("refusal returned a task")
				}
			} else if err != nil || !reflect.DeepEqual(got, base) {
				t.Fatalf("no-op: %#v %v", got, err)
			}
			assertTagEvents(t, f.events, tc.calls...)
		})
	}
}
func TestReplaceTagsCompletionAndAdmission(t *testing.T) {
	_, base, _ := taskMockModels()
	base.Type = model.TaskTypeTask
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, tc := range []struct {
		name  string
		setup func(*tagServiceFixture, error)
		calls []string
		limit bool
	}{
		{"resolve failure", func(f *tagServiceFixture, sentinel error) { f.resolveErr = sentinel }, []string{"authorize", "task", "resolve"}, false},
		{"clock failure", func(f *tagServiceFixture, sentinel error) { f.clockErr = sentinel }, []string{"authorize", "task", "resolve", "clock"}, false},
		{"replace failure", func(f *tagServiceFixture, sentinel error) { f.replaceErr = sentinel }, []string{"authorize", "task", "resolve", "clock", "replace"}, false},
		{"touch failure", func(f *tagServiceFixture, sentinel error) { f.touchErr = sentinel }, []string{"authorize", "task", "resolve", "clock", "replace", "touch"}, false},
		{"commit unknown", func(f *tagServiceFixture, sentinel error) {
			f.outcome = store.TransactionUnknown
			f.completionErr = &store.TransactionError{Phase: "commit", Cause: sentinel, Outcome: store.TransactionUnknown, CommitAttempted: true}
		}, []string{"authorize", "task", "resolve", "clock", "replace", "touch", "task"}, false},
		{"admission rollback", func(f *tagServiceFixture, _ error) {
			f.after.Description = strings.Repeat("x", taskcore.MaxTaskResponseJSONBytes)
		}, []string{"authorize", "task", "resolve", "clock", "replace", "touch", "task"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTagServiceFixture(t, base)
			f.ids, f.resolved = []string{id}, []model.Tag{{ID: id, Name: "tag"}}
			f.after.Tags = []model.TagReference{{ID: id, Name: "tag"}}
			sentinel := errors.New("controlled failure")
			tc.setup(f, sentinel)
			got, err := f.run(base.Version, &[]string{id})
			if !reflect.DeepEqual(got, model.Task{}) || err == nil {
				t.Fatalf("failure returned a task: %#v %v", got, err)
			}
			if tc.limit {
				assertTagFault(t, err, "resource_limit_exceeded")
				if f.callbackErr == nil {
					t.Fatal("admission failure did not reach transaction callback")
				}
			} else if !errors.Is(err, sentinel) {
				t.Fatalf("lost error cause: %v", err)
			}
			if tc.name == "commit unknown" {
				var failure *store.TransactionError
				if !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !failure.CommitAttempted || f.callbackErr != nil {
					t.Fatalf("unknown completion lost: %v", err)
				}
			}
			assertTagEvents(t, f.events, tc.calls...)
		})
	}
}

func TestReplaceTagsMCPAdmissionUsesReservedTaggedReceipt(t *testing.T) {
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, full := range []bool{false, true} {
		for _, overflow := range []bool{false, true} {
			t.Run(fmt.Sprintf("full=%t/overflow=%t", full, overflow), func(t *testing.T) {
				_, current, _ := taskMockModels()
				current.Type = model.TaskTypeTask
				f := newTagServiceFixture(t, current)
				f.ids = []string{id}
				f.resolved = []model.Tag{{ID: id, Name: "short"}}
				f.after.Tags = []model.TagReference{{ID: id, Name: "short"}}
				reserved := f.after
				reserved.Tags = []model.TagReference{{ID: id, Name: strings.Repeat("&", 64)}}
				reserved.Version = math.MaxInt64
				reserved.UpdatedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
				size, err := taskprotocol.EncodeMCPResponse(io.Discard, reserved, "request", "changed", "x", false, full, math.MaxInt64)
				if err != nil {
					t.Fatal(err)
				}
				length := taskcore.MaxTaskResponseJSONBytes - int(size) + 1
				if overflow {
					length++
				}
				f.ctx = taskservice.WithMCPTaskResponse(f.ctx, "request", strings.Repeat("x", length), false, false, full)
				got, err := f.run(current.Version, &[]string{id})
				if overflow {
					assertTagFault(t, err, "resource_limit_exceeded")
					if f.callbackErr == nil || !reflect.DeepEqual(got, model.Task{}) {
						t.Fatalf("admission must abort the write callback: %#v %v", got, err)
					}
				} else if err != nil || !reflect.DeepEqual(got, f.after) {
					t.Fatalf("exact reserved receipt: %#v %v", got, err)
				}
				assertTagEvents(t, f.events, "authorize", "task", "resolve", "clock", "replace", "touch", "task")
			})
		}
	}
}

// Leave enough room for the actual short tag name but less than the reserved
// legal rename. This uses the production encoders for the complete response.
func padTaggedWriteResponse(t *testing.T, task model.Task) string {
	t.Helper()
	untagged := task
	untagged.Tags = nil
	var largest int64
	for _, extended := range []bool{false, true} {
		size, err := taskprotocol.EncodeREST(io.Discard, untagged, extended, taskcore.MaxTaskResponseJSONBytes)
		if err != nil {
			t.Fatal(err)
		}
		largest = max(largest, size)
	}
	padding := int64(taskcore.MaxTaskResponseJSONBytes) - largest - 200
	if padding <= 0 {
		t.Fatal("fixture has no room for boundary padding")
	}
	description := strings.Repeat("x", int(padding))
	task.Description = description
	for _, extended := range []bool{false, true} {
		if _, err := taskprotocol.EncodeREST(io.Discard, task, extended, taskcore.MaxTaskResponseJSONBytes); err != nil {
			t.Fatalf("actual short tag response should fit: %v", err)
		}
	}
	return description
}

func TestTaggedPropertyAndWorkerWriteReceiptsParticipateInAdmission(t *testing.T) {
	for _, method := range []string{"property", "worker"} {
		for _, scenario := range []string{"ordinary tagged", "boundary untagged", "boundary tagged"} {
			t.Run(method+"/"+scenario, func(t *testing.T) {
				_, current, owner := taskMockModels()
				var input taskcore.UpdateWorker
				var props model.TaskProperties
				if method == "property" {
					props = propertyPatch(model.PullRequestProperty{URL: "value", Title: "title"})
				} else {
					var descriptor taskcore.WorkerDescriptor
					current, owner, descriptor = workerTestCurrent(t, model.WorkerActive)
					next := *testWorker(t, current.Properties)
					next.Phase = model.WorkerExecuting
					props = testWithWorker(t, current.Properties, &next)
					input = taskcore.UpdateWorker{Version: current.Version, ClaimID: descriptor.ClaimID, Phase: &next.Phase}
				}
				ref := model.TagReference{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "short"}
				current.Tags = []model.TagReference{ref}
				result := propertyTaskResult(current, props)
				if scenario != "ordinary tagged" {
					current.Description = padTaggedWriteResponse(t, result)
					result.Description = current.Description
					if scenario == "boundary untagged" {
						current.Tags = nil
						result.Tags = nil
					}
				}
				var finish func(error) (store.Completion, error)
				if scenario == "boundary tagged" {
					finish = propertyAbort(t, func(err error) { assertTagFault(t, err, "resource_limit_exceeded") })
				} else {
					finish = propertyCommit(t)
				}
				f := newPropertyWriteFixture(t, current, finish)
				f.expectUpdate(propertyExpectedWrite(current, props), result, nil)
				if scenario == "boundary tagged" {
					f.wantDrains, f.wantReceipts = 0, 0
				}
				var got model.Task
				var err error
				if method == "property" {
					got, err = f.tasks.SetProperty(f.ctx, owner, f.project.ID, current.ID, "pullRequests", string(props["pullRequests"]), current.Version)
				} else {
					got, err = f.tasks.UpdateWorker(f.ctx, owner, f.project.ID, current.ID, input)
				}
				if scenario == "boundary tagged" {
					assertTagFault(t, err, "resource_limit_exceeded")
					if !reflect.DeepEqual(got, model.Task{}) {
						t.Fatal("oversized response returned a Task")
					}
				} else if err != nil || !reflect.DeepEqual(got, result) {
					t.Fatalf("write response: %#v %v", got, err)
				}
			})
		}
	}
}
