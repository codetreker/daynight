package worker

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

type configurationCalls struct {
	t          *testing.T
	ctx        context.Context
	want, seen []string
}

func (c *configurationCalls) take(name string, ctx context.Context) {
	c.t.Helper()
	index := len(c.seen)
	c.seen = append(c.seen, name)
	if index >= len(c.want) || c.want[index] != name {
		c.t.Fatalf("unexpected configuration call %s at %d, want %v", name, index, c.want)
	}
	if ctx != nil && ctx != c.ctx {
		c.t.Fatal("configuration operation replaced the context")
	}
}
func configurationUnexpected(t *testing.T, name string) {
	t.Helper()
	t.Fatalf("unexpected configuration dependency: %s", name)
}

type configurationStore struct {
	calls *configurationCalls
	read  func(context.Context, func(store.SnapshotScope) error) error
	write func(context.Context, func(store.WorkerScope) error) (store.Completion, error)
}

func (s *configurationStore) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.calls.take("snapshot", ctx)
	if s.read == nil {
		configurationUnexpected(s.calls.t, "ReadSnapshot")
	}
	return s.read(ctx, operation)
}
func (s *configurationStore) WriteWorker(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
	s.calls.take("write", ctx)
	if s.write == nil {
		configurationUnexpected(s.calls.t, "WriteWorker")
	}
	return s.write(ctx, operation)
}

type configurationReadScope struct {
	calls *configurationCalls
	dao   store.WorkerReader
}

func (s configurationReadScope) WorkerDAO() store.WorkerReader {
	s.calls.take("read dao", nil)
	return s.dao
}
func (s configurationReadScope) CredentialDAO() store.CredentialReader {
	configurationUnexpected(s.calls.t, "CredentialDAO")
	return nil
}
func (s configurationReadScope) TeamDAO() store.TeamReader {
	configurationUnexpected(s.calls.t, "TeamDAO")
	return nil
}
func (s configurationReadScope) ProjectDAO() store.ProjectReader {
	configurationUnexpected(s.calls.t, "ProjectDAO")
	return nil
}
func (s configurationReadScope) TaskDAO() store.TaskReader {
	configurationUnexpected(s.calls.t, "TaskDAO")
	return nil
}
func (s configurationReadScope) SessionDAO() store.SessionReader {
	configurationUnexpected(s.calls.t, "SessionDAO")
	return nil
}
func (s configurationReadScope) BotDAO() store.BotReader {
	configurationUnexpected(s.calls.t, "BotDAO")
	return nil
}
func (s configurationReadScope) AttachmentDAO() store.AttachmentReader {
	configurationUnexpected(s.calls.t, "AttachmentDAO")
	return nil
}
func (s configurationReadScope) ObservedAt(context.Context) (time.Time, error) {
	configurationUnexpected(s.calls.t, "read ObservedAt")
	return time.Time{}, nil
}

type configurationWriteScope struct {
	calls *configurationCalls
	dao   store.WorkerWriteDAO
}

func (s configurationWriteScope) WorkerDAO() store.WorkerWriteDAO {
	s.calls.take("write dao", nil)
	return s.dao
}
func (s configurationWriteScope) AdmitWorker(context.Context, string, string, time.Duration) (store.WorkerAdmission, error) {
	configurationUnexpected(s.calls.t, "AdmitWorker")
	return store.WorkerAdmission{}, nil
}
func (s configurationWriteScope) ObservedAt(context.Context) (time.Time, error) {
	configurationUnexpected(s.calls.t, "write ObservedAt")
	return time.Time{}, nil
}

type configurationDAO struct {
	calls *configurationCalls
	read  func(context.Context, string, string) (model.WorkerConfigurationResource, error)
}

