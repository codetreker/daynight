package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	monitoring "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

const monitoringWorkerID = "11111111-1111-4111-8111-111111111111"
const monitoringOtherID = "22222222-2222-4222-8222-222222222222"
const monitoringBody = `{"expectedRevision":null,"observation":{"runId":"22222222-2222-4222-8222-222222222222","sequence":"1","capturedAt":"2026-10-29T00:00:00Z","lifecycle":"running","scheduler":{"phase":"initializing","coverage":"unknown","cycleId":null,"lastCompletedAt":null,"lastSuccessfulAt":null,"lastOutcome":null,"nextPollAt":null},"capacity":null,"admission":{"observedAt":"2026-10-29T00:00:00Z","coverage":"unknown","reasons":[]},"reservations":[],"activities":[],"currentFailures":[],"lastRecovery":null,"detailCoverage":"complete","delivery":{"lastSucceededAt":null,"lastFailure":null}}}`

type monitoringMock struct {
	workerService
	calls       int
	principal   model.Principal
	id          string
	ids         []string
	revision    *string
	observation monitoring.Observation
	detail      *monitoring.DetailResponse
	query       *monitoring.QueryResponse
	err         error
	started     chan struct{}
}

func (m *monitoringMock) PutMonitoring(_ context.Context, p model.Principal, id string, revision *string, observation monitoring.Observation) (monitoring.Receipt, error) {
	m.calls++
	m.principal, m.id, m.revision, m.observation = p, id, revision, observation
	return monitoring.Receipt{Revision: monitoringOtherID, RunID: monitoringOtherID, Sequence: "1", ReceivedAt: time.Unix(1, 0).UTC(), ExpiresAt: time.Unix(3601, 0).UTC()}, m.err
}
func (m *monitoringMock) GetMonitoring(ctx context.Context, p model.Principal, id string) (monitoring.DetailResponse, error) {
	m.calls++
	m.principal, m.id = p, id
	if m.started != nil {
		close(m.started)
		<-ctx.Done()
		return monitoring.DetailResponse{}, ctx.Err()
	}
	if m.detail != nil {
		return *m.detail, m.err
	}
	return monitoring.DetailResponse{ObservedAt: time.Unix(1, 0).UTC(), State: "absent", DetailCoverage: "complete", PermissionProjection: "current"}, m.err
}
func (m *monitoringMock) QueryMonitoring(_ context.Context, p model.Principal, ids []string) (monitoring.QueryResponse, error) {
	m.calls++
	m.principal, m.ids = p, ids
	if m.query != nil {
		return *m.query, m.err
	}
	return monitoring.QueryResponse{ObservedAt: time.Unix(1, 0).UTC(), Items: []monitoring.QueryItem{}}, m.err
}
func monitoringRouter(mock *monitoringMock, principal model.Principal) http.Handler {
	mux := http.NewServeMux()
	registerRoutes(mux, &workersHandler{workers: mock, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, func(next httpx.AuthenticatedHandler) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { next(w, r, principal) }
	})
	return mux
}
func monitoringRequest(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestMonitoringRoutingAndInput(t *testing.T) {
	mock := &monitoringMock{}
	principal := model.Principal{UserID: monitoringOtherID}
	h := monitoringRouter(mock, principal)
	path := "/api/v1/me/workers/" + monitoringWorkerID + "/monitoring"
	w := monitoringRequest(h, "PUT", path, monitoringBody)
	if w.Code != 200 || mock.calls != 1 || mock.principal != principal || mock.id != monitoringWorkerID || mock.revision != nil || mock.observation["sequence"] != "1" || !strings.Contains(w.Body.String(), `"revision":"`+monitoringOtherID+`"`) {
		t.Fatalf("PUT: %d %s %+v", w.Code, w.Body, mock)
	}
	w = monitoringRequest(h, "GET", path, "")
	if w.Code != 200 || mock.calls != 2 || !strings.Contains(w.Body.String(), `"state":"absent"`) || !strings.Contains(w.Body.String(), `"data":null`) {
		t.Fatalf("GET: %d %s", w.Code, w.Body)
	}
	query := "/api/v1/me/workers/monitoring/query"
	w = monitoringRequest(h, "POST", query, `{"workerIds":["`+monitoringOtherID+`","`+monitoringWorkerID+`"]}`)
	if w.Code != 200 || mock.calls != 3 || len(mock.ids) != 2 || mock.ids[0] != monitoringOtherID || mock.ids[1] != monitoringWorkerID {
		t.Fatalf("query: %d %s %+v", w.Code, w.Body, mock.ids)
	}
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"PUT", path + "?", monitoringBody, 400}, {"GET", path + "?x=1", "", 400}, {"POST", query + "?x=1", `{}`, 400},
		{"PUT", strings.ToUpper(path), monitoringBody, 404}, {"PUT", "/api/v1/me/workers/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/monitoring", monitoringBody, 400},
		{"PUT", path, `{}`, 400}, {"PUT", path, strings.Replace(monitoringBody, `"expectedRevision":null`, `"expectedRevision":"BAD"`, 1), 400},
		{"PUT", path, strings.Replace(monitoringBody, `"sequence":"1"`, `"sequence":"01"`, 1), 400},
		{"PUT", path, strings.Replace(monitoringBody, `"lifecycle":"running"`, `"lifecycle":"running","unknown":true`, 1), 400},
		{"PUT", path, monitoringBody + strings.Repeat(" ", monitoringRequestLimit), 413},
		{"POST", query, `{"workerIds":[]}`, 400}, {"POST", query, `{"workerIds":null}`, 400},
		{"POST", query, `{"workerIds":["` + monitoringWorkerID + `","` + monitoringWorkerID + `"]}`, 400},
		{"POST", query, `{"workerIds":["BAD"]}`, 400}, {"POST", query, `{"workerIds":["` + monitoringWorkerID + `"],"owner":"a"}`, 400},
		{"HEAD", path, "", 405}, {"POST", path, "", 405}, {"GET", query, "", 405},
	} {
		w = monitoringRequest(h, tc.method, tc.path, tc.body)
		if w.Code != tc.status || mock.calls != 3 {
			t.Errorf("%s %s: %d (%s), calls %d; wanted %d", tc.method, tc.path, w.Code, w.Body, mock.calls, tc.status)
		}
	}
}

