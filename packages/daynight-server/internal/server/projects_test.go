package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
)

func projectTestHandler(t *testing.T, database store.Transactions, output io.Writer) *resourceTestHandler {
	t.Helper()
	return resourceTestServer(t, database, attachmentTestFiles(t), output)
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

func TestRootUnknownPathUsesApplicationFallback(t *testing.T) {
	database := newHTTPTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/unknown-secret-path?query=secret", ""), http.StatusNotFound, "not_found")
}

func TestPublicHealthAndReadinessUseConfiguredProbe(t *testing.T) {
	database := newHTTPTestStore(t)
	ready := true
	readyCalls := 0
	application, err := newTestHandler(Dependencies{Store: database, Files: attachmentTestFiles(t), Ready: func(ctx context.Context) error {
		readyCalls++
		if !ready {
			return &store.Error{Phase: "ping", DatabaseFailure: true, Cause: errors.New("private-health-project database unavailable")}
		}
		return nil
	}}, configuredTestConfig(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := application.(*sessionApplication).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	handler := &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), application), token: defaultHTTPToken(), principal: defaultHTTPPrincipal()}
	request := func(method, path string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}
	assertProjectError(t, request(http.MethodGet, "/api/v1/projects"), http.StatusUnauthorized, "unauthenticated")
	for path, status := range map[string]string{"/healthz": "ok", "/readyz": "ready"} {
		response := request(http.MethodGet, path)
		value := decodeResponse[map[string]string](t, response, http.StatusOK)
		if len(value) != 1 || value["status"] != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("health response exposed data or cached state: %s %+v", response.Body, response.Header())
		}
		unsupported := request(http.MethodPost, path)
		assertProjectError(t, unsupported, http.StatusMethodNotAllowed, "method_not_allowed")
		if unsupported.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("health method boundary: %+v", unsupported.Header())
		}
	}
	ready = false
	response := request(http.MethodGet, "/readyz")
	assertProjectError(t, response, http.StatusServiceUnavailable, "service_unavailable")
	if strings.Contains(response.Body.String(), "private-health-project") || strings.Contains(response.Body.String(), "database") || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("readiness failure exposed data or cached state: %s %+v", response.Body, response.Header())
	}
	decodeResponse[map[string]string](t, request(http.MethodGet, "/healthz"), http.StatusOK)
	if readyCalls != 2 {
		t.Fatalf("readiness callback calls: %d", readyCalls)
	}
}
