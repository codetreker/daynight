package worker

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/google/uuid"
)

type admissionServiceFixture struct {
	t                 *testing.T
	ctx               context.Context
	principal         model.Principal
	worker            string
	service           *Workers
	input, normalized model.WorkerReport
	parsed            *model.WorkerConfigurationExchange
	admission         store.WorkerAdmission
	sources           []store.WorkerTaskSource
	items             []model.WorkerObservedTask
	proposed, stored  model.WorkerSnapshot
	receipt           *model.WorkerConfigurationReceipt
	configuration     model.WorkerConfigurationResource
	observed          time.Time
	want, calls       []string
	failAt            string
	failure           error
	completion        store.Completion
	completionError   error
	callbackError     error
	release           chan struct{}
	entered           chan struct{}
}

func newAdmissionServiceFixture(t *testing.T) *admissionServiceFixture {
	t.Helper()
	at := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	f := &admissionServiceFixture{
		t: t, ctx: t.Context(), principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()},
		worker: uuid.NewString(), admission: store.WorkerAdmission{ObservedAt: at, LastSeenAt: &at, ActiveCount: 99},
		observed: at.Add(8 * time.Second), completion: store.Completion{Outcome: store.TransactionCommitted},
		want: []string{"validate", "parse", "write", "dao", "admission", "admit", "sources", "match", "snapshot", "upsert", "exchange", "configuration", "clock", "completion"},
	}
	f.input = serviceWorkerReport()
	f.input.Telemetry.AssistantHost = admissionAssistantHost("/input-assistant-host")
	f.input.Telemetry.SampledAt = at.Add(24 * time.Hour)
	f.input.TaskInventory = &model.WorkerTaskInventory{ObservedAt: at, Claims: []model.WorkerTaskReference{}}
	bootstrap := cloudWorkerConfiguration("")
	f.input.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &bootstrap}
	f.normalized = f.input
	f.normalized.Telemetry.AssistantHost = admissionAssistantHost("/normalized-assistant-host")
	f.normalized.Telemetry.Machine.Name = "Normalized report"
	f.parsed = &model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}}
	f.sources = []store.WorkerTaskSource{{Task: model.Task{ID: uuid.NewString(), Title: "Supplied source"}, ProjectName: "Project"}}
	f.items = []model.WorkerObservedTask{}
	f.proposed = model.WorkerSnapshot{
		UserID: f.principal.UserID, WorkerID: f.worker, CreatedAt: at, LastReportedAt: at,
		Telemetry:    f.normalized.Telemetry,
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &at, InventoryObservedAt: &at, Items: []model.WorkerObservedTask{}},
	}
	f.proposed.Telemetry.Machine.Name = "Supplied Core snapshot"
	f.proposed.Telemetry.AssistantHost = admissionAssistantHost("/snapshot-assistant-host")
	storedTelemetry := serviceWorkerReport().Telemetry
	storedTelemetry.Machine.Name = "Supplied DAO result"
	storedTelemetry.AssistantHost = admissionAssistantHost("/stored-assistant-host")
	f.stored = model.WorkerSnapshot{
		UserID: f.principal.UserID, WorkerID: f.worker, CreatedAt: at.Add(-time.Hour), LastReportedAt: at.Add(7 * time.Second),
		Telemetry:    storedTelemetry,
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}},
	}
	f.receipt = &model.WorkerConfigurationReceipt{Desired: &model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: at, Value: bootstrap}, ObservationRevision: "1", ObservationAccepted: true}
	f.configuration = model.WorkerConfigurationResource{Observation: &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: *f.parsed.Observation, ReportedAt: at}}
	f.service = NewWorkers(f)
	f.service.report = reportOperations{
		validate: func(input model.WorkerReport) (model.WorkerReport, error) {
			f.take("validate")
			if !reflect.DeepEqual(input, f.input) {
				t.Errorf("validation input = %+v, want %+v", input, f.input)
			}
			return f.normalized, f.operationError("validate")
		},
		parseConfiguration: func(raw json.RawMessage) (*model.WorkerConfigurationExchange, error) {
			f.take("parse")
			want, err := json.Marshal(f.normalized.Configuration)
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != string(want) {
				t.Errorf("configuration parse input = %s, want %s", raw, want)
			}
			return f.parsed, f.operationError("parse")
		},
		admit: func(input store.WorkerAdmission) error {
			f.take("admit")
			if !reflect.DeepEqual(input, f.admission) {
				t.Errorf("admission decision facts = %+v, want %+v", input, f.admission)
			}
			return f.operationError("admit")
		},
		matchTasks: func(sources []store.WorkerTaskSource, inventory model.WorkerTaskInventory, user, worker string) ([]model.WorkerObservedTask, error) {
			f.take("match")
			if user != f.principal.UserID || worker != f.worker || !reflect.DeepEqual(sources, f.sources) || !reflect.DeepEqual(inventory, *f.normalized.TaskInventory) {
				t.Errorf("task matching arguments = %s/%s %+v %+v", user, worker, sources, inventory)
			}
			return f.items, f.operationError("match")
		},
		snapshot: func(user, worker string, input model.WorkerReport, observed time.Time, items []model.WorkerObservedTask) model.WorkerSnapshot {
			f.take("snapshot")
			want := f.normalized
			want.Configuration = f.parsed
			if user != f.principal.UserID || worker != f.worker || !reflect.DeepEqual(input, want) || observed != f.admission.ObservedAt || !reflect.DeepEqual(items, f.items) {
				t.Errorf("snapshot arguments = %s/%s %+v %v %+v", user, worker, input, observed, items)
			}
			return f.proposed
		},
		exchangeConfiguration: func(ctx context.Context, dao store.WorkerWriteDAO, principal model.Principal, worker string, input model.WorkerConfigurationExchange) (*model.WorkerConfigurationReceipt, error) {
			f.take("exchange")
			if f.parsed == nil {
				t.Fatal("configuration exchange called without parsed configuration")
			}
			f.checkContext(ctx)
			if dao != f || principal != f.principal || worker != f.worker || !reflect.DeepEqual(input, *f.parsed) {
				t.Errorf("configuration exchange arguments = %p %+v %s %+v", dao, principal, worker, input)
			}
			return f.receipt, f.operationError("exchange")
		},
	}
	t.Cleanup(func() {
		if !reflect.DeepEqual(f.calls, f.want) {
			t.Errorf("report calls = %v, want %v", f.calls, f.want)
		}
	})
	return f
}

