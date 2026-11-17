package worker

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func workerProtocolRequest(t *testing.T, f *capacityReportOperationFixture, method, suffix, body string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	f.authCalls = 0
	request := httptest.NewRequest(method, "/api/v1/me/workers/"+f.worker+suffix, strings.NewReader(body))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/json")
	for name, values := range headers {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}
