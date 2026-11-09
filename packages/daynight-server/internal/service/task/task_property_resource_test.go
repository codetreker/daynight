package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type propertyWriteFixture struct {
	t                                                           *testing.T
	ctx                                                         context.Context
	project                                                     model.Project
	principal                                                   model.Principal
	current                                                     model.Task
	tasks                                                       *taskservice.Tasks
	dao                                                         *taskWriterMock
	sessions                                                    *projectSessionMock
	store                                                       *taskStoreMock
	capture                                                     *propertyCapturer
	taskReads, writes, scopes, drains, receipts                 int
	wantReads, wantWrites, wantScopes, wantDrains, wantReceipts int
}

type propertyCapturer struct {
	t        *testing.T
	expected bool
	calls    int
	check    func(context.Context, []protocol.Fact)
}

func (capture *propertyCapturer) CaptureBatch(ctx context.Context, _ store.WebhookCaptureDAO, facts []protocol.Fact) error {
	capture.calls++
	if !capture.expected {
		capture.t.Fatal("unexpected property source capture")
	}
	capture.check(ctx, facts)
	return nil
}

type propertyCaptureDAO struct{ t *testing.T }

func (dao *propertyCaptureDAO) unexpected() {
	dao.t.Helper()
	dao.t.Error("property source test unexpectedly accessed capture persistence")
	panic("unexpected capture DAO access")
}
func (dao *propertyCaptureDAO) FreezeAudience(context.Context, string, []string) ([]store.WebhookAudience, error) {
	dao.unexpected()
	return nil, nil
}
func (dao *propertyCaptureDAO) RecordedAt(context.Context) (time.Time, error) {
	dao.unexpected()
	return time.Time{}, nil
}
func (dao *propertyCaptureDAO) Policy(context.Context, int64) (webhookmodel.Policy, error) {
	dao.unexpected()
	return webhookmodel.Policy{}, nil
}
func (dao *propertyCaptureDAO) SaveCapture(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error {
	dao.unexpected()
	return nil
}

func propertyCommit(t *testing.T) func(error) (store.Completion, error) {
	return func(err error) (store.Completion, error) {
		t.Helper()
		if err != nil {
			t.Fatalf("unexpected write callback failure: %v", err)
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

func propertyAbort(t *testing.T, check func(error)) func(error) (store.Completion, error) {
	return func(err error) (store.Completion, error) {
		t.Helper()
		if err == nil {
			t.Fatal("write callback did not propagate its failure")
		}
		check(err)
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
}

func newPropertyWriteFixture(t *testing.T, current model.Task, complete func(error) (store.Completion, error)) *propertyWriteFixture {
	t.Helper()
	project, _, principal := taskMockModels()
	base := newTaskMockBase(t, "property")
	f := &propertyWriteFixture{t: t, ctx: t.Context(), project: project, principal: principal, current: current, wantReads: 1, wantScopes: 1}
	f.dao = &taskWriterMock{taskMockBase: base.withLabel("tasks")}
	f.dao.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		f.taskReads++
		if ctx != f.ctx || id != current.ID {
			t.Fatal("property read changed context or Task identity")
		}
		return current, nil
	}
	projects := &projectWriterMock{taskMockBase: base.withLabel("projects")}
	projects.ProjectAccessFn = func(ctx context.Context, actual model.Principal) (model.ProjectAccess, error) {
		if ctx != f.ctx || actual != principal {
			t.Fatal("property write changed authenticated principal or context")
		}
		return taskMockAccess(project, principal), nil
	}
	f.sessions = &projectSessionMock{taskMockBase: base.withLabel("sessions")}
	scope := &taskProjectScopeMock{taskMockBase: base.withLabel("scope"), ProjectDAOFn: func() store.ProjectWriteDAO { return projects }, TaskDAOFn: func() store.TaskWriteDAO { return f.dao }, SessionDAOFn: func() store.ProjectSessionDAO { return f.sessions }}
	captureDAO := &propertyCaptureDAO{t: t}
	scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return captureDAO }
	f.store = &taskStoreMock{taskMockBase: base.withLabel("store")}
	f.store.WriteProjectFn = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		f.scopes++
		if ctx != f.ctx || id != project.ID || work == nil {
			t.Fatal("property write left its Project scope")
		}
		return complete(work(scope))
	}
	f.capture = &propertyCapturer{t: t}
	f.tasks = taskservice.NewTasks(f.store, f.capture)
	t.Cleanup(func() {
		if f.taskReads != f.wantReads || f.writes != f.wantWrites || f.scopes != f.wantScopes || f.drains != f.wantDrains || f.receipts != f.wantReceipts {
			t.Errorf("property calls reads/writes/scopes/drains/receipts=%d/%d/%d/%d/%d, want %d/%d/%d/%d/%d", f.taskReads, f.writes, f.scopes, f.drains, f.receipts, f.wantReads, f.wantWrites, f.wantScopes, f.wantDrains, f.wantReceipts)
		}
		wantCapture := 0
		if f.capture.expected {
			wantCapture = 1
		}
		if f.capture.calls != wantCapture {
			t.Errorf("property capture calls=%d, want %d", f.capture.calls, wantCapture)
		}
	})
	return f
}

func propertyPropertiesEqual(t *testing.T, actual, want model.TaskProperties) bool {
	t.Helper()
	if len(actual) != len(want) {
		return false
	}
	for name, expected := range want {
		raw, exists := actual[name]
		if !exists {
			return false
		}
		decode := func(side string, value json.RawMessage) any {
			t.Helper()
			normalized, err := taskproperties.NormalizeValue(name, value)
			if err != nil {
				t.Fatalf("invalid %s property %q: %v", side, name, err)
			}
			decoder := json.NewDecoder(bytes.NewReader(normalized))
			decoder.UseNumber()
			var result any
			if err := decoder.Decode(&result); err != nil {
				t.Fatalf("decode %s property %q: %v", side, name, err)
			}
			return result
		}
		if !reflect.DeepEqual(decode("actual", raw), decode("expected", expected)) {
			return false
		}
	}
	return true
}

func propertyWritesEqual(t *testing.T, actual, want store.TaskWrite) bool {
	t.Helper()
	actualProperties, wantProperties := actual.Properties, want.Properties
	actual.Properties, want.Properties = nil, nil
	return reflect.DeepEqual(actual, want) && propertyPropertiesEqual(t, actualProperties, wantProperties)
}

func propertyExpectedWrite(current model.Task, properties model.TaskProperties) store.TaskWrite {
	return store.TaskWrite{AssignedTo: current.AssignedTo, RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents, Title: current.Title, Description: current.Description, Properties: properties, Status: current.Status, DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn}
}

func (f *propertyWriteFixture) expectUpdate(want store.TaskWrite, result model.Task, failure error) {
	f.wantWrites = 1
	f.dao.UpdateTaskFn = func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
		f.writes++
		if ctx != f.ctx || id != f.current.ID || !propertyWritesEqual(f.t, actual, want) {
			f.t.Fatalf("property DAO write: id=%s values=%#v, want %#v", id, actual, want)
		}
		return result, failure
	}
	if failure != nil {
		return
	}
	f.wantDrains, f.wantReceipts = 1, 1
	f.sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, _ store.TaskSessionDrain) error {
		f.drains++
		if ctx != f.ctx || id != f.current.ID {
			f.t.Fatal("property write froze another Task")
		}
		return nil
	}
	f.sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, _ store.TaskSessionReceiptTransition) error {
		f.receipts++
		if ctx != f.ctx || id != f.current.ID || f.drains != 1 {
			f.t.Fatal("property receipt transition preceded its Task drain")
		}
		return nil
	}
}