func TestMonitoringWorktreeHTTPAdmission(t *testing.T) {
	mock := &monitoringMock{}
	h := monitoringRouter(mock, model.Principal{UserID: monitoringOtherID})
	path := "/api/v1/me/workers/" + monitoringWorkerID + "/monitoring"
	failure := `{"operationId":"` + monitoringOtherID + `","component":"cleanup","phase":"archive","scope":{"kind":"claim","projectId":"` + monitoringWorkerID + `","taskId":"` + monitoringOtherID + `","claimId":"` + monitoringOtherID + `"},"error":{"type":"operation","code":"unknown","cause":"The operation failed; inspect local Worker diagnostics for details.","causeTruncated":false},"firstObservedAt":"2026-10-29T00:00:00Z","lastObservedAt":"2026-10-29T00:00:00Z","occurrencesInRun":1,"retryState":"none","nextAttemptAt":null,"worktree":{"kind":"project-relative","path":"../tree/<>&"}}`
	body := strings.Replace(monitoringBody, `"currentFailures":[]`, `"currentFailures":[`+failure+`]`, 1)
	w := monitoringRequest(h, "PUT", path, body)
	if w.Code != http.StatusOK || mock.calls != 1 || mock.observation["currentFailures"].([]any)[0].(map[string]any)["worktree"].(map[string]any)["path"] != "../tree/<>&" {
		t.Fatalf("worktree PUT: %d %s", w.Code, w.Body)
	}
	for _, invalid := range []string{
		strings.Replace(body, `"path":"../tree/<>&"`, `"path":"/absolute"`, 1),
		strings.Replace(body, `"path":"../tree/<>&"`, `"path":"\ud800"`, 1),
		strings.Replace(body, `"worktree":{"kind":"project-relative","path":"../tree/<>&"}`, `"worktree":null`, 1),
		strings.Replace(body, `"kind":"claim"`, `"kind":"worker"`, 1),
	} {
		w = monitoringRequest(h, "PUT", path, invalid)
		if w.Code != http.StatusBadRequest || mock.calls != 1 {
			t.Fatalf("invalid worktree: status=%d calls=%d body=%s", w.Code, mock.calls, w.Body)
		}
	}
}

