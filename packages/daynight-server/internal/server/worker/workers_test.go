package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

const workerTestOrigin = "https://daynight.example"

type resourceTestHandler struct {
	http.Handler
	token        string
	principal    model.Principal
	authenticate bool
}

type httpTestStore struct {
	t                      *testing.T
	ReadSnapshotCall       func(context.Context, func(store.SnapshotScope) error) error
	WriteWorkerCall        func(context.Context, func(store.WorkerScope) error) (store.Completion, error)
	ReadPromptSnapshotCall func(context.Context, func(store.PromptSnapshot) error) error
}

func (s *httpTestStore) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	if s.ReadSnapshotCall == nil {
		workerHTTPUnexpected(s.t, "ReadSnapshot")
	}
	return s.ReadSnapshotCall(ctx, fn)
}
func (s *httpTestStore) WriteWorker(ctx context.Context, fn func(store.WorkerScope) error) (store.Completion, error) {
	if s.WriteWorkerCall == nil {
		workerHTTPUnexpected(s.t, "WriteWorker")
	}
	return s.WriteWorkerCall(ctx, fn)
}
func (s *httpTestStore) ReadPromptSnapshot(ctx context.Context, fn func(store.PromptSnapshot) error) error {
	if s.ReadPromptSnapshotCall == nil {
		workerHTTPUnexpected(s.t, "ReadPromptSnapshot")
	}
	return s.ReadPromptSnapshotCall(ctx, fn)
}
func defaultHTTPPrincipal() model.Principal {
	return model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
}
func httpTestToken(kind model.CredentialKind) string {
	const value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	switch kind {
	case model.PATCredential:
		return "dnpat_" + value
	case model.SessionCredential:
		return "dnst_" + value
	case model.OAuthCredential:
		return model.OAuthAccessPrefix + value
	default:
		panic("unsupported HTTP fixture credential kind: " + string(kind))
	}
}
func defaultHTTPToken() string                     { return httpTestToken(model.PATCredential) }
func newHTTPTestStore(t *testing.T) *httpTestStore { return &httpTestStore{t: t} }
func projectTestHandler(t *testing.T, database *httpTestStore, output io.Writer) *resourceTestHandler {
	t.Helper()
	h := &resourceTestHandler{token: defaultHTTPToken(), principal: defaultHTTPPrincipal(), authenticate: true}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if !h.authenticate || kind != h.principal.Kind || token != httpTestToken(kind) {
			return model.Principal{}, authhttp.Failure()
		}
		return h.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: workerTestOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, workerservice.NewWorkersWithPrompts(database, database), &authhttp.Authentication{RequestAuthentication: auth}, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	return h
}
func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if resource, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+resource.token)
	}
}
func projectRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}

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
	WorkerSummariesCall     func(context.Context, string, time.Time, store.Page) (store.WorkerSummaryPage, error)
	WorkerCall              func(context.Context, string, string, time.Time) (model.WorkerSnapshot, error)
	WorkerConfigurationCall func(context.Context, string, string) (model.WorkerConfigurationResource, error)
}

func (d *workerHTTPReader) Workers(ctx context.Context, u string, now time.Time, p store.Page) (store.WorkerPage, error) {
	if d.WorkersCall == nil {
		workerHTTPUnexpected(d.t, "Workers")
	}
	return d.WorkersCall(ctx, u, now, p)
}
func (d *workerHTTPReader) WorkerSummaries(ctx context.Context, u string, now time.Time, p store.Page) (store.WorkerSummaryPage, error) {
	if d.WorkerSummariesCall == nil {
		workerHTTPUnexpected(d.t, "WorkerSummaries")
	}
	return d.WorkerSummariesCall(ctx, u, now, p)
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
	reader := &workerHTTPReader{t: t, WorkerSummariesCall: func(_ context.Context, u string, now time.Time, actual store.Page) (store.WorkerSummaryPage, error) {
		calls++
		if u != f.handler.principal.UserID || now != f.now || !reflect.DeepEqual(actual, page) {
			workerHTTPFail(t, "list delegation: %s %s %+v want %+v", u, now, actual, page)
		}
		hasMore := len(summaries) > page.Limit
		items := summaries
		if hasMore {
			items = items[:page.Limit]
		}
		return store.WorkerSummaryPage{Items: workerHTTPValue[[]store.WorkerSummary](t, items), HasMore: hasMore}, nil
	}}
	var result api.WorkerPage
	f.read(t, reader, func() { result = decodeResponse[api.WorkerPage](t, f.send(http.MethodGet, path, ""), http.StatusOK) })
	if calls != 1 {
		workerHTTPFail(t, "Worker summary calls: %d", calls)
	}
	return result
}

