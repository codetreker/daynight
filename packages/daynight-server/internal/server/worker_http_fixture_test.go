package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func workerHTTPFail(t *testing.T, format string, args ...any) {
	t.Helper()
	t.Errorf(format, args...)
	panic("Worker HTTP expectation failed")
}

func workerHTTPValue[T any](t *testing.T, value any) T {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		workerHTTPFail(t, "encode independent Worker fixture: %v", err)
	}
	var result T
	if err := json.Unmarshal(encoded, &result); err != nil {
		workerHTTPFail(t, "decode independent Worker fixture: %v", err)
	}
	return result
}

func workerHTTPUnexpected(t *testing.T, method string) {
	t.Helper()
	t.Errorf("unexpected Worker DAO call: %s", method)
	panic("unexpected Worker DAO call: " + method)
}

type workerHTTPWriteDAO struct {
	t                                     *testing.T
	ReportTaskSnapshotsCall               func(context.Context, string, model.WorkerTaskInventory) ([]store.WorkerTaskSource, error)
	UpsertWorkerCall                      func(context.Context, model.WorkerSnapshot) (model.WorkerSnapshot, error)
	WorkerConfigurationCall               func(context.Context, string, string) (model.WorkerConfigurationResource, error)
	ConfigurationProjectAccessCall        func(context.Context, string, string) error
	SetWorkerConfigurationCall            func(context.Context, string, string, int64, model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error)
	SetWorkerConfigurationObservationCall func(context.Context, string, string, int64, model.WorkerConfigurationObservation) error
}

func (d *workerHTTPWriteDAO) ReportTaskSnapshots(ctx context.Context, id string, v model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	if d.ReportTaskSnapshotsCall == nil {
		workerHTTPUnexpected(d.t, "ReportTaskSnapshots")
	}
	return d.ReportTaskSnapshotsCall(ctx, id, v)
}
func (d *workerHTTPWriteDAO) UpsertWorker(ctx context.Context, v model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	if d.UpsertWorkerCall == nil {
		workerHTTPUnexpected(d.t, "UpsertWorker")
	}
	return d.UpsertWorkerCall(ctx, v)
}
func (d *workerHTTPWriteDAO) WorkerConfiguration(ctx context.Context, u, w string) (model.WorkerConfigurationResource, error) {
	if d.WorkerConfigurationCall == nil {
		workerHTTPUnexpected(d.t, "WorkerConfiguration")
	}
	return d.WorkerConfigurationCall(ctx, u, w)
}
func (d *workerHTTPWriteDAO) ConfigurationProjectAccess(ctx context.Context, u, p string) error {
	if d.ConfigurationProjectAccessCall == nil {
		workerHTTPUnexpected(d.t, "ConfigurationProjectAccess")
	}
	return d.ConfigurationProjectAccessCall(ctx, u, p)
}
func (d *workerHTTPWriteDAO) SetWorkerConfiguration(ctx context.Context, u, w string, r int64, v model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
	if d.SetWorkerConfigurationCall == nil {
		workerHTTPUnexpected(d.t, "SetWorkerConfiguration")
	}
	return d.SetWorkerConfigurationCall(ctx, u, w, r, v)
}
func (d *workerHTTPWriteDAO) SetWorkerConfigurationObservation(ctx context.Context, u, w string, r int64, v model.WorkerConfigurationObservation) error {
	if d.SetWorkerConfigurationObservationCall == nil {
		workerHTTPUnexpected(d.t, "SetWorkerConfigurationObservation")
	}
	return d.SetWorkerConfigurationObservationCall(ctx, u, w, r, v)
}

type workerHTTPWriteScope struct {
	t               *testing.T
	DAO             *workerHTTPWriteDAO
	ObservedAtCall  func(context.Context) (time.Time, error)
	AdmitWorkerCall func(context.Context, string, string, time.Duration) (store.WorkerAdmission, error)
}

func (s *workerHTTPWriteScope) WorkerDAO() store.WorkerWriteDAO { return s.DAO }
func (s *workerHTTPWriteScope) ObservedAt(ctx context.Context) (time.Time, error) {
	if s.ObservedAtCall == nil {
		workerHTTPUnexpected(s.t, "ObservedAt")
	}
	return s.ObservedAtCall(ctx)
}
func (s *workerHTTPWriteScope) AdmitWorker(ctx context.Context, u, w string, d time.Duration) (store.WorkerAdmission, error) {
	if s.AdmitWorkerCall == nil {
		workerHTTPUnexpected(s.t, "AdmitWorker")
	}
	return s.AdmitWorkerCall(ctx, u, w, d)
}

type workerHTTPReader struct {
	t                       *testing.T
	WorkersCall             func(context.Context, string, time.Time, store.Page) (store.WorkerPage, error)
	WorkerSummariesCall     func(context.Context, string, time.Time, store.Page, func(store.WorkerSummary) (bool, error)) error
	WorkerCall              func(context.Context, string, string, time.Time) (model.WorkerSnapshot, error)
	WorkerConfigurationCall func(context.Context, string, string) (model.WorkerConfigurationResource, error)
}

