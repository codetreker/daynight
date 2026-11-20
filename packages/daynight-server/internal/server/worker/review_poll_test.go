package worker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const reviewPollSuffix = "/review-pull-requests"

func reviewPollRequest(t *testing.T, f *capacityReportOperationFixture, method, suffix string) *httptest.ResponseRecorder {
	t.Helper()
	headers := http.Header{}
	headers.Set("X-Request-ID", "project-test")
	return controlModeRequest(t, f, method, suffix, "", headers)
}

func TestWorkerReviewPollHTTP(t *testing.T) {
	const workerID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	cursor := "cursor-value"
	for _, tc := range []struct {
		name, method, query string
		page                model.PageRequest
	}{
		{"default", http.MethodGet, "", model.PageRequest{Limit: 20}},
		{"minimum", http.MethodGet, "?limit=1", model.PageRequest{Limit: 1}},
		{"maximum and cursor", http.MethodGet, "?limit=100&cursor=cursor-value", model.PageRequest{Limit: 100, Cursor: &cursor}},
		{"head", http.MethodHead, "", model.PageRequest{Limit: 20}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, workerID)
			calls := 0
			f.operations.reviewPullRequests = func(ctx context.Context, principal model.Principal, worker string, page model.PageRequest) (workerservice.ReviewPullRequestPage, error) {
				calls++
				if ctx != f.requestContext || principal != f.handler.principal || worker != workerID || !reflect.DeepEqual(page, tc.page) {
					t.Fatalf("operation arguments: worker=%s principal=%+v page=%+v", worker, principal, page)
				}
				return workerservice.ReviewPullRequestPage{ReviewEnabled: true, PullRequests: []workerservice.ReviewPullRequest{{ProjectID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", RepositoryID: "42", RepositoryURL: "https://github.com/example/repo", Number: "12"}}, NextCursor: &cursor}, nil
			}
			response := reviewPollRequest(t, f, tc.method, reviewPollSuffix+tc.query)
			want := "{\"reviewEnabled\":true,\"pullRequests\":[{\"projectId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"repositoryId\":\"42\",\"repositoryUrl\":\"https://github.com/example/repo\",\"number\":\"12\"}],\"nextCursor\":\"cursor-value\"}\n"
			if response.Code != http.StatusOK || response.Body.String() != want || calls != 1 || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
				t.Fatalf("response: status=%d body=%s headers=%v calls=%d", response.Code, response.Body, response.Header(), calls)
			}
		})
	}
}

func TestWorkerReviewPollHTTPRejectsWithoutOperations(t *testing.T) {
	for _, tc := range []struct {
		name, method, worker, query string
		status                      int
		code                        string
	}{
		{name: "zero", query: "?limit=0"},
		{name: "too large", query: "?limit=101"},
		{name: "noninteger", query: "?limit=1.5"},
		{name: "empty limit", query: "?limit="},
		{name: "empty cursor", query: "?cursor="},
		{name: "duplicate limit", query: "?limit=1&limit=2"},
		{name: "duplicate cursor", query: "?cursor=a&cursor=b"},
		{name: "unknown", query: "?owner=x"},
		{name: "bad escape", query: "?cursor=%zz"},
		{name: "worker", worker: "not-a-uuid"},
		{name: "wrong method", method: http.MethodPost, status: http.StatusMethodNotAllowed, code: "method_not_allowed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.worker == "" {
				tc.worker = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
			}
			if tc.method == "" {
				tc.method = http.MethodGet
			}
			if tc.status == 0 {
				tc.status, tc.code = http.StatusBadRequest, "invalid_input"
			}
			f := newCapacityReportOperationFixture(t, tc.worker)
			response := reviewPollRequest(t, f, tc.method, reviewPollSuffix+tc.query)
			assertProjectError(t, response, tc.status, tc.code)
			if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
				t.Fatalf("headers: %v", response.Header())
			}
		})
	}
}

func TestWorkerReviewPollHTTPAuthentication(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	r := httptest.NewRequest(http.MethodGet, "/api/v1/me/workers/"+f.worker+reviewPollSuffix, nil)
	r.Header.Set("X-Request-ID", "project-test")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	assertProjectError(t, w, http.StatusUnauthorized, "unauthenticated")
}

func TestWorkerReviewPollHTTPFailure(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		status     int
		err        error
	}{
		{"missing Worker", "not_found", http.StatusNotFound, &model.Fault{Code: "not_found", Message: "Worker was not found."}},
		{"invalid cursor", "invalid_input", http.StatusBadRequest, &model.Fault{Code: "invalid_input", Message: "Cursor is invalid."}},
		{"database", "internal_error", http.StatusInternalServerError, errors.New("database failure")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			calls := 0
			f.operations.reviewPullRequests = func(context.Context, model.Principal, string, model.PageRequest) (workerservice.ReviewPullRequestPage, error) {
				calls++
				return workerservice.ReviewPullRequestPage{}, tc.err
			}
			response := reviewPollRequest(t, f, http.MethodGet, reviewPollSuffix)
			assertProjectError(t, response, tc.status, tc.code)
			if calls != 1 || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID || strings.Contains(response.Body.String(), "database failure") {
				t.Fatalf("failure response: %s headers=%v calls=%d", response.Body, response.Header(), calls)
			}
		})
	}
}

func TestWorkerReviewPollHTTPCancellation(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	f.operations.reviewPullRequests = func(actual context.Context, _ model.Principal, _ string, _ model.PageRequest) (workerservice.ReviewPullRequestPage, error) {
		calls++
		if actual != f.requestContext || !errors.Is(actual.Err(), context.Canceled) {
			t.Fatalf("operation context: %v", actual.Err())
		}
		return workerservice.ReviewPullRequestPage{}, actual.Err()
	}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/me/workers/"+f.worker+reviewPollSuffix, nil).WithContext(ctx)
	authorizeResourceRequest(f.handler, r)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if calls != 1 || w.Body.Len() != 0 {
		t.Fatalf("cancelled read: %d calls=%d", w.Code, calls)
	}
}
