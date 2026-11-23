package worker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const reviewParticipationSuffix = "/review-participation"

func reviewParticipationRequest(t *testing.T, f *capacityReportOperationFixture, method, suffix, body string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	if headers == nil {
		headers = http.Header{}
	}
	headers.Set("X-Request-ID", "project-test")
	return controlModeRequest(t, f, method, suffix, body, headers)
}

func TestWorkerReviewParticipationHTTPResource(t *testing.T) {
	const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	f := newCapacityReportOperationFixture(t, id)
	calls := 0
	f.operations.putReviewParticipation = func(ctx context.Context, principal model.Principal, worker, version string, enabled bool) (model.WorkerReviewParticipation, error) {
		calls++
		if ctx != f.requestContext || principal != f.handler.principal || worker != id || version != "9223372036854775806" || !enabled {
			t.Fatalf("PUT arguments: %s %s %v", worker, version, enabled)
		}
		return model.WorkerReviewParticipation{Enabled: true, Version: 9223372036854775807}, nil
	}
	response := reviewParticipationRequest(t, f, http.MethodPut, reviewParticipationSuffix, `{"enabled":true,"expectedVersion":"9223372036854775806"}`, nil)
	if response.Code != http.StatusOK || response.Body.String() != "{\"enabled\":true,\"version\":\"9223372036854775807\"}\n" || calls != 1 {
		t.Fatalf("PUT: %d %s calls=%d", response.Code, response.Body, calls)
	}
	f.operations.reviewParticipation = func(ctx context.Context, principal model.Principal, worker string) (model.WorkerReviewParticipation, error) {
		calls++
		if ctx != f.requestContext || principal != f.handler.principal || worker != id {
			t.Fatal("GET arguments changed")
		}
		return model.WorkerReviewParticipation{Version: 1}, nil
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response = reviewParticipationRequest(t, f, method, reviewParticipationSuffix, "", nil)
		want := "{\"enabled\":false,\"version\":\"1\"}\n"
		if response.Code != http.StatusOK || response.Body.String() != want || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID || response.Header().Get(workerAliasHeader) != "" {
			t.Fatalf("%s: %d %s %v", method, response.Code, response.Body, response.Header())
		}
	}
	if calls != 3 {
		t.Fatalf("operations=%d", calls)
	}
	// This management resource uses no Worker report or extension negotiation.
	f.authCalls = 0
	r := httptest.NewRequest(http.MethodGet, "/api/v1/me/workers/"+id+reviewParticipationSuffix, nil)
	authorizeResourceRequest(f.handler, r)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK || calls != 4 {
		t.Fatalf("read without extensions: %d %s calls=%d", w.Code, w.Body, calls)
	}
}

func TestWorkerReviewParticipationHTTPRejectsWithoutOperations(t *testing.T) {
	for _, tc := range []struct {
		name, method, suffix, body string
		status                     int
		code                       string
	}{
		{name: "unknown", body: `{"enabled":true,"expectedVersion":"1","userId":"owner"}`},
		{name: "duplicate enabled", body: `{"enabled":false,"enabled":true,"expectedVersion":"1"}`},
		{name: "duplicate version", body: `{"enabled":true,"expectedVersion":"1","expectedVersion":"2"}`},
		{name: "missing enabled", body: `{"expectedVersion":"1"}`},
		{name: "missing version", body: `{"enabled":true}`},
		{name: "null enabled", body: `{"enabled":null,"expectedVersion":"1"}`},
		{name: "string enabled", body: `{"enabled":"true","expectedVersion":"1"}`},
		{name: "number enabled", body: `{"enabled":1,"expectedVersion":"1"}`},
		{name: "null version", body: `{"enabled":true,"expectedVersion":null}`},
		{name: "numeric version", body: `{"enabled":true,"expectedVersion":1}`},
		{name: "array", body: `[]`},
		{name: "trailing object", body: `{"enabled":true,"expectedVersion":"1"}{}`},
		{name: "invalid JSON", body: `{"enabled":true`},
		{name: "query", method: http.MethodGet, suffix: "?owner=x"},
		{name: "empty query", method: http.MethodGet, suffix: "?"},
		{name: "wrong method", method: http.MethodPost, status: http.StatusMethodNotAllowed, code: "method_not_allowed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			method := tc.method
			if method == "" {
				method = http.MethodPut
			}
			response := reviewParticipationRequest(t, f, method, reviewParticipationSuffix+tc.suffix, tc.body, nil)
			status, code := tc.status, tc.code
			if status == 0 {
				status, code = http.StatusBadRequest, "invalid_input"
			}
			assertProjectError(t, response, status, code)
		})
	}
	f := newCapacityReportOperationFixture(t, "invalid-worker-id")
	assertProjectError(t, reviewParticipationRequest(t, f, http.MethodGet, reviewParticipationSuffix, "", nil), http.StatusBadRequest, "invalid_input")
}

func TestWorkerReviewParticipationHTTPAuthentication(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		r := httptest.NewRequest(method, "/api/v1/me/workers/"+f.worker+reviewParticipationSuffix, strings.NewReader(`{"enabled":true,"expectedVersion":"1"}`))
		r.Header.Set("X-Request-ID", "project-test")
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, r)
		assertProjectError(t, w, http.StatusUnauthorized, "unauthenticated")
	}
}

func TestWorkerReviewParticipationHTTPDomainErrors(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		for _, tc := range []struct {
			code   string
			status int
		}{
			{"not_found", http.StatusNotFound}, {"version_conflict", http.StatusConflict},
			{"invalid_input", http.StatusBadRequest}, {"write_outcome_unknown", http.StatusServiceUnavailable},
		} {
			t.Run(method+"/"+tc.code, func(t *testing.T) {
				f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
				calls := 0
				refusal := &model.Fault{Code: tc.code, Message: "Operation refused."}
				f.operations.reviewParticipation = func(context.Context, model.Principal, string) (model.WorkerReviewParticipation, error) {
					calls++
					return model.WorkerReviewParticipation{}, refusal
				}
				f.operations.putReviewParticipation = func(context.Context, model.Principal, string, string, bool) (model.WorkerReviewParticipation, error) {
					calls++
					return model.WorkerReviewParticipation{}, refusal
				}
				response := reviewParticipationRequest(t, f, method, reviewParticipationSuffix, `{"enabled":false,"expectedVersion":"1"}`, nil)
				assertProjectError(t, response, tc.status, tc.code)
				if calls != 1 {
					t.Fatalf("operations=%d", calls)
				}
			})
		}
	}
}

func TestWorkerReviewParticipationHTTPCancellation(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	f.operations.reviewParticipation = func(actual context.Context, _ model.Principal, _ string) (model.WorkerReviewParticipation, error) {
		calls++
		if actual != f.requestContext || !errors.Is(actual.Err(), context.Canceled) {
			t.Fatalf("operation context: %v", actual.Err())
		}
		return model.WorkerReviewParticipation{}, actual.Err()
	}
	f.authCalls = 0
	r := httptest.NewRequest(http.MethodGet, "/api/v1/me/workers/"+f.worker+reviewParticipationSuffix, nil).WithContext(ctx)
	authorizeResourceRequest(f.handler, r)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if calls != 1 || w.Body.Len() != 0 {
		t.Fatalf("cancelled read: %d calls=%d", w.Code, calls)
	}
}