func admissionAssistantHost(cwd string) *model.WorkerAssistantHost {
	reason, providerModel := "not_found", "gpt-5"
	return &model.WorkerAssistantHost{
		ProtocolVersion: 1,
		ObservedAt:      time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC),
		DefaultCwd:      cwd,
		DefaultProvider: model.AgentCopilot,
		Providers: []model.WorkerAssistantProvider{
			{Provider: model.AgentCodex, Available: true, Args: []string{}},
			{Provider: model.AgentClaude, Available: false, Reason: &reason, Args: []string{}},
			{Provider: model.AgentCopilot, Available: true, Model: &providerModel, Args: []string{"--effort", "high"}},
		},
	}
}

func (f *admissionServiceFixture) take(call string) {
	f.t.Helper()
	index := len(f.calls)
	f.calls = append(f.calls, call)
	if index >= len(f.want) || f.want[index] != call {
		f.t.Errorf("unexpected report call %s at %d; expected %v", call, index, f.want)
	}
}
func (f *admissionServiceFixture) checkContext(ctx context.Context) {
	f.t.Helper()
	if ctx != f.ctx {
		f.t.Error("report replaced its context")
	}
}
func (f *admissionServiceFixture) operationError(call string) error {
	if f.failAt == call {
		return f.failure
	}
	return nil
}
func (f *admissionServiceFixture) stopAt(call string, failure error) {
	f.failAt, f.failure = call, failure
	for index, expected := range f.want {
		if expected == call {
			f.want = append([]string{}, f.want[:index+1]...)
			if index >= 2 {
				f.want = append(f.want, "completion")
			}
			return
		}
	}
	f.t.Fatalf("unknown report stage %s", call)
}
func (f *admissionServiceFixture) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	f.t.Error("admission report unexpectedly read a separate snapshot")
	return errors.New("unexpected snapshot")
}
func (f *admissionServiceFixture) WriteWorker(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
	f.take("write")
	f.checkContext(ctx)
	f.callbackError = operation(f)
	f.take("completion")
	if f.completionError != nil {
		return f.completion, f.completionError
	}
	return f.completion, f.callbackError
}
func (f *admissionServiceFixture) WorkerDAO() store.WorkerWriteDAO {
	f.take("dao")
	return f
}
func (f *admissionServiceFixture) AdmitWorker(ctx context.Context, user, worker string, window time.Duration) (store.WorkerAdmission, error) {
	f.take("admission")
	f.checkContext(ctx)
	if user != f.principal.UserID || worker != f.worker || window != workercore.ActiveWindow {
		f.t.Errorf("Store admission arguments = %s/%s %v", user, worker, window)
	}
	if f.entered != nil {
		close(f.entered)
		select {
		case <-ctx.Done():
			return store.WorkerAdmission{}, ctx.Err()
		case <-f.release:
			return store.WorkerAdmission{}, errors.New("admission released during cleanup")
		}
	}
	return f.admission, f.operationError("admission")
}
func (f *admissionServiceFixture) ObservedAt(ctx context.Context) (time.Time, error) {
	f.take("clock")
	f.checkContext(ctx)
	return f.observed, f.operationError("clock")
}
func (f *admissionServiceFixture) ReportTaskSnapshots(ctx context.Context, user string, input model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	f.take("sources")
	f.checkContext(ctx)
	if user != f.principal.UserID || !reflect.DeepEqual(input, *f.normalized.TaskInventory) {
		f.t.Errorf("task sources arguments = %s %+v", user, input)
	}
	return f.sources, f.operationError("sources")
}
func (f *admissionServiceFixture) UpsertWorker(ctx context.Context, input model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	f.take("upsert")
	f.checkContext(ctx)
	if !reflect.DeepEqual(input, f.proposed) {
		f.t.Errorf("proposed snapshot = %+v, want %+v", input, f.proposed)
	}
	return f.stored, f.operationError("upsert")
}
func (f *admissionServiceFixture) WorkerConfiguration(ctx context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
	f.take("configuration")
	f.checkContext(ctx)
	if user != f.principal.UserID || worker != f.worker {
		f.t.Errorf("configuration read arguments = %s/%s", user, worker)
	}
	return f.configuration, f.operationError("configuration")
}
func (f *admissionServiceFixture) ConfigurationProjectAccess(context.Context, string, string) error {
	f.t.Error("service called the Core configuration dependency")
	return errors.New("unexpected project access")
}
func (f *admissionServiceFixture) SetWorkerConfiguration(context.Context, string, string, int64, model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
	f.t.Error("service called the Core configuration dependency")
	return model.WorkerDesiredConfiguration{}, errors.New("unexpected configuration write")
}
func (f *admissionServiceFixture) SetWorkerConfigurationObservation(context.Context, string, string, int64, model.WorkerConfigurationObservation) error {
	f.t.Error("service called the Core configuration dependency")
	return errors.New("unexpected observation write")
}

