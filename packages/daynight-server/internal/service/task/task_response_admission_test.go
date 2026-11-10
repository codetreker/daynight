package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func TestTaskResponseAdmissionPropagatesPostWriteFailure(t *testing.T) {
	project, target, _ := taskMockModels()
	prerequisite := target
	prerequisite.ID = "66666666-6666-4666-8666-666666666666"
	props := propertyPatch(model.PullRequestProperty{URL: "value", Title: "title"})
	assertLimit := func(t *testing.T, err error) {
		t.Helper()
		fault, ok := operation.KnownFault(err)
		var violation *limit.Violation
		facts := operation.CompletionFacts(err)
		if !ok || fault.Code != "resource_limit_exceeded" || !errors.As(err, &violation) || facts.Outcome != store.TransactionNotCommitted || facts.CleanupFailed {
			t.Fatalf("response completion did not retain its measured refusal: %v (%+v)", err, facts)
		}
	}
	for _, method := range []string{"update", "create"} {
		t.Run(method+" refusal before scope completion", func(t *testing.T) {
			f := newPropertyWriteFixture(t, target, propertyAbort(t, func(err error) {
				var violation *limit.Violation
				if !errors.As(err, &violation) {
					t.Fatalf("callback lost measured response limit: %v", err)
				}
			}))
			f.ctx = taskservice.WithMCPTaskResponse(t.Context(), strings.Repeat("r", taskcore.MaxTaskResponseJSONBytes), int64(1), false, false, true)
			f.dao.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
				if ctx != f.ctx || !slices.Equal(ids, []string{prerequisite.ID}) {
					t.Fatal("response candidate changed dependencies")
				}
				return []model.Task{prerequisite}, nil
			}
			f.dao.ReachableFn = func(ctx context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
				if ctx != f.ctx || from != prerequisite.ID || to != replacement.TaskID || !slices.Equal(replacement.DependsOn, []string{prerequisite.ID}) {
					t.Fatal("response candidate changed reachability scope")
				}
				return false, nil
			}
			var actual model.Task
			var err error
			if method == "update" {
				changed := propertyTaskResult(target, props)
				changed.Title = "Changed"
				changed.DependsOn = []string{prerequisite.ID}
				changed.BlockedBy = []string{prerequisite.ID}
				changed.Ready = false
				want := propertyExpectedWrite(target, props)
				want.Title = "Changed"
				want.DependsOn = []string{prerequisite.ID}
				f.expectUpdate(want, changed, nil)
				f.wantDrains, f.wantReceipts = 0, 0
				actual, err = f.tasks.Update(f.ctx, f.principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Changed"), DependsOn: pointer([]string{prerequisite.ID}), Properties: props})
			} else {
				f.wantReads = 0
				f.wantWrites = 1
				f.dao.CreateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
					f.writes++
					if _, err := uuid.Parse(id); err != nil || ctx != f.ctx || values.Title != "Rejected" || values.Status != model.TaskProposed || !slices.Equal(values.DependsOn, []string{prerequisite.ID}) {
						t.Fatalf("response create candidate: %#v id=%s", values, id)
					}
					row := target
					row.ID = id
					row.Title = "Rejected"
					row.Status = model.TaskProposed
					row.DependsOn = []string{prerequisite.ID}
					row.BlockedBy = []string{prerequisite.ID}
					row.Ready = false
					row.AssignedTo = nil
					return row, nil
				}
				actual, err = f.tasks.Create(f.ctx, f.principal, project.ID, taskcore.CreateTask{Title: "Rejected", DependsOn: []string{prerequisite.ID}})
			}
			assertLimit(t, err)
			if !reflect.DeepEqual(actual, model.Task{}) {
				t.Fatalf("response refusal exposed a Task candidate: %#v", actual)
			}
		})
	}
	changed := propertyTaskResult(target, target.Properties)
	changed.Title = "Changed"
	t.Run("ordinary MCP response", func(t *testing.T) {
		f := newPropertyWriteFixture(t, target, propertyCommit(t))
		f.ctx = taskservice.WithMCPTaskResponse(t.Context(), "request", int64(1), false, false, true)
		f.dao.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			if ctx != f.ctx || len(ids) != 0 {
				t.Fatal("ordinary response changed dependencies")
			}
			return []model.Task{}, nil
		}
		want := propertyExpectedWrite(target, target.Properties)
		want.Title = "Changed"
		f.expectUpdate(want, changed, nil)
		actual, err := f.tasks.Update(f.ctx, f.principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Changed")})
		if err != nil || !reflect.DeepEqual(actual, changed) {
			t.Fatalf("ordinary MCP response: %#v %v", actual, err)
		}
	})
	t.Run("MCP no-op response", func(t *testing.T) {
		f := newPropertyWriteFixture(t, changed, propertyCommit(t))
		f.ctx = taskservice.WithMCPTaskResponse(t.Context(), "request", int64(1), false, false, true)
		f.dao.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			if ctx != f.ctx || len(ids) != 0 {
				t.Fatal("unchanged response changed dependencies")
			}
			return []model.Task{}, nil
		}
		actual, err := f.tasks.Update(f.ctx, f.principal, project.ID, changed.ID, taskcore.UpdateTask{Version: changed.Version, Title: pointer(changed.Title)})
		if err != nil || !reflect.DeepEqual(actual, changed) {
			t.Fatalf("MCP no-op response: %#v %v", actual, err)
		}
	})
}