func propertyTaskResult(current model.Task, properties model.TaskProperties) model.Task {
	result := current
	result.Version++
	result.UpdatedAt = current.UpdatedAt.Add(time.Microsecond)
	result.Properties = maps.Clone(properties)
	return result
}

func TestTaskPropertySetRemovePresenceAndVersion(t *testing.T) {
	_, target, _ := taskMockModels()
	value := `[{"url":"opaque\u0000","title":"Evidence"}]`
	normalized := model.TaskProperties{"pullRequests": json.RawMessage(value)}
	changed := propertyTaskResult(target, normalized)
	removed := propertyTaskResult(changed, model.TaskProperties{})
	empty := propertyTaskResult(removed, model.TaskProperties{"pullRequests": json.RawMessage(`[]`)})
	cases := []struct {
		name            string
		current, result model.Task
		property, input string
		version         int64
		remove, write   bool
		fault           string
	}{
		{name: "set", current: target, result: changed, property: "pullRequests", input: value, version: target.Version, write: true},
		{name: "equivalent set", current: changed, result: changed, property: "pullRequests", input: ` [ { "title":"Evidence", "url":"opaque\u0000" } ] `, version: changed.Version},
		{name: "stale set", current: changed, property: "pullRequests", input: value, version: target.Version, fault: "version_conflict"},
		{name: "remove", current: changed, result: removed, property: "pullRequests", version: changed.Version, remove: true, write: true},
		{name: "absent remove", current: removed, result: removed, property: "pullRequests", version: removed.Version, remove: true},
		{name: "stale remove", current: removed, property: "pullRequests", version: changed.Version, remove: true, fault: "version_conflict"},
		{name: "present empty array", current: removed, result: empty, property: "pullRequests", input: `[]`, version: removed.Version, write: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newPropertyWriteFixture(t, tc.current, propertyCommit(t))
			if tc.write {
				f.expectUpdate(propertyExpectedWrite(tc.current, tc.result.Properties), tc.result, nil)
			}
			var actual model.Task
			var err error
			if tc.remove {
				actual, err = f.tasks.RemoveProperty(f.ctx, f.principal, f.project.ID, tc.current.ID, tc.property, tc.version)
			} else {
				actual, err = f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, tc.current.ID, tc.property, tc.input, tc.version)
			}
			if tc.fault != "" {
				requireFault(t, err, tc.fault)
				return
			}
			if err != nil || !reflect.DeepEqual(actual, tc.result) {
				t.Fatalf("property result: %#v, %v; want %#v", actual, err, tc.result)
			}
		})
	}
	for _, input := range []struct{ name, value string }{{"unknown", "[]"}, {"worker", "{}"}, {"pullRequests", "null"}, {"pullRequests", `[{"url":"u","title":"t","title":"again"}]`}, {"pullRequests", `[] []`}, {"pullRequests", `{"private":"not-an-array"}`}} {
		t.Run("invalid set/"+input.value, func(t *testing.T) {
			f := newPropertyWriteFixture(t, empty, propertyCommit(t))
			_, err := f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, empty.ID, input.name, input.value, empty.Version)
			requireFault(t, err, "invalid_input")
		})
	}
	for _, name := range []string{"unknown", "worker"} {
		t.Run("invalid remove/"+name, func(t *testing.T) {
			f := newPropertyWriteFixture(t, empty, propertyCommit(t))
			f.wantReads, f.wantScopes = 0, 0
			_, err := f.tasks.RemoveProperty(f.ctx, f.principal, f.project.ID, empty.ID, name, empty.Version)
			requireFault(t, err, "invalid_input")
		})
	}
}

