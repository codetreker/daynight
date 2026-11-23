package attachment

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestPreviewRegistrationRetainsAuthenticationAndMethodFence(t *testing.T) {
	for _, tc := range []struct {
		method        string
		authenticated bool
		status        int
		allow         string
	}{
		{http.MethodGet, false, http.StatusUnauthorized, ""},
		{http.MethodHead, false, http.StatusUnauthorized, ""},
		{"TRACE", false, http.StatusUnauthorized, ""},
		{"TRACE", true, http.StatusMethodNotAllowed, "GET, HEAD"},
		{http.MethodPut, true, http.StatusMethodNotAllowed, "GET, HEAD"},
	} {
		t.Run(tc.method+http.StatusText(tc.status), func(t *testing.T) {
			mux := http.NewServeMux()
			authenticated := 0
			require := func(next httpx.AuthenticatedHandler) http.HandlerFunc {
				return func(w http.ResponseWriter, r *http.Request) {
					authenticated++
					if !tc.authenticated {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					next(w, r, model.Principal{})
				}
			}
			RegisterPreviewRoutes(mux, nil, require, slog.New(slog.NewTextHandler(io.Discard, nil)))
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(tc.method, "/api/v1/projects/p/tasks/t/preview/file.txt", nil))
			if authenticated != 1 || w.Code != tc.status || w.Header().Get("Allow") != tc.allow {
				t.Fatalf("preview admission calls=%d status=%d Allow=%q", authenticated, w.Code, w.Header().Get("Allow"))
			}
		})
	}
}