func (d *configurationDAO) WorkerConfiguration(ctx context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
	d.calls.take("read configuration", ctx)
	if d.read == nil {
		configurationUnexpected(d.calls.t, "WorkerConfiguration")
	}
	return d.read(ctx, user, worker)
}
func (d *configurationDAO) Workers(context.Context, string, time.Time, store.Page) (store.WorkerPage, error) {
	configurationUnexpected(d.calls.t, "Workers")
	return store.WorkerPage{}, nil
}
func (d *configurationDAO) WorkerSummaries(context.Context, string, time.Time, store.Page) (store.WorkerSummaryPage, error) {
	configurationUnexpected(d.calls.t, "WorkerSummaries")
	return store.WorkerSummaryPage{}, nil
}
func (d *configurationDAO) Worker(context.Context, string, string, time.Time) (model.WorkerSnapshot, error) {
	configurationUnexpected(d.calls.t, "Worker")
	return model.WorkerSnapshot{}, nil
}
func (d *configurationDAO) ReportTaskSnapshots(context.Context, string, model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	configurationUnexpected(d.calls.t, "ReportTaskSnapshots")
	return nil, nil
}
func (d *configurationDAO) UpsertWorker(context.Context, model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	configurationUnexpected(d.calls.t, "UpsertWorker")
	return model.WorkerSnapshot{}, nil
}
func (d *configurationDAO) ConfigurationProjectAccess(context.Context, string, string) error {
	configurationUnexpected(d.calls.t, "ConfigurationProjectAccess")
	return nil
}
func (d *configurationDAO) SetWorkerConfiguration(context.Context, string, string, int64, model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
	configurationUnexpected(d.calls.t, "SetWorkerConfiguration")
	return model.WorkerDesiredConfiguration{}, nil
}
func (d *configurationDAO) SetWorkerConfigurationObservation(context.Context, string, string, int64, model.WorkerConfigurationObservation) error {
	configurationUnexpected(d.calls.t, "SetWorkerConfigurationObservation")
	return nil
}

type configurationFixture struct {
	t          *testing.T
	calls      *configurationCalls
	storage    *configurationStore
	readScope  configurationReadScope
	writeScope configurationWriteScope
	principal  model.Principal
	worker     string
	value      model.WorkerConfiguration
	provided   model.WorkerConfigurationResource
	workers    *Workers
	putError   error
}

func newConfigurationFixture(t *testing.T) *configurationFixture {
	t.Helper()
	f := &configurationFixture{t: t, principal: model.Principal{Kind: model.PATCredential, UserID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CredentialID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}, worker: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", value: cloudWorkerConfiguration("")}
	f.calls = &configurationCalls{t: t, ctx: t.Context()}
	f.storage = &configurationStore{calls: f.calls}
	f.readScope = configurationReadScope{calls: f.calls, dao: &configurationDAO{calls: f.calls}}
	f.writeScope = configurationWriteScope{calls: f.calls, dao: &configurationDAO{calls: f.calls}}
	returned := cloudWorkerConfiguration("")
	returned.MaxConcurrent = 7
	f.provided = model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC), Value: returned}, ObservationRevision: "0"}
	f.workers = NewWorkers(f.storage)
	f.workers.putConfiguration = func(ctx context.Context, dao store.WorkerWriteDAO, principal model.Principal, worker string, revision int64, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		f.calls.take("put", ctx)
		if dao != f.writeScope.dao || principal != f.principal || worker != f.worker || revision != 1 || !reflect.DeepEqual(value, f.value) {
			t.Fatalf("configuration operation arguments = %p %+v %s %d %+v", dao, principal, worker, revision, value)
		}
		return f.provided, f.putError
	}
	t.Cleanup(func() {
		if !reflect.DeepEqual(f.calls.seen, f.calls.want) {
			t.Errorf("configuration calls = %v, want %v", f.calls.seen, f.calls.want)
		}
	})
	return f
}
func (f *configurationFixture) write(completion store.Completion, completionError, errorFromCallback error) {
	f.calls.want = []string{"write", "write dao", "put", "write complete"}
	f.storage.write = func(_ context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
		if err := operation(f.writeScope); !errors.Is(err, errorFromCallback) {
			f.t.Fatalf("callback error=%v, want %v", err, errorFromCallback)
		}
		f.calls.take("write complete", nil)
		return completion, completionError
	}
}