func admissionCompatibilityConfiguration() model.WorkerConfiguration {
	return model.WorkerConfiguration{
		MaxConcurrent: 3, PollIntervalMs: 60000, RecoveryLimit: 0,
		Native:   model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}},
		Projects: []model.WorkerProjectConfiguration{},
	}
}

func admissionCompatibilityBootstrap() *model.WorkerConfigurationExchange {
	value := admissionCompatibilityConfiguration()
	return &model.WorkerConfigurationExchange{Bootstrap: &value}
}

func admissionCompatibilityObservation() *model.WorkerConfigurationExchange {
	return &model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{
		BaseRevision: "0", DesiredRevision: "2", Items: []model.WorkerConfigurationItem{},
	}}
}

func admissionCompatibilityReceipt() *model.WorkerConfigurationReceipt {
	return &model.WorkerConfigurationReceipt{
		Desired: &model.WorkerDesiredConfiguration{
			Revision: "1", UpdatedAt: time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC), Value: admissionCompatibilityConfiguration(),
		},
		ObservationRevision: "0", ObservationAccepted: false,
	}
}

func TestWorkerAdmissionConfigurationCompatibility(t *testing.T) {
	for _, name := range []string{"bootstrap", "exchange refusal", "legacy"} {
		t.Run(name, func(t *testing.T) {
			f := newAdmissionServiceFixture(t)
			f.input.TaskInventory, f.normalized.TaskInventory = nil, nil
			f.items = nil
			f.proposed.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
			f.stored.TaskSnapshot = model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
			f.input.Telemetry.AssistantHost = admissionAssistantHost("/input-assistant-host")
			f.normalized.Telemetry.AssistantHost = admissionAssistantHost("/normalized-assistant-host")
			f.proposed.Telemetry.AssistantHost = admissionAssistantHost("/snapshot-assistant-host")
			f.stored.Telemetry.AssistantHost = admissionAssistantHost("/stored-assistant-host")
			f.input.Configuration = admissionCompatibilityBootstrap()
			f.normalized.Configuration = admissionCompatibilityBootstrap()
			f.parsed = admissionCompatibilityBootstrap()
			f.receipt = admissionCompatibilityReceipt()
			f.want = []string{"validate", "parse", "write", "dao", "admission", "admit", "snapshot", "upsert", "exchange", "clock", "completion"}
			var cause error
			var refusal *model.Fault
			if name == "exchange refusal" {
				f.input.Telemetry.AssistantHost = admissionAssistantHost("/rejected-assistant-host")
				f.input.Configuration = admissionCompatibilityObservation()
				f.normalized.Configuration = admissionCompatibilityObservation()
				f.parsed = admissionCompatibilityObservation()
				f.receipt = nil
				cause = errors.New("supplied configuration refusal")
				refusal = &model.Fault{Code: "invalid_input", Message: "Supplied configuration refusal", Cause: cause}
				f.stopAt("exchange", refusal)
				f.completion = store.Completion{Outcome: store.TransactionNotCommitted}
			} else if name == "legacy" {
				f.input.Configuration, f.normalized.Configuration, f.parsed, f.receipt = nil, nil, nil, nil
				f.input.Telemetry.AssistantHost, f.normalized.Telemetry.AssistantHost = nil, nil
				f.proposed.Telemetry.AssistantHost, f.stored.Telemetry.AssistantHost = nil, nil
				f.want = []string{"validate", "write", "dao", "admission", "admit", "snapshot", "upsert", "clock", "completion"}
			}
			got, err := f.service.Report(f.ctx, f.principal, strings.ToUpper(f.worker), f.input)
			if refusal != nil {
				if !errors.Is(f.callbackError, refusal) || !errors.Is(f.callbackError, cause) || !errors.Is(err, refusal) || !errors.Is(err, cause) || !reflect.DeepEqual(got, WorkerReportResult{}) {
					t.Fatalf("configuration refusal callback=%v result=%+v err=%v", f.callbackError, got, err)
				}
				requireFault(t, f.callbackError, "invalid_input")
				requireFault(t, err, "invalid_input")
				return
			}
			want := WorkerReportResult{LastReportedAt: f.stored.LastReportedAt, ObservedAt: f.observed}
			if name == "bootstrap" {
				want.Configuration = admissionCompatibilityReceipt()
			}
			if err != nil || f.callbackError != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("configuration report=%+v want=%+v callback=%v err=%v", got, want, f.callbackError, err)
			}
		})
	}
}