func TestMonitoringErrorsAndCancellation(t *testing.T) {
	mock := &monitoringMock{}
	h := monitoringRouter(mock, model.Principal{UserID: monitoringOtherID})
	path := "/api/v1/me/workers/" + monitoringWorkerID + "/monitoring"
	for code, status := range map[string]int{"not_found": 404, "monitoring_revision_conflict": 409, "monitoring_sequence_stale": 409, "monitoring_sample_conflict": 409, "monitoring_state_lost": 409, "monitoring_unavailable": 503, "monitoring_write_outcome_unknown": 503} {
		mock.err = &model.Fault{Code: code, Message: "safe", Cause: errors.New("redis://secret")}
		w := monitoringRequest(h, "GET", path, "")
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if w.Code != status || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error.Code != code || strings.Contains(w.Body.String(), "secret") {
			t.Errorf("%s: %d %s", code, w.Code, w.Body)
		}
	}
	mock.err = &model.Fault{Code: "monitoring_unavailable", Message: "safe", Cause: context.DeadlineExceeded}
	if w := monitoringRequest(h, "GET", path, ""); w.Code != 503 {
		t.Fatalf("Redis deadline: %d %s", w.Code, w.Body)
	}
	ridRequest := httptest.NewRequest("GET", path, nil)
	ridRequest = ridRequest.WithContext(requestid.With(ridRequest.Context(), "monitor-request"))
	ridResponse := httptest.NewRecorder()
	h.ServeHTTP(ridResponse, ridRequest)
	if !strings.Contains(ridResponse.Body.String(), `"requestId":"monitor-request"`) {
		t.Fatalf("request ID lost: %s", ridResponse.Body)
	}
	mock.started = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("GET", path, nil).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, r); close(done) }()
	select {
	case <-mock.started:
	case <-time.After(time.Second):
		t.Fatal("operation not started")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("operation did not observe cancellation")
	}
	if w.Body.Len() != 0 {
		t.Fatalf("cancelled response: %s", w.Body)
	}
}

func TestMonitoringRequestLimitsAndMethodHeaders(t *testing.T) {
	mock := &monitoringMock{}
	h := monitoringRouter(mock, model.Principal{UserID: monitoringOtherID})
	path := "/api/v1/me/workers/" + monitoringWorkerID + "/monitoring"
	query := "/api/v1/me/workers/monitoring/query"
	padding := strings.Repeat(" ", monitoringRequestLimit-len(monitoringBody))
	if w := monitoringRequest(h, "PUT", path, monitoringBody+padding); w.Code != 200 {
		t.Fatalf("limit body: %d %s", w.Code, w.Body)
	}
	if w := monitoringRequest(h, "PUT", path, monitoringBody+padding+" "); w.Code != 413 || mock.calls != 1 {
		t.Fatalf("over limit body: %d %s", w.Code, w.Body)
	}
	for _, method := range []string{"HEAD", "POST", "DELETE"} {
		w := monitoringRequest(h, method, path, "")
		if w.Code != 405 || w.Header().Get("Allow") != "GET, PUT" {
			t.Errorf("%s: %d Allow %q", method, w.Code, w.Header().Get("Allow"))
		}
	}
	for _, method := range []string{"HEAD", "GET", "PUT", "DELETE"} {
		w := monitoringRequest(h, method, query, "")
		if w.Code != 405 || w.Header().Get("Allow") != "POST" {
			t.Errorf("%s query: %d Allow %q", method, w.Code, w.Header().Get("Allow"))
		}
	}
	r := httptest.NewRequest("PUT", path, strings.NewReader(monitoringBody))
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 || mock.calls != 1 {
		t.Fatalf("invalid media type: %d calls %d", w.Code, mock.calls)
	}
	for _, body := range []string{
		strings.Replace(monitoringBody, `"expectedRevision":null`, `"expectedRevision":null,"expectedRevision":null`, 1),
		strings.Replace(monitoringBody, `"expectedRevision":null`, `"expectedRevision":1`, 1),
		strings.Replace(monitoringBody, `"expectedRevision":null`, `"expectedRevision":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"`, 1),
		strings.Replace(monitoringBody, `"observation":{`, `"observation":{"association":null,`, 1),
	} {
		if w := monitoringRequest(h, "PUT", path, body); w.Code != 400 || mock.calls != 1 {
			t.Errorf("invalid body: %d %s", w.Code, w.Body)
		}
	}
	ids := make([]string, 101)
	for i := range ids {
		ids[i] = fmt.Sprintf("%08x-1111-4111-8111-111111111111", i+1)
	}
	body, err := json.Marshal(map[string]any{"workerIds": ids[:100]})
	if err != nil {
		t.Fatal(err)
	}
	if w := monitoringRequest(h, "POST", query, string(body)); w.Code != 200 || mock.calls != 2 || len(mock.ids) != 100 || mock.ids[99] != ids[99] {
		t.Fatalf("100 ids: %d %s", w.Code, w.Body)
	}
	body, err = json.Marshal(map[string]any{"workerIds": ids})
	if err != nil {
		t.Fatal(err)
	}
	if w := monitoringRequest(h, "POST", query, string(body)); w.Code != 400 || mock.calls != 2 {
		t.Fatalf("101 ids: %d %s", w.Code, w.Body)
	}
}

