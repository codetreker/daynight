package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRESTStepsRetirementUsesFallbackWithoutBusinessAccess(t *testing.T) {
	root, database, identity := rootCORSFixture(t, browserAPIOrigin, defaultHTTPPrincipal())
	database.ReadSnapshotCall = func(context.Context, func(store.SnapshotScope) error) error {
		t.Fatal("retired route accessed a business snapshot")
		return nil
	}
	database.WriteProjectCall = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
		t.Fatal("retired route entered a business write")
		return store.Completion{}, nil
	}
	const parent = "/api/v1/projects/c3333333-3333-4333-8333-333333333333/tasks/d4444444-4444-4444-8444-444444444444"
	for _, suffix := range []string{"/steps", "/steps/abcdef01", "/steps/abcdef01/status", "/steps/abcdef01/position"} {
		for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodPut} {
			t.Run(method+suffix, func(t *testing.T) {
				for _, token := range []string{"", defaultHTTPToken()} {
					headers := http.Header{"Origin": {browserAPIOrigin}, "Accept": {"text/html"}, "X-Request-Id": {"retired-steps"}}
					if token != "" {
						headers.Set("Authorization", "Bearer "+token)
					}
					response := corsHTTP(t, root, method, parent+suffix, headers)
					if response.Code != http.StatusNotFound || response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Cache-Control") != "no-store" {
						t.Fatalf("retired path escaped JSON fallback: status=%d headers=%v body=%s", response.Code, response.Header(), response.Body)
					}
				}
				preflight := corsHTTP(t, root, http.MethodOptions, parent+suffix, http.Header{
					"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {method}, "Access-Control-Request-Headers": {"Authorization, Content-Type"},
				})
				if preflight.Code != http.StatusForbidden || preflight.Header().Get("Access-Control-Allow-Methods") != "" {
					t.Fatalf("retired path accepted browser preflight: %d %v", preflight.Code, preflight.Header())
				}
			})
		}
	}
	if identity.calls != 0 {
		t.Fatalf("retired paths reached authentication %d times", identity.calls)
	}
}