func TestWorkerAdmissionPropagatesFactsAndSuppliedResults(t *testing.T) {
	f := newAdmissionServiceFixture(t)
	got, err := f.service.Report(f.ctx, f.principal, strings.ToUpper(f.worker), f.input)
	want := WorkerReportResult{Configuration: f.receipt, LastReportedAt: f.stored.LastReportedAt, ObservedAt: f.observed}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("report = %+v %v, want %+v", got, err, want)
	}
}

func TestWorkerAdmissionStopsAtControlledFailures(t *testing.T) {
	for _, stage := range []string{"validate", "parse", "admission", "admit", "sources", "match", "upsert", "exchange", "configuration", "clock"} {
		t.Run(stage, func(t *testing.T) {
			f := newAdmissionServiceFixture(t)
			cause := errors.New("supplied operation failure")
			var failure error = cause
			code := ""
			switch stage {
			case "validate", "parse":
				code = "invalid_input"
			case "admit":
				code = "active_worker_limit_exceeded"
			case "exchange":
				code = "not_found"
			}
			if code != "" {
				failure = &model.Fault{Code: code, Message: "Supplied refusal", Cause: cause}
			}
			f.stopAt(stage, failure)
			f.completion = store.Completion{Outcome: store.TransactionNotCommitted}
			got, err := f.service.Report(f.ctx, f.principal, f.worker, f.input)
			if !errors.Is(err, failure) || !errors.Is(err, cause) || !reflect.DeepEqual(got, WorkerReportResult{}) {
				t.Fatalf("report = %+v %v; lost failure or returned a result", got, err)
			}
			if code != "" {
				requireFault(t, err, code)
			}
		})
	}
}

