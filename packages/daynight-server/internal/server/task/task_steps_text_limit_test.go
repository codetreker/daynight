package task_test

import (
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestStepsHTTPTextAdmission(t *testing.T) {
	_, handler, parent := stepsHTTPFixture(t, io.Discard)
	path := taskPath(parent) + "/steps"
	cases := []struct {
		name, field, valid, excess string
	}{
		{"title", "title", strings.Repeat("é", 512), strings.Repeat("é", 512) + "x"},
		{"description", "description", strings.Repeat("\x01", 65536), strings.Repeat("\x01", 65536) + "x"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := []string{"00000001", "00000002"}[i]
			before := projectRequest(handler, "GET", path, "")
			current := decodeResponse[api.StepsResource](t, before, 200)
			bad := map[string]any{"version": current.Version, "id": id, "title": "x", tc.field: tc.excess}
			assertProjectError(t, projectRequest(handler, "POST", path, jsonBody(t, bad)), 400, "invalid_input")
			if before.Body.String() != projectRequest(handler, "GET", path, "").Body.String() {
				t.Fatal("rejected add changed collection or version")
			}
			good := map[string]any{"version": current.Version, "id": id, "title": "x", tc.field: tc.valid}
			added := decodeResponse[api.StepsResource](t, projectRequest(handler, "POST", path, jsonBody(t, good)), 201)
			before = projectRequest(handler, "GET", path, "")
			assertProjectError(t, projectRequest(handler, "PATCH", path+"/"+id, jsonBody(t, map[string]any{"version": added.Version, tc.field: tc.excess})), 400, "invalid_input")
			after := projectRequest(handler, "GET", path, "")
			if before.Body.String() != after.Body.String() {
				t.Fatal("rejected update changed collection or version")
			}
			short := decodeResponse[api.StepsResource](t, projectRequest(handler, "PATCH", path+"/"+id, jsonBody(t, map[string]any{"version": added.Version, tc.field: "short"})), 200)
			updated := decodeResponse[api.StepsResource](t, projectRequest(handler, "PATCH", path+"/"+id, jsonBody(t, map[string]any{"version": short.Version, tc.field: tc.valid})), 200)
			if updated.Version != short.Version+1 {
				t.Fatal("valid boundary update did not advance version")
			}
			noop := decodeResponse[api.StepsResource](t, projectRequest(handler, "PATCH", path+"/"+id, jsonBody(t, map[string]any{"version": updated.Version, tc.field: tc.valid})), 200)
			if noop.Version != updated.Version {
				t.Fatal("valid no-op advanced version")
			}
		})
	}
}