func TestWorkerConfigurationValidationAndTransactionFailures(t *testing.T) {
	for _, operation := range []string{"read", "write"} {
		t.Run(operation, func(t *testing.T) {
			for _, input := range []struct {
				name      string
				principal model.Principal
				id        string
				code      string
			}{
				{"principal", model.Principal{}, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "unauthenticated"},
				{"worker", model.Principal{Kind: model.PATCredential, UserID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CredentialID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}, "invalid", "invalid_input"},
			} {
				t.Run(input.name, func(t *testing.T) {
					f := newConfigurationFixture(t)
					var result model.WorkerConfigurationResource
					var err error
					if operation == "read" {
						result, err = f.workers.Configuration(f.calls.ctx, input.principal, input.id)
					} else {
						result, err = f.workers.PutConfiguration(f.calls.ctx, input.principal, input.id, "1", f.value)
					}
					requireFault(t, err, input.code)
					if !reflect.DeepEqual(result, model.WorkerConfigurationResource{}) {
						t.Fatalf("refusal returned configuration: %+v", result)
					}
				})
			}
		})
	}
	t.Run("nil native arguments", func(t *testing.T) {
		f := newConfigurationFixture(t)
		f.value.Native.Args = nil
		result, err := f.workers.PutConfiguration(f.calls.ctx, f.principal, f.worker, "1", f.value)
		requireFault(t, err, "invalid_input")
		if !reflect.DeepEqual(result, model.WorkerConfigurationResource{}) {
			t.Fatalf("invalid input returned configuration: %+v", result)
		}
	})
	for _, operation := range []string{"read", "write"} {
		t.Run("canceled "+operation, func(t *testing.T) {
			f := newConfigurationFixture(t)
			ctx, cancel := context.WithCancel(f.calls.ctx)
			cancel()
			f.calls.ctx = ctx
			var result model.WorkerConfigurationResource
			var err error
			if operation == "read" {
				f.calls.want = []string{"snapshot"}
				f.storage.read = func(ctx context.Context, _ func(store.SnapshotScope) error) error {
					if ctx.Err() != context.Canceled {
						t.Fatal("snapshot did not receive canceled context")
					}
					return ctx.Err()
				}
				result, err = f.workers.Configuration(ctx, f.principal, f.worker)
			} else {
				f.calls.want = []string{"write"}
				f.storage.write = func(ctx context.Context, _ func(store.WorkerScope) error) (store.Completion, error) {
					if ctx.Err() != context.Canceled {
						t.Fatal("write did not receive canceled context")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
				}
				result, err = f.workers.PutConfiguration(ctx, f.principal, f.worker, "1", f.value)
			}
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(result, model.WorkerConfigurationResource{}) {
				t.Fatalf("cancellation result = %+v %v", result, err)
			}
		})
	}
}

func TestWorkerConfigurationUsesControlledOperationsAndResources(t *testing.T) {
	t.Run("write", func(t *testing.T) {
		f := newConfigurationFixture(t)
		f.write(store.Completion{Outcome: store.TransactionCommitted}, nil, nil)
		result, err := f.workers.PutConfiguration(f.calls.ctx, f.principal, strings.ToUpper(f.worker), "1", f.value)
		if err != nil || !reflect.DeepEqual(result, f.provided) {
			t.Fatalf("configuration result=%+v %v, want %+v", result, err, f.provided)
		}
	})
	t.Run("read", func(t *testing.T) {
		f := newConfigurationFixture(t)
		f.calls.want = []string{"snapshot", "read dao", "read configuration", "read complete"}
		f.readScope.dao.(*configurationDAO).read = func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
			if user != f.principal.UserID || worker != f.worker {
				t.Fatalf("configuration reader arguments = %s/%s", user, worker)
			}
			return f.provided, nil
		}
		f.storage.read = func(_ context.Context, operation func(store.SnapshotScope) error) error {
			err := operation(f.readScope)
			f.calls.take("read complete", nil)
			return err
		}
		result, err := f.workers.Configuration(f.calls.ctx, f.principal, strings.ToUpper(f.worker))
		if err != nil || !reflect.DeepEqual(result, f.provided) {
			t.Fatalf("configuration read=%+v %v, want %+v", result, err, f.provided)
		}
	})
}

