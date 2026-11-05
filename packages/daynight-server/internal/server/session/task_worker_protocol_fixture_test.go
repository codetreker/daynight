package session_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
)

// New worker-mode fixtures opt in without changing legacy request helpers.
func extendedWorkerTestHandler(handler *resourceTestHandler) {
	original := handler.Handler
	handler.Handler = http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		request.Header.Set("Daynight-Worker-Protocol", "2")
		original.ServeHTTP(w, request)
	})
}

func protocolRequest(handler http.Handler, method, path, body, protocol string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	if protocol != "" {
		request.Header.Set("Daynight-Worker-Protocol", protocol)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