func TestWorkerReportHTTPActiveLimit(t *testing.T) {
	f := newWorkerHTTPFixture(t, io.Discard)
	id := uuid.NewString()
	body := workerSnapshotReportBody()
	snapshot := model.WorkerSnapshot{UserID: f.handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: workerInventoryTime(), Items: []model.WorkerObservedTask{}}}
	f.report(t, id, body, nil, []model.WorkerObservedTask{}, snapshot)
	rejectedID := uuid.NewString()
	scopes, admissions := 0, 0
	scope := &workerHTTPWriteScope{t: t, DAO: &workerHTTPWriteDAO{t: t}, AdmitWorkerCall: func(_ context.Context, u, w string, window time.Duration) (store.WorkerAdmission, error) {
		admissions++
		if u != f.handler.principal.UserID || w != rejectedID || window != 120*time.Second {
			workerHTTPFail(t, "incorrect refused-worker admission")
		}
		return store.WorkerAdmission{ObservedAt: f.now, ActiveCount: 100}, nil
	}}
	f.tx.WriteWorkerCall = func(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
		scopes++
		err := operation(scope)
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	assertProjectError(t, projectRequest(f.handler, http.MethodPost, "/api/v1/me/workers/"+rejectedID+"/report", jsonBody(t, body)), http.StatusConflict, "active_worker_limit_exceeded")
	if scopes != 1 || admissions != 1 {
		t.Fatalf("refused report calls: scopes=%d admissions=%d", scopes, admissions)
	}
	f.tx.WriteWorkerCall = nil
	// An existing active worker remains admissible at the complete owner limit.
	f.reportAdmission(t, id, body, nil, []model.WorkerObservedTask{}, snapshot, store.WorkerAdmission{ObservedAt: f.now, ActiveCount: 100, LastSeenAt: &f.now})
}
func workerInventoryTime() *time.Time {
	value := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	return &value
}