func TestWorkerAdmissionCompletionIsIndependentOfCallback(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		t.Run(string(outcome), func(t *testing.T) {
			f := newAdmissionServiceFixture(t)
			f.completion = store.Completion{Outcome: outcome}
			got, err := f.service.Report(f.ctx, f.principal, f.worker, f.input)
			if f.callbackError != nil || err == nil || !strings.Contains(err.Error(), "transaction did not confirm commit") || !reflect.DeepEqual(got, WorkerReportResult{}) {
				t.Fatalf("completion=%s callback=%v result=%+v err=%v", outcome, f.callbackError, got, err)
			}
		})
	}
	for _, refuse := range []bool{false, true} {
		t.Run(map[bool]string{false: "committed cleanup failure", true: "refusal and cleanup failure"}[refuse], func(t *testing.T) {
			f := newAdmissionServiceFixture(t)
			cleanup := errors.New("transaction cleanup")
			var callback error
			if refuse {
				callback = &model.Fault{Code: "active_worker_limit_exceeded", Message: "Supplied admission refusal"}
				f.stopAt("admit", callback)
				f.completion = store.Completion{Outcome: store.TransactionNotCommitted}
			}
			transaction := &store.TransactionError{Phase: "cleanup", Cause: errors.Join(callback, cleanup), Outcome: f.completion.Outcome, CleanupFailed: true}
			f.completionError = transaction
			got, err := f.service.Report(f.ctx, f.principal, f.worker, f.input)
			if !errors.Is(err, cleanup) || !errors.Is(err, transaction) || (refuse && !errors.Is(f.callbackError, callback)) || !reflect.DeepEqual(got, WorkerReportResult{}) {
				t.Fatalf("callback=%v result=%+v err=%v", f.callbackError, got, err)
			}
			if refuse {
				var fault *model.Fault
				if !errors.Is(err, callback) || !errors.As(err, &fault) || fault.Code != "active_worker_limit_exceeded" || fault.Message == "" {
					t.Fatalf("completion lost its supplied refusal: %v", err)
				}
			}
		})
	}
}

func TestWorkerAdmissionCancellationStopsAfterEnteredOperation(t *testing.T) {
	f := newAdmissionServiceFixture(t)
	ctx, cancel := context.WithCancel(f.ctx)
	f.ctx = ctx
	f.stopAt("admission", context.Canceled)
	f.entered, f.release = make(chan struct{}), make(chan struct{})
	f.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	type answer struct {
		result WorkerReportResult
		err    error
	}
	out, exited := make(chan answer, 1), make(chan struct{})
	t.Cleanup(func() {
		cancel()
		close(f.release)
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
			t.Error("canceled report did not exit")
		}
	})
	go func() {
		defer close(exited)
		result, err := f.service.Report(ctx, f.principal, f.worker, f.input)
		out <- answer{result, err}
	}()
	select {
	case <-f.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("report did not enter admission")
	}
	cancel()
	select {
	case got := <-out:
		if !errors.Is(got.err, context.Canceled) || !reflect.DeepEqual(got.result, WorkerReportResult{}) {
			t.Fatalf("cancellation result = %+v %v", got.result, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("report did not propagate cancellation")
	}
}

func TestWorkerAdmissionConstructorsBindProductionOperations(t *testing.T) {
	for _, workers := range []*Workers{NewWorkers(nil), NewWorkersWithPrompts(nil, nil)} {
		for _, pair := range []struct{ actual, expected any }{
			{workers.report.validate, workercore.ValidateReport},
			{workers.report.parseConfiguration, workercore.ParseWorkerConfigurationExchange},
			{workers.report.admit, workercore.AdmitActiveWorker},
			{workers.report.matchTasks, workercore.MatchTaskSnapshots},
			{workers.report.snapshot, workercore.SnapshotForReport},
			{workers.report.exchangeConfiguration, workercore.ExchangeConfiguration},
		} {
			if reflect.ValueOf(pair.actual).Pointer() != reflect.ValueOf(pair.expected).Pointer() {
				t.Error("constructor changed its Core operation binding")
			}
		}
	}
}
