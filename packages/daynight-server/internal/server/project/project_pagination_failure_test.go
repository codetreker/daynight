package project

import (
	"context"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestProjectHTTPContinuationRecoversAfterTableFailure(t *testing.T) {
	h := projectRoutesHarness(t)
	for _, name := range []string{"Second", "Third"} {
		body := jsonBody(t, api.CreateProjectRequest{Name: name, RepoURL: "https://example.com/" + name, ExpectedUserID: h.adminID})
		decodeResponse[api.ProjectDocument](t, h.call(http.MethodPost, "/api/v1/projects", body, h.admin), http.StatusCreated)
	}
	first := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?limit=1", "", h.admin), http.StatusOK)
	if len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("first page: %+v", first)
	}
	continuation := "/api/v1/projects?limit=1&cursor=" + url.QueryEscape(*first.NextCursor)
	baseline := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, continuation, "", h.admin), http.StatusOK)
	if len(baseline.Items) != 1 || baseline.Items[0].ID == first.Items[0].ID {
		t.Fatalf("continuation baseline: %+v", baseline)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := h.Database.Pool.Exec(ctx, `ALTER TABLE projects RENAME TO private_missing_projects`); err != nil {
		t.Fatal(err)
	}
	renamed := true
	t.Cleanup(func() {
		if renamed {
			cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if _, err := h.Database.Pool.Exec(cleanup, `ALTER TABLE private_missing_projects RENAME TO projects`); err != nil {
				t.Error(err)
			}
		}
	})
	response := h.call(http.MethodGet, continuation, "", h.admin)
	failure := decodeResponse[api.ErrorResponse](t, response, http.StatusInternalServerError)
	if failure.Error.Code != "internal_error" || failure.Error.RequestID == "" || failure.Error.RequestID != response.Header().Get("X-Request-ID") || strings.Contains(response.Body.String(), "private_missing_projects") || strings.Contains(response.Body.String(), "projects") {
		t.Fatalf("unsafe or uncorrelated continuation failure: %s", response.Body)
	}
	if _, err := h.Database.Pool.Exec(ctx, `ALTER TABLE private_missing_projects RENAME TO projects`); err != nil {
		t.Fatal(err)
	}
	renamed = false
	recovered := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, continuation, "", h.admin), http.StatusOK)
	if !reflect.DeepEqual(recovered, baseline) {
		t.Fatalf("same cursor returned different page after recovery: %+v", recovered)
	}
}