func TestWorkerSnapshotsHTTPIdentityOriginAndCurrentPermissions(t *testing.T) {
	var logs bytes.Buffer
	f := newWorkerHTTPFixture(t, &logs)
	admitted := make(chan struct{}, 1)
	completed := make(chan struct{}, 1)
	stopping := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		select {
		case <-admitted:
		case <-stopping:
			return
		}
		defer func() { completed <- struct{}{} }()
		f.handler.ServeHTTP(w, request)
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(stopping) })
	alice := defaultHTTPPrincipal()
	alice.Kind = model.SessionCredential
	bob := model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.SessionCredential}
	var actor *model.Principal
	origin := ""
	f.send = func(method, path, body string) *httptest.ResponseRecorder {
		request, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Request-ID", "project-test")
		if actor != nil {
			f.handler.authenticate = true
			f.handler.principal = *actor
			if actor.Kind == model.SessionCredential {
				request.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: httpTestToken(model.SessionCredential)})
			} else {
				request.Header.Set("Authorization", "Bearer "+httpTestToken(actor.Kind))
			}
		} else {
			f.handler.authenticate = false
		}
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		// The request barrier publishes the scripted facts to the serving goroutine.
		admitted <- struct{}{}
		client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		<-completed
		if err != nil {
			t.Fatal(err)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		recorder := httptest.NewRecorder()
		recorder.Code = response.StatusCode
		for key, values := range response.Header {
			recorder.Header()[key] = append([]string(nil), values...)
		}
		_, err = recorder.Body.Write(data)
		if err != nil {
			t.Fatal(err)
		}
		return recorder
	}
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	assertProjectError(t, f.send(http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusUnauthorized, "unauthenticated")
	actor = &alice
	origin = "https://foreign.example"
	assertProjectError(t, f.send(http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusForbidden, "forbidden")
	origin = workerTestOrigin
	snapshot := model.WorkerSnapshot{UserID: alice.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}}
	f.handler.principal = alice
	f.report(t, id, body, nil, nil, snapshot)
	actor = &bob
	origin = ""
	f.handler.principal = bob
	calls := 0
	f.read(t, &workerHTTPReader{t: t, WorkerCall: func(_ context.Context, u, w string, now time.Time) (model.WorkerSnapshot, error) {
		calls++
		if u != bob.UserID || w != id || now != f.now {
			workerHTTPFail(t, "incorrect foreign-owner detail query")
		}
		return model.WorkerSnapshot{}, model.ErrNotFound
	}}, func() { assertProjectError(t, f.send(http.MethodGet, path, ""), http.StatusNotFound, "not_found") })
	if calls != 1 {
		t.Fatalf("foreign detail calls: %d", calls)
	}
	foreignPage := f.list(t, "/api/v1/me/workers", store.Page{Limit: 50}, nil)
	if len(foreignPage.Items) != 0 {
		t.Fatal("other account worker leaked")
	}
	actor = nil
	assertProjectError(t, f.send(http.MethodGet, path, ""), http.StatusUnauthorized, "unauthenticated")
	pat := alice
	pat.Kind = model.PATCredential
	pat.CredentialID = uuid.NewString()
	actor = &pat
	f.handler.principal = pat
	f.report(t, id, body, nil, nil, snapshot)
	projectID, taskID, claimID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	claim := map[string]any{"claimId": claimID, "state": "active", "userId": alice.UserID, "workerId": id, "machine": map[string]any{"id": uuid.NewString(), "name": "Worker"}, "platform": "linux", "agent": "codex", "agentControlMode": "web", "worktreeId": uuid.NewString(), "phase": "preparing", "herdr": nil, "nativeSessionId": nil, "claimedAt": f.now.Format(time.RFC3339Nano)}
	task := model.Task{ID: taskID, ProjectID: projectID, Title: "Hidden after revoke", Status: model.TaskInProgress, Properties: model.TaskProperties{"worker": json.RawMessage(jsonBody(t, claim))}}
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": projectID, "taskId": taskID, "claimId": claimID}}}
	items := []model.WorkerObservedTask{{ProjectID: projectID, TaskID: taskID, ClaimID: claimID, Title: task.Title, ProjectName: "Private project", Status: model.TaskInProgress, Phase: model.WorkerPreparing, Agent: model.AgentCodex}}
	active := model.WorkerSnapshot{UserID: alice.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: workerInventoryTime(), Items: items}}
	actor = &alice
	origin = workerTestOrigin
	f.handler.principal = alice
	f.report(t, id, body, []store.WorkerTaskSource{{Task: task, ProjectName: "Private project"}}, items, active)
	detail := f.detail(t, id, active)
	if len(detail.Worker.Tasks) != 1 || detail.Worker.ActiveTaskCount == nil || *detail.Worker.ActiveTaskCount != 1 {
		t.Fatal("current member task missing")
	}
	revoked := active
	revoked.TaskSnapshot.Items = []model.WorkerObservedTask{}
	filtered := f.detail(t, id, revoked)
	encoded, err := json.Marshal(filtered)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Worker.Tasks) != 0 || filtered.Worker.ActiveTaskCount == nil || *filtered.Worker.ActiveTaskCount != 0 || strings.Contains(string(encoded), task.Title) {
		t.Fatal("revoked task row, title or count leaked")
	}
	count := 0
	page := f.list(t, "/api/v1/me/workers", store.Page{Limit: 50}, []store.WorkerSummary{{WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Machine: revoked.Telemetry.Machine, Platform: model.PlatformLinux, TaskObservationState: model.WorkerTasksObserved, TaskObservedAt: &f.now, ActiveTaskCount: &count}})
	if len(page.Items) != 1 || page.Items[0].ActiveTaskCount == nil || *page.Items[0].ActiveTaskCount != 0 {
		t.Fatal("revoked task count leaked through worker summary")
	}
	if strings.Contains(logs.String(), httpTestToken(model.PATCredential)) || strings.Contains(logs.String(), "Private worker machine") || strings.Contains(logs.String(), "/private/work") || strings.Contains(logs.String(), task.Title) {
		t.Fatal("report metadata or credentials leaked to logs")
	}
}

