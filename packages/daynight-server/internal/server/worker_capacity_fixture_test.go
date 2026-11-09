package server

import (
	"context"
	"encoding/json"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

var capacityObservedAt = time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)

type capacityCallPlan struct {
	t    *testing.T
	want []string
	used int
}

func (p *capacityCallPlan) call(name string) {
	p.t.Helper()
	if p.used == len(p.want) || p.want[p.used] != name {
		p.t.Errorf("unexpected worker call %q at %d; expected %v", name, p.used, p.want)
		panic("unexpected worker DAO call")
	}
	p.used++
}

func (p *capacityCallPlan) check() {
	p.t.Helper()
	if p.used != len(p.want) {
		p.t.Fatalf("worker calls: executed %d of %v", p.used, p.want)
	}
}

type capacityWorkerDAO struct {
	plan             *capacityCallPlan
	sources          func(string, model.WorkerTaskInventory) ([]store.WorkerTaskSource, error)
	upsert           func(model.WorkerSnapshot) (model.WorkerSnapshot, error)
	configuration    func(string, string) (model.WorkerConfigurationResource, error)
	projectAccess    func(string, string) error
	setConfiguration func(string, string, int64, model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error)
	setObservation   func(string, string, int64, model.WorkerConfigurationObservation) error
}

func (d *capacityWorkerDAO) ReportTaskSnapshots(_ context.Context, user string, value model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	d.plan.call("sources")
	return d.sources(user, value)
}
func (d *capacityWorkerDAO) UpsertWorker(_ context.Context, value model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	d.plan.call("upsert")
	return d.upsert(value)
}
func (d *capacityWorkerDAO) WorkerConfiguration(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
	d.plan.call("configuration")
	return d.configuration(user, worker)
}
func (d *capacityWorkerDAO) ConfigurationProjectAccess(_ context.Context, user, project string) error {
	d.plan.call("project_access")
	return d.projectAccess(user, project)
}
func (d *capacityWorkerDAO) SetWorkerConfiguration(_ context.Context, user, worker string, revision int64, value model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
	d.plan.call("set_configuration")
	return d.setConfiguration(user, worker, revision, value)
}
func (d *capacityWorkerDAO) SetWorkerConfigurationObservation(_ context.Context, user, worker string, revision int64, value model.WorkerConfigurationObservation) error {
	d.plan.call("set_observation")
	return d.setObservation(user, worker, revision, value)
}

type capacityWorkerScope struct {
	dao          *capacityWorkerDAO
	user, worker string
}

func (s *capacityWorkerScope) WorkerDAO() store.WorkerWriteDAO { s.dao.plan.call("dao"); return s.dao }
func (s *capacityWorkerScope) AdmitWorker(_ context.Context, user, worker string, window time.Duration) (store.WorkerAdmission, error) {
	s.dao.plan.call("admit")
	if user != s.user || worker != s.worker || window != workercore.ActiveWindow {
		s.dao.plan.t.Fatalf("worker admission: %q %q %s", user, worker, window)
	}
	return store.WorkerAdmission{ObservedAt: capacityObservedAt}, nil
}
func (s *capacityWorkerScope) ObservedAt(context.Context) (time.Time, error) {
	s.dao.plan.call("observed")
	return capacityObservedAt, nil
}

type capacityWorkerReader struct {
	store.WorkerReader
	plan          *capacityCallPlan
	worker        func(string, string, time.Time) (model.WorkerSnapshot, error)
	configuration func(string, string) (model.WorkerConfigurationResource, error)
	summaries     func(string, time.Time, store.Page, func(store.WorkerSummary) (bool, error)) error
}

func (r *capacityWorkerReader) Worker(_ context.Context, user, worker string, observed time.Time) (model.WorkerSnapshot, error) {
	r.plan.call("worker")
	return r.worker(user, worker, observed)
}
func (r *capacityWorkerReader) WorkerConfiguration(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
	r.plan.call("configuration")
	return r.configuration(user, worker)
}
func (r *capacityWorkerReader) WorkerSummaries(_ context.Context, user string, observed time.Time, page store.Page, accept func(store.WorkerSummary) (bool, error)) error {
	r.plan.call("summaries")
	return r.summaries(user, observed, page, accept)
}

type capacitySnapshot struct {
	store.SnapshotScope
	reader *capacityWorkerReader
}

func (s capacitySnapshot) WorkerDAO() store.WorkerReader { s.reader.plan.call("dao"); return s.reader }
func (s capacitySnapshot) ObservedAt(context.Context) (time.Time, error) {
	s.reader.plan.call("observed")
	return capacityObservedAt, nil
}

type capacityHTTPFixture struct {
	t       *testing.T
	tx      *httpTestStore
	handler *resourceTestHandler
	worker  string
}

func newCapacityHTTPFixture(t *testing.T, worker string, output io.Writer) *capacityHTTPFixture {
	t.Helper()
	tx := newHTTPTestStore(t)
	return &capacityHTTPFixture{t: t, tx: tx, handler: resourceTestServer(t, tx, attachmentTestFiles(t), output), worker: worker}
}