func (d *workerHTTPReader) Workers(ctx context.Context, u string, now time.Time, p store.Page) (store.WorkerPage, error) {
	if d.WorkersCall == nil {
		workerHTTPUnexpected(d.t, "Workers")
	}
	return d.WorkersCall(ctx, u, now, p)
}
func (d *workerHTTPReader) WorkerSummaries(ctx context.Context, u string, now time.Time, p store.Page, accept func(store.WorkerSummary) (bool, error)) error {
	if d.WorkerSummariesCall == nil {
		workerHTTPUnexpected(d.t, "WorkerSummaries")
	}
	return d.WorkerSummariesCall(ctx, u, now, p, accept)
}
func (d *workerHTTPReader) Worker(ctx context.Context, u, w string, now time.Time) (model.WorkerSnapshot, error) {
	if d.WorkerCall == nil {
		workerHTTPUnexpected(d.t, "Worker")
	}
	return d.WorkerCall(ctx, u, w, now)
}
func (d *workerHTTPReader) WorkerConfiguration(ctx context.Context, u, w string) (model.WorkerConfigurationResource, error) {
	if d.WorkerConfigurationCall == nil {
		workerHTTPUnexpected(d.t, "WorkerConfiguration read")
	}
	return d.WorkerConfigurationCall(ctx, u, w)
}

type workerHTTPReadScope struct {
	t              *testing.T
	DAO            *workerHTTPReader
	ObservedAtCall func(context.Context) (time.Time, error)
}

func (s *workerHTTPReadScope) CredentialDAO() store.CredentialReader {
	workerHTTPUnexpected(s.t, "CredentialDAO")
	return nil
}
func (s *workerHTTPReadScope) TeamDAO() store.TeamReader {
	workerHTTPUnexpected(s.t, "TeamDAO")
	return nil
}
func (s *workerHTTPReadScope) ProjectDAO() store.ProjectReader {
	workerHTTPUnexpected(s.t, "ProjectDAO")
	return nil
}
func (s *workerHTTPReadScope) TaskDAO() store.TaskReader {
	workerHTTPUnexpected(s.t, "TaskDAO")
	return nil
}
func (s *workerHTTPReadScope) SessionDAO() store.SessionReader {
	workerHTTPUnexpected(s.t, "SessionDAO")
	return nil
}
func (s *workerHTTPReadScope) BotDAO() store.BotReader {
	workerHTTPUnexpected(s.t, "BotDAO")
	return nil
}
func (s *workerHTTPReadScope) AttachmentDAO() store.AttachmentReader {
	workerHTTPUnexpected(s.t, "AttachmentDAO")
	return nil
}
func (s *workerHTTPReadScope) WorkerDAO() store.WorkerReader { return s.DAO }
func (s *workerHTTPReadScope) ObservedAt(ctx context.Context) (time.Time, error) {
	if s.ObservedAtCall == nil {
		workerHTTPUnexpected(s.t, "ObservedAt read")
	}
	return s.ObservedAtCall(ctx)
}

type workerHTTPFixture struct {
	tx      *httpTestStore
	handler *resourceTestHandler
	now     time.Time
	send    func(string, string, string) *httptest.ResponseRecorder
}

func newWorkerHTTPFixture(t *testing.T, output io.Writer) *workerHTTPFixture {
	t.Helper()
	tx := newHTTPTestStore(t)
	f := &workerHTTPFixture{tx: tx, handler: projectTestHandler(t, tx, output), now: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)}
	f.send = func(method, path, body string) *httptest.ResponseRecorder {
		return projectRequest(f.handler, method, path, body)
	}
	return f
}

func workerHTTPTelemetry(t *testing.T, body map[string]any) model.WorkerTelemetry {
	t.Helper()
	var telemetry model.WorkerTelemetry
	if err := json.Unmarshal([]byte(jsonBody(t, body)), &telemetry); err != nil {
		t.Fatal(err)
	}
	return telemetry
}

