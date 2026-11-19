package worker

import (
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestWorkerReviewSettingsHTTP(t *testing.T) {
	const workerID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	const path = "/api/v1/me/workers/" + workerID + "/review-settings"
	f := newWorkerRouteFixture(t)
	for _, tc := range []struct {
		method, body, name, response string
		args                         []any
		enabled                      bool
	}{
		{http.MethodGet, "", "ReviewEnabled", "{\"enabled\":false}\n", []any{workerID}, false},
		{http.MethodPut, `{"enabled":true}`, "SetReviewEnabled", "{\"enabled\":true}\n", []any{workerID, true}, true},
		{http.MethodPut, `{"enabled":false}`, "SetReviewEnabled", "{\"enabled\":false}\n", []any{workerID, false}, false},
	} {
		got := f.request(tc.method, path, tc.body, &workerRouteCall{name: tc.name, args: tc.args, result: tc.enabled})
		if got.Code != http.StatusOK || got.Body.String() != tc.response {
			t.Fatalf("%s review settings: status=%d body=%s", tc.method, got.Code, got.Body)
		}
	}
	missing := &model.Fault{Code: "not_found", Message: "Worker was not found."}
	assertProjectError(t, f.request(http.MethodGet, path, "", &workerRouteCall{name: "ReviewEnabled", args: []any{workerID}, err: missing}), http.StatusNotFound, "not_found")
	assertProjectError(t, f.request(http.MethodPut, path, `{"enabled":true}`, &workerRouteCall{name: "SetReviewEnabled", args: []any{workerID, true}, err: missing}), http.StatusNotFound, "not_found")
}

func TestWorkerReviewSettingsHTTPRejectsInvalidRequests(t *testing.T) {
	const path = "/api/v1/me/workers/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/review-settings"
	f := newWorkerRouteFixture(t)
	for _, body := range []string{
		`{}`,
		`{"enabled":null}`,
		`{"enabled":"false"}`,
		`{"enabled":1}`,
		`{"enabled":true,"enabled":false}`,
		`{"enabled":true,"userId":"someone-else"}`,
	} {
		assertProjectError(t, f.request(http.MethodPut, path, body, nil), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, f.request(http.MethodGet, path+"?project=x", "", nil), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, f.request(http.MethodGet, path+"?", "", nil), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, f.request(http.MethodPost, path, "", nil), http.StatusMethodNotAllowed, "method_not_allowed")
}