func TestMonitoringFailureDoesNotExposeRedisCause(t *testing.T) {
	var logs bytes.Buffer
	mock := &monitoringMock{err: &model.Fault{Code: "monitoring_unavailable", Message: "Monitoring is unavailable.", Cause: &net.OpError{Op: "dial", Err: errors.New("redis://secret")}}}
	h := &workersHandler{workers: mock, logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	r := httptest.NewRequest("GET", "/", nil)
	r.SetPathValue("workerId", monitoringWorkerID)
	r = r.WithContext(requestid.With(r.Context(), "monitor-request"))
	w := httptest.NewRecorder()
	h.getMonitoring(w, r, model.Principal{UserID: monitoringOtherID})
	if w.Code != 503 || strings.Contains(w.Body.String(), "secret") || strings.Contains(logs.String(), "secret") {
		t.Fatalf("unsafe failure: %d %s %s", w.Code, w.Body, logs.String())
	}
	for _, value := range []string{`"component":"worker_monitoring"`, `"phase":"read"`, `"request_id":"monitor-request"`, `"error_code":"monitoring_unavailable"`} {
		if !strings.Contains(logs.String(), value) {
			t.Errorf("log missing %s: %s", value, logs.String())
		}
	}
}

func TestMonitoringDetailTransmitsBoundedEscapedTitles(t *testing.T) {
	var request struct {
		Observation json.RawMessage `json:"observation"`
	}
	if err := json.Unmarshal([]byte(monitoringBody), &request); err != nil {
		t.Fatal(err)
	}
	observation, err := monitoring.ParseObservation(request.Observation)
	if err != nil {
		t.Fatal(err)
	}
	activities := make([]any, 128)
	for i := range activities {
		task := fmt.Sprintf("30000000-0000-4000-8000-%012x", i+1)
		activities[i] = map[string]any{"kind": "cleanup", "phase": "archive", "operationId": task, "status": "running", "scope": map[string]any{"kind": "claim", "projectId": monitoringWorkerID, "taskId": task, "claimId": monitoringOtherID}, "startedAt": "2026-10-29T00:00:00Z", "lastProgressAt": nil, "elapsedMs": 0, "deadlineAt": nil, "waitReason": nil, "nextAttemptAt": nil}
	}
	observation["activities"] = activities
	raw, err := json.Marshal(observation)
	if err != nil {
		t.Fatal(err)
	}
	observation, err = monitoring.ParseObservation(raw)
	if err != nil {
		t.Fatal(err)
	}
	for i, raw := range observation["activities"].([]any) {
		activity := raw.(map[string]any)
		if i < 74 {
			activity["association"] = map[string]any{"kind": "task", "projectName": "Project", "title": strings.Repeat("<", 1024)}
		} else {
			activity["association"] = map[string]any{"kind": "labels-omitted"}
		}
	}
	observation["detailCoverage"] = "partial"
	now := time.Unix(1, 0).UTC()
	expires := now.Add(time.Hour)
	id, seq := monitoringOtherID, "1"
	result := monitoring.DetailResponse{ObservedAt: now, State: "available", Revision: &id, RunID: &id, Sequence: &seq, ReceivedAt: &now, ExpiresAt: &expires, Data: observation, DetailCoverage: "partial", PermissionProjection: "current"}
	mock := &monitoringMock{detail: &result}
	w := monitoringRequest(monitoringRouter(mock, model.Principal{UserID: monitoringOtherID}), "GET", "/api/v1/me/workers/"+monitoringWorkerID+"/monitoring", "")
	if w.Code != http.StatusOK || w.Body.Len() > monitoring.MaxDetail || !strings.Contains(w.Body.String(), `"detailCoverage":"partial"`) || !strings.Contains(w.Body.String(), `"kind":"labels-omitted"`) || !strings.Contains(w.Body.String(), `\u003c`) || mock.calls != 1 {
		t.Fatalf("bounded detail: status=%d bytes=%d", w.Code, w.Body.Len())
	}
}

func TestMonitoringQueryTransmitsMaximumPublicSummaries(t *testing.T) {
	observedText := "9999-12-31T23:59:59.999999999Z"
	observed, err := time.Parse(time.RFC3339Nano, observedText)
	if err != nil {
		t.Fatal(err)
	}
	received := observed.Add(-time.Hour)
	codes := []string{
		"configuration-unavailable", "configuration-incomplete", "inventory-unavailable",
		"project-unavailable", "project-preparation-failed", "resource-observation-unavailable",
		"capacity-full", "cleanup-capacity-blocked", "no-projects-selected", "no-ready-tasks",
		"claim-unconfirmed", "retained-resource-conflict", "stopping",
	}
	public := monitoring.PublicSummary{
		CapturedAt: observedText, Lifecycle: "starting",
		Scheduler:      monitoring.SummaryScheduler{Phase: "resource-observation", Coverage: "complete", LastSuccessfulAt: &observedText, NextPollAt: &observedText},
		Capacity:       &monitoring.SummaryCapacity{ObservedAt: observedText, Quality: "current", Limit: 64, Occupied: 9007199254740991, Available: 0},
		DetailCoverage: "complete",
		Admission:      monitoring.PublicAdmission{ObservedAt: observedText, Coverage: "complete", ReasonCodes: codes, PermissionProjection: "restricted"},
	}
	raw, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	// The protocol codec owns public-summary validation; the HTTP adapter below
	// receives the already projected result from its directly mocked service.
	summary, err := monitoring.ParseSummary(raw)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 100)
	items := make([]monitoring.QueryItem, len(ids))
	revision := "ffffffff-ffff-4fff-bfff-ffffffffffff"
	for i := range ids {
		ids[i] = fmt.Sprintf("%08x-ffff-4fff-bfff-ffffffffffff", i+1)
		items[i] = monitoring.QueryItem{WorkerID: ids[i], State: "available", Revision: &revision, ReceivedAt: &received, ExpiresAt: &observed, Summary: summary}
	}
	input, err := json.Marshal(map[string]any{"workerIds": ids})
	if err != nil {
		t.Fatal(err)
	}
	result := monitoring.QueryResponse{ObservedAt: observed, Items: items}
	mock := &monitoringMock{query: &result}
	principal := model.Principal{UserID: monitoringOtherID}
	response := monitoringRequest(monitoringRouter(mock, principal), http.MethodPost, "/api/v1/me/workers/monitoring/query", string(input))
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/json" || mock.calls != 1 || mock.principal != principal {
		t.Fatalf("query response: status=%d type=%q calls=%d", response.Code, response.Header().Get("Content-Type"), mock.calls)
	}
	wire := response.Body.Bytes()
	if len(wire) == 0 || wire[len(wire)-1] != '\n' || len(wire) > monitoring.MaxQuery {
		t.Fatalf("encoded query response including newline exceeds budget: %d bytes", len(wire))
	}
	var got monitoring.QueryResponse
	if err := json.Unmarshal(wire, &got); err != nil {
		t.Fatal(err)
	}
	if len(mock.ids) != len(ids) || len(got.Items) != len(ids) || !got.ObservedAt.Equal(observed) {
		t.Fatalf("wrong query size or observation time: requested=%d received=%d observed=%v", len(mock.ids), len(got.Items), got.ObservedAt)
	}
	for i, item := range got.Items {
		if mock.ids[i] != ids[i] || item.WorkerID != ids[i] || item.State != "available" || item.Revision == nil || *item.Revision != revision || item.ReceivedAt == nil || !item.ReceivedAt.Equal(received) || item.ExpiresAt == nil || !item.ExpiresAt.Equal(observed) {
			t.Fatalf("wrong request or result order at %d: %+v", i, item)
		}
		if !bytes.Equal(item.Summary, summary) {
			t.Fatalf("summary changed in HTTP transmission at %d", i)
		}
		parsed, err := monitoring.ParsePublicSummary(item.Summary)
		if err != nil || len(parsed.Admission.ReasonCodes) != len(codes) || parsed.Admission.PermissionProjection != "restricted" {
			t.Fatalf("invalid public summary at %d: %+v %v", i, parsed.Admission, err)
		}
		for index, code := range codes {
			if parsed.Admission.ReasonCodes[index] != code {
				t.Fatalf("wrong reason order at %d/%d", i, index)
			}
		}
	}
	for _, forbidden := range []string{`"scope"`, `"scopeToken"`, `"projectId"`, `"taskId"`, `"claimId"`, `"codeIndex"`, `"reasons"`} {
		if bytes.Contains(wire, []byte(forbidden)) {
			t.Fatalf("private field %s in public response", forbidden)
		}
	}
	t.Logf("100-worker response including newline: %d bytes (limit %d)", len(wire), monitoring.MaxQuery)
}