func (f *workerHTTPFixture) report(t *testing.T, id string, body map[string]any, sources []store.WorkerTaskSource, items []model.WorkerObservedTask, stored model.WorkerSnapshot) api.WorkerReportResponse {
	return f.reportAdmission(t, id, body, sources, items, stored, store.WorkerAdmission{ObservedAt: f.now})
}
func (f *workerHTTPFixture) reportAdmission(t *testing.T, id string, body map[string]any, sources []store.WorkerTaskSource, items []model.WorkerObservedTask, stored model.WorkerSnapshot, admission store.WorkerAdmission) api.WorkerReportResponse {
	t.Helper()
	target := id
	id = strings.ToLower(id)
	telemetry := workerHTTPTelemetry(t, body)
	var inventory *model.WorkerTaskInventory
	if err := json.Unmarshal([]byte(jsonBody(t, body["taskInventory"])), &inventory); err != nil {
		t.Fatal(err)
	}
	observation := model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	if inventory != nil {
		observation = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventory.ObservedAt, Items: items}
	}
	expected := model.WorkerSnapshot{UserID: f.handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: telemetry, TaskSnapshot: observation}
	var calls []string
	dao := &workerHTTPWriteDAO{t: t}
	if inventory != nil {
		dao.ReportTaskSnapshotsCall = func(_ context.Context, u string, v model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
			calls = append(calls, "tasks")
			if u != expected.UserID || !reflect.DeepEqual(v, *inventory) {
				workerHTTPFail(t, "inventory delegation: %s %+v", u, v)
			}
			return workerHTTPValue[[]store.WorkerTaskSource](t, sources), nil
		}
	}
	dao.UpsertWorkerCall = func(_ context.Context, v model.WorkerSnapshot) (model.WorkerSnapshot, error) {
		calls = append(calls, "upsert")
		if !reflect.DeepEqual(v, expected) {
			workerHTTPFail(t, "report write: got %+v want %+v", v, expected)
		}
		return workerHTTPValue[model.WorkerSnapshot](t, stored), nil
	}
	scope := &workerHTTPWriteScope{t: t, DAO: dao, AdmitWorkerCall: func(_ context.Context, u, w string, window time.Duration) (store.WorkerAdmission, error) {
		calls = append(calls, "admit")
		if u != expected.UserID || w != id || window != 120*time.Second {
			workerHTTPFail(t, "report admission: %s %s %s", u, w, window)
		}
		return admission, nil
	}, ObservedAtCall: func(context.Context) (time.Time, error) { calls = append(calls, "observed"); return f.now, nil }}
	count := 0
	f.tx.WriteWorkerCall = func(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
		count++
		err := operation(scope)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
	response := f.send(http.MethodPost, "/api/v1/me/workers/"+target+"/report", jsonBody(t, body))
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		t.Fatal("report lacks private response admission headers")
	}
	result := decodeResponse[api.WorkerReportResponse](t, response, http.StatusOK)
	wantCalls := []string{"admit", "upsert", "observed"}
	if inventory != nil {
		wantCalls = []string{"admit", "tasks", "upsert", "observed"}
	}
	if count != 1 || !reflect.DeepEqual(calls, wantCalls) {
		workerHTTPFail(t, "report calls: %d %v want %v", count, calls, wantCalls)
	}
	f.tx.WriteWorkerCall = nil
	return result
}
func (f *workerHTTPFixture) read(t *testing.T, reader *workerHTTPReader, request func()) {
	t.Helper()
	snapshots, observations := 0, 0
	scope := &workerHTTPReadScope{t: t, DAO: reader, ObservedAtCall: func(context.Context) (time.Time, error) { observations++; return f.now, nil }}
	f.tx.ReadSnapshotCall = func(_ context.Context, op func(store.SnapshotScope) error) error { snapshots++; return op(scope) }
	request()
	if snapshots != 1 || observations != 1 {
		workerHTTPFail(t, "Worker read calls: snapshot=%d observation=%d", snapshots, observations)
	}
	f.tx.ReadSnapshotCall = nil
}
func (f *workerHTTPFixture) detail(t *testing.T, id string, stored model.WorkerSnapshot) api.WorkerDetailResponse {
	t.Helper()
	calls := 0
	reader := &workerHTTPReader{t: t, WorkerCall: func(_ context.Context, u, w string, now time.Time) (model.WorkerSnapshot, error) {
		calls++
		if u != f.handler.principal.UserID || w != id || now != f.now {
			workerHTTPFail(t, "detail delegation: %s %s %s", u, w, now)
		}
		return workerHTTPValue[model.WorkerSnapshot](t, stored), nil
	}}
	var result api.WorkerDetailResponse
	f.read(t, reader, func() {
		result = decodeResponse[api.WorkerDetailResponse](t, f.send(http.MethodGet, "/api/v1/me/workers/"+id, ""), http.StatusOK)
	})
	if calls != 1 {
		workerHTTPFail(t, "Worker detail calls: %d", calls)
	}
	return result
}
func (f *workerHTTPFixture) list(t *testing.T, path string, page store.Page, summaries []store.WorkerSummary) api.WorkerPage {
	t.Helper()
	calls := 0
	reader := &workerHTTPReader{t: t, WorkerSummariesCall: func(_ context.Context, u string, now time.Time, actual store.Page, accept func(store.WorkerSummary) (bool, error)) error {
		calls++
		if u != f.handler.principal.UserID || now != f.now || !reflect.DeepEqual(actual, page) {
			workerHTTPFail(t, "list delegation: %s %s %+v want %+v", u, now, actual, page)
		}
		for _, item := range summaries {
			more, err := accept(workerHTTPValue[store.WorkerSummary](t, item))
			if err != nil {
				return err
			}
			if !more {
				break
			}
		}
		return nil
	}}
	var result api.WorkerPage
	f.read(t, reader, func() { result = decodeResponse[api.WorkerPage](t, f.send(http.MethodGet, path, ""), http.StatusOK) })
	if calls != 1 {
		workerHTTPFail(t, "Worker summary calls: %d", calls)
	}
	return result
}