func propertyActiveTask(t *testing.T) model.Task {
	_, target, principal := taskMockModels()
	target.Status = model.TaskInProgress
	target.Ready = false
	target.Version = 2
	target.UpdatedAt = target.CreatedAt.Add(time.Microsecond)
	target.StartedAt = pointer(target.UpdatedAt)
	target.AllowAgents = true
	descriptor := workerDescriptor()
	descriptor.AgentControlMode = model.AgentControlModeHerdr
	claim := &model.WorkerClaim{ClaimID: descriptor.ClaimID, State: model.WorkerActive, UserID: principal.UserID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode, WorktreeID: descriptor.WorktreeID, Phase: model.WorkerPreparing, ClaimedAt: target.UpdatedAt}
	target.Properties = testWithWorker(t, target.Properties, claim)
	return target
}

func TestTaskPropertyWritesPreserveWorkerAndWriteFailure(t *testing.T) {
	target := propertyActiveTask(t)
	props := maps.Clone(target.Properties)
	props["pullRequests"] = json.RawMessage(`[]`)
	changed := propertyTaskResult(target, props)
	t.Run("preserve execution", func(t *testing.T) {
		f := newPropertyWriteFixture(t, target, propertyCommit(t))
		f.expectUpdate(propertyExpectedWrite(target, props), changed, nil)
		actual, err := f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, target.ID, "pullRequests", `[]`, target.Version)
		if err != nil || !reflect.DeepEqual(actual, changed) || !reflect.DeepEqual(testWorker(t, actual.Properties), testWorker(t, target.Properties)) || !reflect.DeepEqual(actual.StartedAt, target.StartedAt) {
			t.Fatalf("property changed execution: %#v %v", actual, err)
		}
	})
	for _, remove := range []bool{false, true} {
		t.Run(map[bool]string{false: "set failure", true: "remove failure"}[remove], func(t *testing.T) {
			sentinel := errors.New("property DAO failed")
			f := newPropertyWriteFixture(t, changed, propertyAbort(t, func(err error) {
				if !errors.Is(err, sentinel) {
					t.Fatalf("callback lost DAO cause: %v", err)
				}
			}))
			next := maps.Clone(props)
			if remove {
				delete(next, "pullRequests")
			} else {
				next["pullRequests"] = json.RawMessage(`[{"url":"new","title":"new"}]`)
			}
			f.expectUpdate(propertyExpectedWrite(changed, next), model.Task{}, sentinel)
			var actual model.Task
			var err error
			if remove {
				actual, err = f.tasks.RemoveProperty(f.ctx, f.principal, f.project.ID, changed.ID, "pullRequests", changed.Version)
			} else {
				actual, err = f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, changed.ID, "pullRequests", string(next["pullRequests"]), changed.Version)
			}
			assertOperational(t, err)
			if !errors.Is(err, sentinel) || !reflect.DeepEqual(actual, model.Task{}) {
				t.Fatalf("property failure exposed candidate or lost cause: %#v %v", actual, err)
			}
		})
	}
}