func TestWorkerConfigurationRefusalDoesNotHideTransactionFailure(t *testing.T) {
	refusal := &model.Fault{Code: "version_conflict", Message: "Configuration changed."}
	cleanup := errors.New("rollback failed")
	for _, failure := range []*store.TransactionError{
		{Phase: "cleanup", Cause: errors.Join(refusal, cleanup), Outcome: store.TransactionUnknown, CleanupFailed: true},
		{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
		{Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown},
		{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted},
	} {
		t.Run(failure.Phase+"/"+string(failure.Outcome), func(t *testing.T) {
			f := newConfigurationFixture(t)
			f.putError = refusal
			f.write(store.Completion{Outcome: failure.Outcome}, failure, refusal)
			result, err := f.workers.PutConfiguration(f.calls.ctx, f.principal, f.worker, "1", f.value)
			if failure.Outcome == store.TransactionNotCommitted {
				if err != refusal {
					t.Fatalf("rolled back refusal not returned: %v", err)
				}
			} else if err == refusal || !errors.Is(err, failure) {
				t.Fatalf("operational failure replaced with refusal: %v", err)
			}
			if !errors.Is(err, refusal) || (failure.CleanupFailed && !errors.Is(err, cleanup)) || !reflect.DeepEqual(result, model.WorkerConfigurationResource{}) {
				t.Fatalf("configuration failure lost its chain or returned a result: %+v %v", result, err)
			}
		})
	}
}

func TestWorkerConfigurationCompletionDoesNotFollowCallbackSuccess(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		t.Run(string(outcome), func(t *testing.T) {
			f := newConfigurationFixture(t)
			f.write(store.Completion{Outcome: outcome}, nil, nil)
			result, err := f.workers.PutConfiguration(f.calls.ctx, f.principal, f.worker, "1", f.value)
			if err == nil || !strings.Contains(err.Error(), "transaction did not confirm commit") || !reflect.DeepEqual(result, model.WorkerConfigurationResource{}) {
				t.Fatalf("unconfirmed configuration returned success: %+v %v", result, err)
			}
		})
	}
}

func TestWorkerConfigurationConstructorsBindProductionOperation(t *testing.T) {
	for _, workers := range []*Workers{NewWorkers(nil), NewWorkersWithPrompts(nil, nil)} {
		if reflect.ValueOf(workers.putConfiguration).Pointer() != reflect.ValueOf(workercore.PutConfiguration).Pointer() {
			t.Error("constructor changed its Core configuration operation")
		}
	}
}

func TestHistoricalConfigurationCandidateAdmissionAndRead(t *testing.T) {
	t.Run("reject new over-limit candidate", func(t *testing.T) {
		f := newConfigurationFixture(t)
		value := cloudWorkerConfiguration("")
		value.MaxConcurrent = 65
		got, err := f.workers.PutConfiguration(f.calls.ctx, f.principal, f.worker, "2", value)
		requireFault(t, err, "invalid_input")
		if !reflect.DeepEqual(got, model.WorkerConfigurationResource{}) {
			t.Fatalf("invalid candidate returned a configuration: %+v", got)
		}
	})
	t.Run("read supplied repaired resource", func(t *testing.T) {
		f := newConfigurationFixture(t)
		at := time.Date(2026, 11, 9, 0, 0, 1, 0, time.UTC)
		provided := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: at, Value: cloudWorkerConfiguration("")}, ObservationRevision: "0"}
		expected := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: at, Value: cloudWorkerConfiguration("")}, ObservationRevision: "0"}
		f.calls.want = []string{"snapshot", "read dao", "read configuration", "read complete"}
		f.readScope.dao.(*configurationDAO).read = func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
			if user != f.principal.UserID || worker != f.worker {
				t.Fatal("repaired configuration read changed owner or worker")
			}
			return provided, nil
		}
		f.storage.read = func(_ context.Context, operation func(store.SnapshotScope) error) error {
			err := operation(f.readScope)
			f.calls.take("read complete", nil)
			return err
		}
		got, err := f.workers.Configuration(f.calls.ctx, f.principal, f.worker)
		if err != nil || !reflect.DeepEqual(got, expected) {
			t.Fatalf("repaired read: got=%+v want=%+v err=%v", got, expected, err)
		}
	})
}
