package github

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type managementStub struct {
	calls                 int
	version, installation int64
	minutes               int32
	enabled               bool
	ctx                   context.Context
	principal             model.Principal
	project               string
	err                   error
	status                *core.Status
}

func (s *managementStub) Sync(ctx context.Context, p model.Principal, id string, v int64, enabled bool) (core.Status, error) {
	s.calls++
	s.version, s.enabled = v, enabled
	s.ctx, s.principal, s.project = ctx, p, id
	if s.status != nil {
		return *s.status, s.err
	}
	return core.Status{Connection: githubpr.DefaultConnection(projectID)}, s.err
}

func TestSyncHTTPContextAndErrors(t *testing.T) {
	s := &managementStub{}
	m := managementMux(s)
	path := "/api/v1/projects/" + projectID + "/github/sync"
	type contextKey struct{}
	ctx := context.WithValue(context.Background(), contextKey{}, "marker")
	r := httptest.NewRequest("PATCH", path, strings.NewReader(`{"version":"1","syncEnabled":false}`)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if w.Code != 200 || s.ctx.Value(contextKey{}) != "marker" || s.principal.UserID != userID || s.project != projectID || s.calls != 1 || s.enabled || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID {
		t.Fatalf("sync request: %d %s, stub %+v", w.Code, w.Body, s)
	}
	for _, code := range []string{"github_not_configured", "github_not_connected", "github_connection_unavailable", "github_write_outcome_unknown"} {
		s.err = &service.ManagementError{Code: code, Message: code}
		before := s.calls
		w = managementCall(m, "PATCH", path, `{"version":"1","syncEnabled":true}`)
		want := 409
		if code == "github_write_outcome_unknown" {
			want = 503
		}
		if w.Code != want || s.calls != before+1 || !strings.Contains(w.Body.String(), `"code":"`+code+`"`) {
			t.Errorf("%s: %d %s", code, w.Code, w.Body)
		}
	}
}

func (s *managementStub) Discover(context.Context, model.Principal, string) (core.InstallationCandidate, error) {
	s.calls++
	return core.InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 99, AccountLogin: "provider"}, Repository: githubpr.RepositoryObservation{ID: 42, FullName: "o/r", Private: true}}, s.err
}
func (s *managementStub) Connect(_ context.Context, _ model.Principal, _ string, v, i int64) (core.Status, error) {
	s.calls++
	s.version = v
	s.installation = i
	if s.status != nil {
		return *s.status, s.err
	}
	return core.Status{Connection: githubpr.DefaultConnection(projectID)}, s.err
}
func (s *managementStub) Disconnect(_ context.Context, _ model.Principal, _ string, v int64) (core.Status, error) {
	s.calls++
	s.version = v
	if s.status != nil {
		return *s.status, s.err
	}
	return core.Status{Connection: githubpr.DefaultConnection(projectID)}, s.err
}
func (s *managementStub) Settings(_ context.Context, _ model.Principal, _ string, v int64, n int32) (core.Status, error) {
	s.calls++
	s.version = v
	s.minutes = n
	if s.status != nil {
		return *s.status, s.err
	}
	return core.Status{Connection: githubpr.DefaultConnection(projectID)}, s.err
}
func managementMux(s *managementStub) *http.ServeMux {
	m := http.NewServeMux()
	RegisterManagementRoutes(m, s, authStub{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return m
}
func managementCall(m *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	m.ServeHTTP(w, r)
	return w
}
func TestManagementHTTPContract(t *testing.T) {
	s := &managementStub{}
	m := managementMux(s)
	base := "/api/v1/projects/" + projectID + "/github/"
	w := managementCall(m, "GET", base+"installation", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"id":"99"`) || !strings.Contains(w.Body.String(), `"private":true`) {
		t.Fatalf("discovery %d %s", w.Code, w.Body)
	}
	w = managementCall(m, "POST", base+"connect", `{"version":"9007199254740993","installationId":"99"}`)
	if w.Code != 200 || s.version != 9007199254740993 || s.installation != 99 {
		t.Fatalf("connect %d %s", w.Code, w.Body)
	}
	w = managementCall(m, "PATCH", base+"settings", `{"version":"2","pollIntervalMinutes":3}`)
	if w.Code != 200 || s.minutes != 3 {
		t.Fatalf("settings %d %s", w.Code, w.Body)
	}
	w = managementCall(m, "PATCH", base+"sync", `{"version":"3","syncEnabled":true}`)
	if w.Code != 200 || s.version != 3 || !s.enabled || !strings.Contains(w.Body.String(), `"syncEnabled":false`) {
		t.Fatalf("sync %d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{"version":"2"}`, `{"version":"2","syncEnabled":null}`, `{"version":"2","syncEnabled":"true"}`, `{"version":"2","syncEnabled":1}`, `{"version":"2","syncEnabled":true,"extra":1}`} {
		before := s.calls
		w = managementCall(m, "PATCH", base+"sync", body)
		if w.Code != 400 || s.calls != before {
			t.Errorf("%s: %d %s", body, w.Code, w.Body)
		}
	}
	for _, tc := range []struct{ path, body string }{{"connect", `{"version":1,"installationId":"2"}`}, {"connect", `{"version":"01","installationId":"2"}`}, {"connect", `{"version":"1","installationId":"0"}`}, {"connect?x=1", `{"version":"1","installationId":"2"}`}, {"disconnect", `{"version":"1","extra":true}`}, {"disconnect", `{"version":"1","version":"2"}`}} {
		before := s.calls
		w = managementCall(m, "POST", base+tc.path, tc.body)
		if w.Code != 400 || s.calls != before {
			t.Errorf("%s %s: %d %s", tc.path, tc.body, w.Code, w.Body)
		}
	}
	for _, body := range []string{`{"version":"2","pollIntervalMinutes":0}`, `{"version":"2","pollIntervalMinutes":1.5}`, `{"version":"2","pollIntervalMinutes":2147483648}`} {
		before := s.calls
		w = managementCall(m, "PATCH", base+"settings", body)
		if w.Code != 400 || s.calls != before {
			t.Errorf("%s: %d %s", body, w.Code, w.Body)
		}
	}
}
func TestManagementUnknownOutcome(t *testing.T) {
	s := &managementStub{err: &service.ManagementError{Code: "github_write_outcome_unknown", Message: "unknown", Cause: errors.New("private cause")}}
	m := managementMux(s)
	w := managementCall(m, "POST", "/api/v1/projects/"+projectID+"/github/disconnect", `{"version":"1"}`)
	if w.Code != 503 || !strings.Contains(w.Body.String(), `"writeOutcome":"unknown"`) || strings.Contains(w.Body.String(), "private cause") {
		t.Fatalf("unknown %d %s", w.Code, w.Body)
	}
}

func TestCommittedManagementInvalidResponseIsUnknown(t *testing.T) {
	installation := int64(99)
	c := githubpr.DefaultConnection(projectID)
	c.InstallationID = &installation
	status := core.Status{Connection: c}
	s := &managementStub{status: &status}
	m := managementMux(s)
	w := managementCall(m, "POST", "/api/v1/projects/"+projectID+"/github/disconnect", `{"version":"1"}`)
	if w.Code != 503 || !strings.Contains(w.Body.String(), `"writeOutcome":"unknown"`) {
		t.Fatalf("response %d %s", w.Code, w.Body)
	}
}