func TestWorkerLimitsRejectClaimAndStartupBeforeWrites(t *testing.T) {
	_, target, owner := taskMockModels()
	target.AllowAgents = true
	descriptor := workerDescriptor()
	descriptor.AgentControlMode = model.AgentControlModeWeb
	descriptor.Machine.Name = strings.Repeat("m", taskproperties.MaxWorkerMachineNameBytes+1)
	t.Run("oversized claim", func(t *testing.T) {
		f := newPropertyWriteFixture(t, target, propertyCommit(t))
		f.dao.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			if ctx != f.ctx {
				t.Fatal("claim clock context changed")
			}
			return target.UpdatedAt, nil
		}
		_, err := f.tasks.ClaimWorker(f.ctx, owner, f.project.ID, target.ID, taskcore.ClaimWorker{Version: target.Version, WorkerDescriptor: descriptor})
		requireFault(t, err, "invalid_input")
	})
	descriptor.Machine.Name = strings.Repeat("m", taskproperties.MaxWorkerMachineNameBytes)
	observed := target.UpdatedAt.Add(time.Microsecond)
	worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, State: model.WorkerActive, UserID: owner.UserID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode, WorktreeID: descriptor.WorktreeID, Phase: model.WorkerPreparing, ClaimedAt: observed}
	props := testWithWorker(t, target.Properties, worker)
	claimed := propertyTaskResult(target, props)
	claimed.Status = model.TaskInProgress
	claimed.StartedAt = pointer(observed)
	claimed.Ready = false
	t.Run("legal claim", func(t *testing.T) {
		f := newPropertyWriteFixture(t, target, propertyCommit(t))
		f.dao.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			if ctx != f.ctx {
				t.Fatal("claim clock context changed")
			}
			return observed, nil
		}
		want := propertyExpectedWrite(target, props)
		want.Status = model.TaskInProgress
		f.expectUpdate(want, claimed, nil)
		f.capture.expected = true
		f.capture.check = func(ctx context.Context, facts []protocol.Fact) {
			if ctx != f.ctx || len(facts) != 1 || facts[0].Type != protocol.StatusChanged || facts[0].PreviousStatus != string(model.TaskTodo) || facts[0].Status != string(model.TaskInProgress) || facts[0].TaskID != claimed.ID || facts[0].TaskVersion != claimed.Version {
				t.Fatalf("claim status capture: %#v", facts)
			}
		}
		actual, err := f.tasks.ClaimWorker(f.ctx, owner, f.project.ID, target.ID, taskcore.ClaimWorker{Version: target.Version, WorkerDescriptor: descriptor})
		if err != nil || !reflect.DeepEqual(actual, claimed) {
			t.Fatalf("legal worker claim: %#v %v", actual, err)
		}
	})
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: uuid.NewString(), ClaimID: descriptor.ClaimID, ExecutionGeneration: "1", ControllerInstanceID: uuid.NewString(), Revision: "2", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode = "ready", "ready"
	report.Recovery.State = "none"
	for _, legal := range []bool{false, true} {
		t.Run(map[bool]string{false: "oversized native session", true: "legal native session and startup"}[legal], func(t *testing.T) {
			native := strings.Repeat("n", taskproperties.MaxWorkerNativeSessionIDBytes)
			if !legal {
				native += "n"
			}
			f := newPropertyWriteFixture(t, claimed, propertyCommit(t))
			matches := 0
			f.sessions.MatchSessionStartupFn = func(ctx context.Context, id string, current *model.WorkerClaim, actual sp.StartupReport) (bool, error) {
				matches++
				if ctx != f.ctx || id != claimed.ID || !reflect.DeepEqual(current, worker) || !reflect.DeepEqual(actual, report) {
					t.Fatal("startup matching changed bound worker or report")
				}
				return true, nil
			}
			var wantResult model.Task
			if legal {
				next := *worker
				next.NativeSessionID = pointer(native)
				nextProps := testWithWorker(t, claimed.Properties, &next)
				raw, err := json.Marshal(report)
				if err != nil {
					t.Fatal(err)
				}
				nextProps["sessionStartup"], err = taskproperties.NormalizeValue("sessionStartup", raw)
				if err != nil {
					t.Fatal(err)
				}
				wantResult = propertyTaskResult(claimed, nextProps)
				f.expectUpdate(propertyExpectedWrite(claimed, nextProps), wantResult, nil)
			}
			actual, err := f.tasks.UpdateWorker(f.ctx, owner, f.project.ID, claimed.ID, taskcore.UpdateWorker{Version: claimed.Version, ClaimID: descriptor.ClaimID, NativeSessionID: pointer(&native), StartupReport: &report})
			if !legal {
				requireFault(t, err, "invalid_input")
			} else {
				stored, decodeErr := taskproperties.SessionStartup(actual.Properties)
				if err != nil || decodeErr != nil || !reflect.DeepEqual(actual, wantResult) || !reflect.DeepEqual(stored, &report) || *testWorker(t, actual.Properties).NativeSessionID != native {
					t.Fatalf("legal worker startup: %#v %v decode=%v", actual, err, decodeErr)
				}
			}
			if matches != 1 {
				t.Fatalf("startup matching calls=%d", matches)
			}
		})
	}
}

