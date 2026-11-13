package github

import (
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestSettingsHTTPRejectsAndPropagatesFailure(t *testing.T) {
	s := &managementStub{}
	m := managementMux(s)
	path := "/api/v1/projects/" + projectID + "/github/settings"
	for _, body := range []string{`{`, `{"version":false,"pollIntervalMinutes":2}`} {
		w := managementCall(m, "PATCH", path, body)
		if w.Code != http.StatusBadRequest || s.calls != 0 {
			t.Fatalf("invalid body: %d %s", w.Code, w.Body)
		}
	}
	s.err = &model.Fault{Code: "forbidden", Message: "Project administrator access is required."}
	w := managementCall(m, "PATCH", path, `{"version":"1","pollIntervalMinutes":2}`)
	if w.Code != http.StatusForbidden || s.calls != 1 {
		t.Fatalf("refusal: %d %s", w.Code, w.Body)
	}
}