func reportSnapshotHTTP(t *testing.T, handler http.Handler, id string, body map[string]any) api.WorkerReportResponse {
	t.Helper()
	response := projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+id+"/report", jsonBody(t, body))
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") == "" {
		t.Fatal("worker report lacks private response admission headers")
	}
	return decodeResponse[api.WorkerReportResponse](t, response, http.StatusOK)
}

func snapshotDetailHTTP(t *testing.T, handler http.Handler, id string) api.WorkerDetailResponse {
	t.Helper()
	return decodeResponse[api.WorkerDetailResponse](t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers/"+id, ""), http.StatusOK)
}

func TestWorkerSnapshotsHTTPReportReadAndPagination(t *testing.T) {
	var logs bytes.Buffer
	f := newWorkerHTTPFixture(t, &logs)
	handler := f.handler
	empty := f.list(t, "/api/v1/me/workers", store.Page{Limit: 50}, nil)
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil || empty.ObservedAt.IsZero() {
		t.Fatal("invalid empty worker page")
	}
	id := "c3333333-3333-4333-8333-333333333333"
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	unknownSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}}
	reported := f.report(t, strings.ToUpper(id), body, nil, nil, unknownSnapshot)
	if reported.ObservedAt.IsZero() || reported.LastReportedAt.IsZero() {
		t.Fatal("report lacks server timestamps")
	}
	unknown := f.detail(t, id, unknownSnapshot)
	if unknown.Worker.ActiveTaskCount != nil || unknown.Worker.TaskObservationState != "unavailable" || unknown.Worker.TaskObservedAt != nil || unknown.Worker.InventoryObservedAt != nil || unknown.Worker.Tasks == nil {
		t.Fatalf("unknown inventory became idle: %+v", unknown)
	}
	body = workerSnapshotReportBody()
	inventoryAt := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	idleSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventoryAt, Items: []model.WorkerObservedTask{}}}
	f.report(t, id, body, nil, []model.WorkerObservedTask{}, idleSnapshot)
	idle := f.detail(t, id, idleSnapshot)
	if idle.Worker.ActiveTaskCount == nil || *idle.Worker.ActiveTaskCount != 0 || idle.Worker.TaskObservationState != "observed" || idle.Worker.TaskObservedAt == nil || idle.Worker.InventoryObservedAt == nil || idle.Worker.Telemetry.CPU.Value == nil || idle.Worker.Telemetry.Versions.Codex.State != "not_installed" || idle.Worker.Telemetry.Versions.Copilot.Code == nil {
		t.Fatalf("idle or telemetry shape incorrect: %+v", idle)
	}
	projectID, taskID, claimID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	claim := map[string]any{"claimId": claimID, "state": "active", "userId": handler.principal.UserID, "workerId": id, "machine": map[string]any{"id": uuid.NewString(), "name": "Worker"}, "platform": "linux", "agent": "claude", "agentControlMode": "web", "worktreeId": uuid.NewString(), "phase": "preparing", "herdr": nil, "nativeSessionId": nil, "claimedAt": f.now.Format(time.RFC3339Nano)}
	task := model.Task{ID: taskID, ProjectID: projectID, Title: "Snapshot-owned task", Status: model.TaskInProgress, Properties: model.TaskProperties{"worker": json.RawMessage(jsonBody(t, claim)), "pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Opaque evidence"}]`)}}
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": projectID, "taskId": taskID, "claimId": claimID}}}
	expectedItems := []model.WorkerObservedTask{{ProjectID: projectID, TaskID: taskID, ClaimID: claimID, Title: task.Title, ProjectName: "Project", Status: model.TaskInProgress, Phase: model.WorkerPreparing, Agent: model.AgentClaude}}
	activeSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventoryAt, Items: expectedItems}}
	f.report(t, id, body, []store.WorkerTaskSource{{Task: task, ProjectName: "Project"}}, expectedItems, activeSnapshot)
	active := f.detail(t, id, activeSnapshot)
	if active.Worker.ActiveTaskCount == nil || *active.Worker.ActiveTaskCount != 1 || len(active.Worker.Tasks) != 1 || active.Worker.Tasks[0].Agent != "claude" || active.Worker.Tasks[0].Title != task.Title {
		t.Fatalf("authorized task snapshot missing: %+v", active)
	}
	body["taskInventory"] = nil
	staleSnapshot := activeSnapshot
	staleSnapshot.TaskSnapshot.State = model.WorkerTasksStale
	f.report(t, id, body, nil, nil, staleSnapshot)
	stale := f.detail(t, id, staleSnapshot)
	if stale.Worker.TaskObservationState != "stale" || len(stale.Worker.Tasks) != 1 || stale.Worker.Tasks[0].Status != "in_progress" || stale.Worker.TaskObservedAt == nil || !stale.Worker.TaskObservedAt.Equal(*active.Worker.TaskObservedAt) {
		t.Fatalf("historical snapshot was overwritten by current task state: %+v", stale)
	}
	lastSeen := stale.Worker.LastReportedAt
	if next := f.detail(t, id, staleSnapshot); !next.Worker.LastReportedAt.Equal(lastSeen) {
		t.Fatal("GET refreshed liveness")
	}
	second := "d4444444-4444-4444-8444-444444444444"
	secondBody := workerSnapshotReportBody()
	secondBody["versions"].(map[string]any)["herdr"] = map[string]any{"state": "not_running", "checkedAt": "2026-10-29T00:00:00Z"}
	secondSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: second, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, secondBody), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventoryAt, Items: []model.WorkerObservedTask{}}}
	f.report(t, second, secondBody, nil, []model.WorkerObservedTask{}, secondSnapshot)
	count := 1
	summaries := []store.WorkerSummary{{WorkerID: id, CreatedAt: staleSnapshot.CreatedAt, LastReportedAt: lastSeen, Machine: staleSnapshot.Telemetry.Machine, Platform: model.PlatformLinux, TaskObservationState: model.WorkerTasksStale, TaskObservedAt: &f.now, ActiveTaskCount: &count}, {WorkerID: second, CreatedAt: secondSnapshot.CreatedAt, LastReportedAt: secondSnapshot.LastReportedAt, Machine: secondSnapshot.Telemetry.Machine, Platform: model.PlatformLinux, TaskObservationState: model.WorkerTasksObserved}}
	page := f.list(t, "/api/v1/me/workers?limit=1", store.Page{Limit: 1}, summaries)
	if len(page.Items) != 1 || page.Items[0].WorkerID != id || page.NextCursor == nil {
		t.Fatalf("first page incorrect: %+v", page)
	}
	next := f.list(t, "/api/v1/me/workers?limit=1&cursor="+url.QueryEscape(*page.NextCursor), store.Page{Limit: 1, After: &store.Position{CreatedAt: staleSnapshot.CreatedAt, ID: id}}, summaries[1:])
	if len(next.Items) != 1 || next.Items[0].WorkerID != second || next.NextCursor != nil {
		t.Fatalf("stable continuation incorrect: %+v", next)
	}
	if text := logs.String(); !strings.Contains(text, `"worker_id":"`+id+`"`) || !strings.Contains(text, `"component":"worker_report"`) || strings.Contains(text, "/private/work") || strings.Contains(text, "Private worker machine") || strings.Contains(text, "Snapshot-owned task") {
		t.Fatal("worker logs lack correlation or expose private content")
	}
}

func TestWorkerSnapshotsHTTPRejectsInvalidInputsAndMethods(t *testing.T) {
	f := newWorkerHTTPFixture(t, io.Discard)
	handler := f.handler
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	for _, body := range []string{"", `null`, `[]`, `{}`, `{"state":true}`, `{"machine":null,"machine":null}`, string([]byte{'{', 0xff, '}'})} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", body), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", strings.Repeat(" ", httpx.MaxJSONBody)+"{}"), http.StatusRequestEntityTooLarge, "payload_too_large")
	for _, mutate := range []func(map[string]any){
		func(b map[string]any) { b["userId"] = uuid.NewString() }, func(b map[string]any) { b["workingDirectory"] = "NUL\x00" }, func(b map[string]any) { b["platform"] = "unknown" },
		func(b map[string]any) { b["cpu"].(map[string]any)["value"].(map[string]any)["usagePercent"] = 101 },
		func(b map[string]any) { b["memory"].(map[string]any)["value"].(map[string]any)["usedBytes"] = 99 },
		func(b map[string]any) { b["versions"].(map[string]any)["copilot"].(map[string]any)["code"] = "unknown" },
		func(b map[string]any) {
			b["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": "bad", "taskId": uuid.NewString(), "claimId": uuid.NewString()}}}
		},
	} {
		body := workerSnapshotReportBody()
		mutate(body)
		assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	}
	for _, stamp := range []string{"2026-10-29T00:00:00+24:00", "2026-10-29T00:00:00+00:60", "2026-10-29T00:00:00,1Z"} {
		for _, field := range []string{"sampledAt", "checkedAt", "observedAt"} {
			body := workerSnapshotReportBody()
			switch field {
			case "sampledAt":
				body["sampledAt"] = stamp
			case "checkedAt":
				body["cpu"].(map[string]any)["checkedAt"] = stamp
			case "observedAt":
				body["taskInventory"].(map[string]any)["observedAt"] = stamp
			}
			assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
		}
	}
	for _, target := range []string{"not-uuid/report", id + "/report?", id + "/report?x=1"} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+target, jsonBody(t, workerSnapshotReportBody())), http.StatusBadRequest, "invalid_input")
	}
	for _, target := range []string{"?limit=0", "?limit=101", "?limit=1&limit=2", "?cursor=bad", "?unknown=x", "?limit=%zz"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers"+target, ""), http.StatusBadRequest, "invalid_input")
	}
	for _, target := range []string{"not-uuid", id + "?", id + "?x=1"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers/"+target, ""), http.StatusBadRequest, "invalid_input")
	}
	calls := 0
	f.read(t, &workerHTTPReader{t: t, WorkerCall: func(_ context.Context, u, w string, now time.Time) (model.WorkerSnapshot, error) {
		calls++
		if u != handler.principal.UserID || w != id || now != f.now {
			t.Fatal("wrong missing-worker query")
		}
		return model.WorkerSnapshot{}, model.ErrNotFound
	}}, func() {
		assertProjectError(t, projectRequest(handler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")
	})
	if calls != 1 {
		t.Fatalf("missing-worker calls: %d", calls)
	}
	for _, test := range []struct{ path, method, allow string }{{"/api/v1/me/workers", http.MethodPost, "GET, HEAD"}, {path, http.MethodPatch, "GET, HEAD"}, {path + "/report", http.MethodGet, "POST"}} {
		response := projectRequest(handler, test.method, test.path, "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != test.allow {
			t.Fatal("incorrect allowed methods")
		}
	}
	request := httptest.NewRequest(http.MethodPost, path+"/report", strings.NewReader(jsonBody(t, workerSnapshotReportBody())))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatal("non-JSON report accepted")
	}
}

func (s *workerHTTPReadScope) GitHubDAO() store.GitHubReadDAO { panic("unexpected GitHubDAO access") }
