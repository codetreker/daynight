package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
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

type workerHTTPFixture struct {
	operations *capacityReportOperations
	handler    *resourceTestHandler
	now        time.Time
	send       func(string, string, string) *httptest.ResponseRecorder
}

type workerHTTPMetadataKey struct{}

type workerHTTPMetadata struct {
	incomingRequestID string
	responseHeader    http.Header
}

func newWorkerHTTPFixture(t *testing.T, output io.Writer) *workerHTTPFixture {
	t.Helper()
	f := &workerHTTPFixture{operations: &capacityReportOperations{t: t}, now: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)}
	f.handler = newOperationHTTPServer(t, func(d *httpDependencies) { d.Workers = f.operations }, output, defaultHTTPPrincipal())
	handler := f.handler.Handler
	f.handler.Handler = http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		metadata := &workerHTTPMetadata{incomingRequestID: request.Header.Get("X-Request-ID"), responseHeader: w.Header()}
		ctx := context.WithValue(request.Context(), workerHTTPMetadataKey{}, metadata)
		handler.ServeHTTP(w, request.WithContext(ctx))
	})
	f.send = func(method, path, body string) *httptest.ResponseRecorder {
		return projectRequest(f.handler, method, path, body)
	}
	return f
}

func (f *workerHTTPFixture) require(t *testing.T, ctx context.Context, principal model.Principal) {
	t.Helper()
	requireOperationHTTPContext(t, ctx)
	invocation := ctx.Value(operationHTTPRequestKey{}).(*operationHTTPRequest)
	invocation.mu.Lock()
	authenticatedContext := invocation.authenticationContext
	invocation.mu.Unlock()
	if ctx != authenticatedContext || principal != f.handler.principal {
		workerHTTPFail(t, "Worker operation changed authenticated request context or principal: %+v", principal)
	}
	metadata, ok := ctx.Value(workerHTTPMetadataKey{}).(*workerHTTPMetadata)
	if !ok {
		workerHTTPFail(t, "Worker operation lost incoming request metadata")
	}
	responseID := metadata.responseHeader.Get("X-Request-ID")
	if !httpx.ValidRequestID(responseID) || httpx.RequestID(ctx) != responseID || httpx.RequestID(authenticatedContext) != responseID {
		workerHTTPFail(t, "Worker request ID differs between response, authentication and operation: %q", responseID)
	}
	if httpx.ValidRequestID(metadata.incomingRequestID) && responseID != metadata.incomingRequestID {
		workerHTTPFail(t, "Worker request ID changed: got %q, want %q", responseID, metadata.incomingRequestID)
	}
}

func workerHTTPTelemetry(t *testing.T, body map[string]any) model.WorkerTelemetry {
	t.Helper()
	return workerHTTPValue[model.WorkerTelemetry](t, body)
}

func workerHTTPReportInput(t *testing.T, body map[string]any) model.WorkerReport {
	t.Helper()
	return model.WorkerReport{Telemetry: workerHTTPTelemetry(t, body), TaskInventory: workerHTTPValue[*model.WorkerTaskInventory](t, body["taskInventory"])}
}

func (f *workerHTTPFixture) report(t *testing.T, id string, body map[string]any, stored model.WorkerSnapshot) api.WorkerReportResponse {
	t.Helper()
	response := f.reportResult(t, id, body, workerservice.WorkerReportResult{ObservedAt: f.now, LastReportedAt: stored.LastReportedAt}, nil)
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		t.Fatal("report lacks private response admission headers")
	}
	got := decodeResponse[api.WorkerReportResponse](t, response, http.StatusOK)
	want := api.WorkerReportResponse{ObservedAt: f.now, LastReportedAt: stored.LastReportedAt}
	if got != want {
		workerHTTPFail(t, "Worker report=%+v want=%+v", got, want)
	}
	return got
}

func (f *workerHTTPFixture) reportResult(t *testing.T, id string, body map[string]any, result workerservice.WorkerReportResult, failure error) *httptest.ResponseRecorder {
	t.Helper()
	want := workerHTTPReportInput(t, body)
	calls := 0
	f.operations.report = func(ctx context.Context, principal model.Principal, worker string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		f.require(t, ctx, principal)
		calls++
		if calls != 1 || worker != strings.ToLower(id) || !reflect.DeepEqual(input, want) {
			workerHTTPFail(t, "Report arguments: worker=%s input=%+v want=%+v calls=%d", worker, input, want, calls)
		}
		return workerHTTPValue[workerservice.WorkerReportResult](t, result), failure
	}
	defer func() { f.operations.report = nil }()
	response := f.send(http.MethodPost, "/api/v1/me/workers/"+id+"/report", jsonBody(t, body))
	if calls != 1 {
		workerHTTPFail(t, "Report calls=%d want 1", calls)
	}
	return response
}

func workerHTTPNotFound(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
	}
	return err
}

func (f *workerHTTPFixture) getResult(t *testing.T, id string, stored model.WorkerSnapshot, failure error, request func() *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	want := workerHTTPValue[model.WorkerSnapshot](t, stored)
	calls := 0
	f.operations.get = func(ctx context.Context, principal model.Principal, worker string) (workerservice.WorkerDetailResult, error) {
		f.require(t, ctx, principal)
		calls++
		if calls != 1 || worker != id {
			workerHTTPFail(t, "Get arguments: worker=%s want=%s calls=%d", worker, id, calls)
		}
		return workerservice.WorkerDetailResult{ObservedAt: f.now, Worker: workerHTTPValue[model.WorkerSnapshot](t, want)}, failure
	}
	defer func() { f.operations.get = nil }()
	response := request()
	if calls != 1 {
		workerHTTPFail(t, "Get calls=%d want 1", calls)
	}
	return response
}

