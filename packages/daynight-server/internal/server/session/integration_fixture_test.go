package session_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
)

type resourceTestHandler struct {
	http.Handler
	token          string
	principal      model.Principal
	backend        *routeBackend
	authentication *routeAuthentication
	application    sessionApplication
}

func newResourceTestHandler(t *testing.T, backend *routeBackend, auth *routeAuthentication, principal model.Principal, output io.Writer) *resourceTestHandler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	application := newRouteApplication(t, backend, auth, logger, 0)
	return &resourceTestHandler{Handler: httpx.RequestLogging(logger, application), token: auth.Credential(principal), principal: principal, backend: backend, authentication: auth, application: application}
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
func jsonBody(t *testing.T, input any) string { return testsupport.JSONBody(t, input) }

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if h, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+h.token)
	}
}

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	calls int
}

func (w *threadFailingWriter) Write(data []byte) (int, error) { w.calls++; return 0, io.ErrClosedPipe }
