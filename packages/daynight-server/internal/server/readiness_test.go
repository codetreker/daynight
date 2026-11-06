package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadinessUsesResourceAndReportsFailure(t *testing.T) {
	mux := http.NewServeMux()
	var failure error
	calls := 0
	healthRoutes(mux, func(ctx context.Context) error {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("readiness has no deadline")
		}
		return failure
	}, testLogger())
	for _, status := range []int{http.StatusOK, http.StatusServiceUnavailable} {
		if status != http.StatusOK {
			failure = errors.New("private database failure")
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("readiness status=%d headers=%v", response.Code, response.Header())
		}
	}
	if calls != 2 {
		t.Fatalf("readiness called %d times", calls)
	}
}
