package cors

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProjectGoalDependencyConfirmationPreflight(t *testing.T) {
	mux := http.NewServeMux()
	calls := 0
	mux.HandleFunc("POST /api/v1/projects/{projectId}/transfer", func(http.ResponseWriter, *http.Request) { calls++ })
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}", func(http.ResponseWriter, *http.Request) { calls++ })
	handler := Wrap(mux, mux, "https://client.example", slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, tc := range []struct{ method, path string }{
		{"POST", "/api/v1/projects/project/transfer"},
		{"DELETE", "/api/v1/projects/project"},
	} {
		request := httptest.NewRequest("OPTIONS", tc.path, nil)
		request.Header.Set("Origin", "https://client.example")
		request.Header.Set("Access-Control-Request-Method", tc.method)
		request.Header.Set("Access-Control-Request-Headers", "Content-Type, daynight-confirm-goal-dependency-removal")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent || calls != 0 || !strings.Contains(response.Header().Get("Access-Control-Allow-Headers"), "Daynight-Confirm-Goal-Dependency-Removal") {
			t.Fatalf("preflight status=%d calls=%d headers=%v body=%s", response.Code, calls, response.Header(), response.Body)
		}
	}
}