func TestTaskPausedPropertyPreservesActiveExecutionAndPresence(t *testing.T) {
	target := propertyActiveTask(t)
	target.Properties["pullRequests"] = json.RawMessage(`[{"url":"pull-request","title":"Evidence"}]`)
	current := target
	for _, value := range []string{"true", "false"} {
		props := maps.Clone(current.Properties)
		props["paused"] = json.RawMessage(value)
		changed := propertyTaskResult(current, props)
		t.Run("set "+value, func(t *testing.T) {
			f := newPropertyWriteFixture(t, current, propertyCommit(t))
			f.expectUpdate(propertyExpectedWrite(current, props), changed, nil)
			if value == "true" {
				f.capture.expected = true
				f.capture.check = func(ctx context.Context, facts []protocol.Fact) {
					if ctx != f.ctx || len(facts) != 1 || facts[0].Type != protocol.Paused || !facts[0].Paused || facts[0].TaskID != current.ID {
						t.Fatalf("pause source facts: %#v", facts)
					}
				}
			}
			actual, err := f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, current.ID, "paused", value, current.Version)
			if err != nil || !reflect.DeepEqual(actual, changed) {
				t.Fatalf("pause result: %#v %v", actual, err)
			}
			withoutPause := actual
			withoutPause.Version = target.Version
			withoutPause.UpdatedAt = target.UpdatedAt
			withoutPause.Properties = maps.Clone(actual.Properties)
			delete(withoutPause.Properties, "paused")
			if !reflect.DeepEqual(withoutPause, target) {
				t.Fatal("pause mutation changed active execution")
			}
		})
		t.Run("equivalent "+value, func(t *testing.T) {
			f := newPropertyWriteFixture(t, changed, propertyCommit(t))
			actual, err := f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, changed.ID, "paused", " \n"+value+" ", changed.Version)
			if err != nil || !reflect.DeepEqual(actual, changed) {
				t.Fatalf("equivalent pause changed Task: %#v %v", actual, err)
			}
		})
		for _, remove := range []bool{false, true} {
			t.Run("stale "+value+map[bool]string{false: " set", true: " remove"}[remove], func(t *testing.T) {
				f := newPropertyWriteFixture(t, changed, propertyCommit(t))
				var err error
				if remove {
					_, err = f.tasks.RemoveProperty(f.ctx, f.principal, f.project.ID, changed.ID, "paused", current.Version)
				} else {
					_, err = f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, changed.ID, "paused", value, current.Version)
				}
				requireFault(t, err, "version_conflict")
			})
		}
		current = changed
	}
	props := maps.Clone(current.Properties)
	delete(props, "paused")
	removed := propertyTaskResult(current, props)
	t.Run("remove presence", func(t *testing.T) {
		f := newPropertyWriteFixture(t, current, propertyCommit(t))
		f.expectUpdate(propertyExpectedWrite(current, props), removed, nil)
		actual, err := f.tasks.RemoveProperty(f.ctx, f.principal, f.project.ID, current.ID, "paused", current.Version)
		if err != nil || !reflect.DeepEqual(actual, removed) {
			t.Fatalf("pause removal: %#v %v", actual, err)
		}
	})
	t.Run("absent removal", func(t *testing.T) {
		f := newPropertyWriteFixture(t, removed, propertyCommit(t))
		actual, err := f.tasks.RemoveProperty(f.ctx, f.principal, f.project.ID, removed.ID, "paused", removed.Version)
		if err != nil || !reflect.DeepEqual(actual, removed) {
			t.Fatalf("absent pause removal: %#v %v", actual, err)
		}
	})
	for _, value := range []string{"null", `"true"`, "1", "[]", "{}", "true false"} {
		t.Run("invalid pause/"+value, func(t *testing.T) {
			f := newPropertyWriteFixture(t, removed, propertyCommit(t))
			_, err := f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, removed.ID, "paused", value, removed.Version)
			requireFault(t, err, "invalid_input")
		})
	}
}