func (f *capacityHTTPFixture) write(calls []string, outcome store.TransactionOutcome, configure func(*capacityWorkerDAO)) *capacityCallPlan {
	f.t.Helper()
	p := &capacityCallPlan{t: f.t, want: append([]string{"write"}, calls...)}
	d := &capacityWorkerDAO{plan: p}
	configure(d)
	f.tx.WriteWorkerCall = func(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
		p.call("write")
		err := operation(&capacityWorkerScope{dao: d, user: f.handler.principal.UserID, worker: f.worker})
		if outcome == store.TransactionCommitted && err != nil {
			f.t.Fatalf("expected successful worker callback: %v", err)
		}
		if outcome == store.TransactionNotCommitted && err == nil {
			f.t.Fatal("expected refused worker callback")
		}
		return store.Completion{Outcome: outcome}, err
	}
	return p
}

func capacityDecode[T any](t *testing.T, value any) T {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var got T
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func capacityExpectedSnapshot(t *testing.T, user, worker string, body map[string]any) model.WorkerSnapshot {
	t.Helper()
	telemetry := capacityDecode[model.WorkerTelemetry](t, body)
	observation := model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	if body["taskInventory"] != nil {
		inventory := capacityDecode[model.WorkerTaskInventory](t, body["taskInventory"])
		observation = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &capacityObservedAt, InventoryObservedAt: &inventory.ObservedAt, Items: []model.WorkerObservedTask{}}
	}
	return model.WorkerSnapshot{UserID: user, WorkerID: worker, CreatedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Telemetry: telemetry, TaskSnapshot: observation}
}

func (f *capacityHTTPFixture) reportDAO(d *capacityWorkerDAO, body map[string]any, stored model.WorkerSnapshot) {
	f.t.Helper()
	want := capacityExpectedSnapshot(f.t, f.handler.principal.UserID, f.worker, body)
	d.sources = func(user string, inventory model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
		if user != f.handler.principal.UserID || !reflect.DeepEqual(inventory, capacityDecode[model.WorkerTaskInventory](f.t, body["taskInventory"])) {
			f.t.Fatal("worker inventory arguments differ")
		}
		return []store.WorkerTaskSource{}, nil
	}
	d.upsert = func(actual model.WorkerSnapshot) (model.WorkerSnapshot, error) {
		if !reflect.DeepEqual(actual, want) {
			f.t.Fatalf("worker upsert differs:\nactual %+v\nwant %+v", actual, want)
		}
		return capacityDecode[model.WorkerSnapshot](f.t, stored), nil
	}
}

func (f *capacityHTTPFixture) report(body map[string]any, stored model.WorkerSnapshot) *capacityCallPlan {
	calls := []string{"dao", "admit"}
	if body["taskInventory"] != nil {
		calls = append(calls, "sources")
	}
	calls = append(calls, "upsert", "observed")
	return f.write(calls, store.TransactionCommitted, func(d *capacityWorkerDAO) { f.reportDAO(d, body, stored) })
}

func (f *capacityHTTPFixture) read(calls []string, configure func(*capacityWorkerReader)) *capacityCallPlan {
	p := &capacityCallPlan{t: f.t, want: append([]string{"read"}, calls...)}
	r := &capacityWorkerReader{plan: p}
	configure(r)
	f.tx.ReadSnapshotCall = func(ctx context.Context, operation func(store.SnapshotScope) error) error {
		p.call("read")
		return operation(capacitySnapshot{reader: r})
	}
	return p
}

func (f *capacityHTTPFixture) readWorker(value model.WorkerSnapshot) *capacityCallPlan {
	return f.read([]string{"observed", "dao", "worker"}, func(r *capacityWorkerReader) {
		r.worker = func(user, worker string, observed time.Time) (model.WorkerSnapshot, error) {
			if user != f.handler.principal.UserID || worker != f.worker || observed != capacityObservedAt {
				f.t.Fatal("worker detail arguments differ")
			}
			return capacityDecode[model.WorkerSnapshot](f.t, value), nil
		}
	})
}

func (f *capacityHTTPFixture) readConfiguration(value model.WorkerConfigurationResource) *capacityCallPlan {
	return f.read([]string{"dao", "configuration"}, func(r *capacityWorkerReader) {
		r.configuration = func(user, worker string) (model.WorkerConfigurationResource, error) {
			f.workerAddress(user, worker)
			return capacityDecode[model.WorkerConfigurationResource](f.t, value), nil
		}
	})
}

func (f *capacityHTTPFixture) workerAddress(user, worker string) {
	f.t.Helper()
	if user != f.handler.principal.UserID || worker != f.worker {
		f.t.Fatalf("worker address: %q %q", user, worker)
	}
}

func (f *capacityHTTPFixture) rejectBeforeWrite() {
	f.tx.WriteWorkerCall = nil
	f.tx.ReadSnapshotCall = nil
}