func TestPartitionAndPropertyAdmissionPreservesVersionPrecedence(t *testing.T) {
	_, target, _ := taskMockModels()
	deps := make([]string, taskcore.MaxDependencies+1)
	for i := range deps {
		deps[i] = "invalid"
	}
	value := `[{"url":"` + strings.Repeat("x", 2049) + `","title":""}]`
	for _, method := range []string{"partition", "property"} {
		for _, stale := range []bool{true, false} {
			t.Run(method+map[bool]string{true: " stale", false: " current"}[stale], func(t *testing.T) {
				f := newPropertyWriteFixture(t, target, propertyCommit(t))
				before := maps.Clone(target.Properties)
				version := target.Version
				if stale {
					version++
				}
				var err error
				if method == "partition" {
					_, err = f.tasks.UpdatePartitionedDependencies(f.ctx, f.principal, f.project.ID, target.ID, taskcore.UpdateTask{Version: version}, &deps, nil)
				} else {
					_, err = f.tasks.SetProperty(f.ctx, f.principal, f.project.ID, target.ID, "pullRequests", value, version)
				}
				want := "invalid_input"
				if stale {
					want = "version_conflict"
				}
				requireFault(t, err, want)
				if !reflect.DeepEqual(target.Properties, before) {
					t.Fatal("refusal changed input properties")
				}
			})
		}
	}
}