func (f *workerHTTPFixture) detail(t *testing.T, id string, stored model.WorkerSnapshot) api.WorkerDetailResponse {
	t.Helper()
	response := f.getResult(t, id, stored, nil, func() *httptest.ResponseRecorder { return f.send(http.MethodGet, "/api/v1/me/workers/"+id, "") })
	got := decodeResponse[api.WorkerDetailResponse](t, response, http.StatusOK)
	want := api.WorkerDetailResponse{ObservedAt: f.now, Worker: api.WorkerDetail{
		WorkerSummary: workerprotocol.WorkerSummary{WorkerID: stored.WorkerID, Machine: workerprotocol.WorkerMachine{ID: stored.Telemetry.Machine.ID, Name: stored.Telemetry.Machine.Name}, Platform: string(stored.Telemetry.Platform), LastReportedAt: stored.LastReportedAt, TaskObservationState: string(stored.TaskSnapshot.State), TaskObservedAt: workerHTTPValue[*time.Time](t, stored.TaskSnapshot.ObservedAt)},
		Telemetry:     workerHTTPValue[api.WorkerTelemetry](t, stored.Telemetry), InventoryObservedAt: workerHTTPValue[*time.Time](t, stored.TaskSnapshot.InventoryObservedAt), Tasks: []workerprotocol.WorkerTaskSnapshot{},
	}}
	if stored.TaskSnapshot.State != model.WorkerTasksUnavailable {
		count := len(stored.TaskSnapshot.Items)
		want.Worker.ActiveTaskCount = &count
	}
	for _, item := range stored.TaskSnapshot.Items {
		want.Worker.Tasks = append(want.Worker.Tasks, workerprotocol.WorkerTaskSnapshot{ProjectID: item.ProjectID, TaskID: item.TaskID, ClaimID: item.ClaimID, Title: item.Title, ProjectName: item.ProjectName, Status: string(item.Status), Phase: string(item.Phase), Agent: string(item.Agent)})
	}
	if !reflect.DeepEqual(got, want) {
		workerHTTPFail(t, "Worker detail=%+v want=%+v", got, want)
	}
	return got
}

func workerHTTPContinuation(t *testing.T, user string, position store.Position) string {
	t.Helper()
	raw := jsonBody(t, map[string]any{"version": 1, "kind": "workers", "projectId": "", "status": nil, "ready": nil, "allowAgents": nil, "compatiblePlatform": nil, "workerId": nil, "workerUserId": user, "createdAt": position.CreatedAt, "id": position.ID})
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func (f *workerHTTPFixture) list(t *testing.T, path string, page store.Page, summaries []store.WorkerSummary) api.WorkerPage {
	t.Helper()
	want := model.PageRequest{Limit: page.Limit}
	if page.After != nil {
		cursor := workerHTTPContinuation(t, f.handler.principal.UserID, *page.After)
		want.Cursor = &cursor
	}
	result := workerservice.WorkerPage{ObservedAt: f.now, Items: []workerprotocol.WorkerSummary{}}
	items := summaries
	if len(items) > page.Limit {
		position := store.Position{CreatedAt: items[page.Limit-1].CreatedAt, ID: items[page.Limit-1].WorkerID}
		cursor := workerHTTPContinuation(t, f.handler.principal.UserID, position)
		result.NextCursor = &cursor
		items = items[:page.Limit]
	}
	for _, item := range items {
		result.Items = append(result.Items, workerprotocol.WorkerSummary{WorkerID: item.WorkerID, Machine: workerprotocol.WorkerMachine{ID: item.Machine.ID, Name: item.Machine.Name}, Platform: string(item.Platform), LastReportedAt: item.LastReportedAt, TaskObservationState: string(item.TaskObservationState), TaskObservedAt: workerHTTPValue[*time.Time](t, item.TaskObservedAt), ActiveTaskCount: workerHTTPValue[*int](t, item.ActiveTaskCount)})
	}
	calls := 0
	f.operations.list = func(ctx context.Context, principal model.Principal, actual model.PageRequest) (workerservice.WorkerPage, error) {
		f.require(t, ctx, principal)
		calls++
		if calls != 1 || !reflect.DeepEqual(actual, want) {
			workerHTTPFail(t, "List arguments: got=%+v want=%+v calls=%d", actual, want, calls)
		}
		return workerHTTPValue[workerservice.WorkerPage](t, result), nil
	}
	defer func() { f.operations.list = nil }()
	response := f.send(http.MethodGet, path, "")
	if calls != 1 {
		workerHTTPFail(t, "List calls=%d want1", calls)
	}
	got := decodeResponse[api.WorkerPage](t, response, http.StatusOK)
	expected := workerHTTPValue[api.WorkerPage](t, result)
	if !reflect.DeepEqual(got, expected) {
		workerHTTPFail(t, "Worker page=%+v want=%+v", got, expected)
	}
	return got
}

func (f *workerHTTPFixture) invalidCursor(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	calls := 0
	f.operations.list = func(ctx context.Context, principal model.Principal, page model.PageRequest) (workerservice.WorkerPage, error) {
		f.require(t, ctx, principal)
		calls++
		if calls != 1 || page.Limit != 50 || page.Cursor == nil || *page.Cursor != "bad" {
			workerHTTPFail(t, "invalid cursor arguments: %+v", page)
		}
		return workerservice.WorkerPage{}, &model.Fault{Code: "invalid_input", Message: "Cursor is invalid for this list."}
	}
	defer func() { f.operations.list = nil }()
	response := projectRequest(f.handler, http.MethodGet, path, "")
	if calls != 1 {
		workerHTTPFail(t, "invalid cursor List calls=%d", calls)
	}
	return response
}
