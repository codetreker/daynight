package server

import (
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func propertyResource(t *testing.T, handler http.Handler, method, path string, body any) api.PropertyResource {
	t.Helper()
	input := ""
	if body != nil {
		input = jsonBody(t, body)
	}
	response := projectRequest(handler, method, path, input)
	result := decodeResponse[api.PropertyResource](t, response, http.StatusOK)
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") == "" {
		t.Fatalf("property response lost authentication/cache headers: %+v", response.Header())
	}
	return result
}
