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
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

const projectAppGrant = "33333333-3333-4333-8333-333333333333"

type projectAppOps struct {
	t          *testing.T
	get        func(context.Context, model.Principal, string) (core.ProjectAppStatus, error)
	discover   func(context.Context, model.Principal, string, core.ProjectAppSelection) (core.InstallationCandidate, error)
	connect    func(context.Context, model.Principal, string, core.ProjectAppConnect) (core.ProjectAppStatus, error)
	disconnect func(context.Context, model.Principal, string, core.ProjectAppDisconnect) (core.ProjectAppStatus, error)
	settings   func(context.Context, model.Principal, string, int64, int32) (core.ProjectAppStatus, error)
	sync       func(context.Context, model.Principal, string, int64, bool) (core.ProjectAppStatus, error)
}

func (o projectAppOps) Get(ctx context.Context, p model.Principal, id string) (core.ProjectAppStatus, error) {
	if o.get == nil {
		o.t.Fatal("unexpected status")
	}
	return o.get(ctx, p, id)
}
func (o projectAppOps) Discover(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error) {
	if o.discover == nil {
		o.t.Fatal("unexpected discovery")
	}
	return o.discover(ctx, p, id, in)
}
func (o projectAppOps) Connect(ctx context.Context, p model.Principal, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error) {
	if o.connect == nil {
		o.t.Fatal("unexpected connect")
	}
	return o.connect(ctx, p, id, in)
}
func (o projectAppOps) Disconnect(ctx context.Context, p model.Principal, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
	if o.disconnect == nil {
		o.t.Fatal("unexpected disconnect")
	}
	return o.disconnect(ctx, p, id, in)
}
func (o projectAppOps) Settings(ctx context.Context, p model.Principal, id string, v int64, minutes int32) (core.ProjectAppStatus, error) {
	if o.settings == nil {
		o.t.Fatal("unexpected settings")
	}
	return o.settings(ctx, p, id, v, minutes)
}
func (o projectAppOps) Sync(ctx context.Context, p model.Principal, id string, v int64, enabled bool) (core.ProjectAppStatus, error) {
	if o.sync == nil {
		o.t.Fatal("unexpected sync")
	}
	return o.sync(ctx, p, id, v, enabled)
}
func projectAppMux(ops projectAppOps) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterProjectAppRoutes(mux, ops, authStub{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return mux
}
func projectAppFixture() core.ProjectAppStatus {
	return core.ProjectAppStatus{Status: core.Status{Connection: githubpr.DefaultConnection(projectID), ServiceAvailable: true}, CanManageConnection: true,
		App: &core.ProjectAppRef{ID: appID, GitHubAppID: 9007199254740993, Name: "Shared App", GitHubSlug: "shared-app"}, GrantID: pointer(projectAppGrant)}
}

func TestProjectAppHTTPInputsAndSafeStatus(t *testing.T) {
	calls := 0
	check := func(ctx context.Context, p model.Principal, id string, budget time.Duration) {
		t.Helper()
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > budget || p.UserID != userID || id != projectID {
			t.Fatalf("deadline=%v principal=%+v project=%s", deadline, p, id)
		}
	}
	selection := core.ProjectAppSelection{AppResourceID: appID, GrantID: projectAppGrant, AppVersion: 9007199254740993, OwnershipVersion: 8}
	ops := projectAppOps{t: t,
		get: func(ctx context.Context, p model.Principal, id string) (core.ProjectAppStatus, error) {
			check(ctx, p, id, core.OperationTimeout)
			return projectAppFixture(), nil
		},
		discover: func(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error) {
			check(ctx, p, id, appWriteBudget)
			if in != selection {
				t.Fatalf("selection=%+v", in)
			}
			return core.InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 99, AccountLogin: "owner"}, Repository: githubpr.RepositoryObservation{ID: 42, FullName: "owner/repo", Private: true}}, nil
		},
		connect: func(ctx context.Context, p model.Principal, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error) {
			check(ctx, p, id, appWriteBudget)
			if in.ProjectAppSelection != selection || in.Version != 4 || in.InstallationID != 99 {
				t.Fatalf("connect=%+v", in)
			}
			return projectAppFixture(), nil
		},
		disconnect: func(ctx context.Context, p model.Principal, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
			check(ctx, p, id, core.OperationTimeout)
			if in.Version != 5 || in.OwnershipVersion != 8 {
				t.Fatalf("disconnect=%+v", in)
			}
			return projectAppFixture(), nil
		},
		settings: func(ctx context.Context, p model.Principal, id string, version int64, minutes int32) (core.ProjectAppStatus, error) {
			check(ctx, p, id, core.OperationTimeout)
			if version != 6 || minutes != 3 {
				t.Fatalf("settings=%d %d", version, minutes)
			}
			return projectAppFixture(), nil
		},
		sync: func(ctx context.Context, p model.Principal, id string, version int64, enabled bool) (core.ProjectAppStatus, error) {
			check(ctx, p, id, core.OperationTimeout)
			if version != 7 || !enabled {
				t.Fatalf("sync=%d %v", version, enabled)
			}
			return projectAppFixture(), nil
		},
	}
	base := "/api/v1/projects/" + strings.ToUpper(projectID) + "/github"
	for _, tc := range []struct{ method, suffix, body, want string }{
		{"GET", "", "", `"app":{"id":"` + appID + `","githubAppId":"9007199254740993","name":"Shared App","githubSlug":"shared-app"}`},
		{"GET", "/installation?appResourceId=" + strings.ToUpper(appID) + "&appVersion=9007199254740993&grantId=" + projectAppGrant + "&ownershipVersion=8", "", `"private":true`},
		{"POST", "/connect", `{"version":"4","ownershipVersion":"8","appResourceId":"` + appID + `","appVersion":"9007199254740993","grantId":"` + projectAppGrant + `","installationId":"99"}`, `"canManageConnection":true`},
		{"POST", "/disconnect", `{"version":"5","ownershipVersion":"8"}`, `"grantId":"` + projectAppGrant + `"`},
		{"PATCH", "/settings", `{"version":"6","pollIntervalMinutes":3}`, `"serviceAvailable":true`},
		{"PATCH", "/sync", `{"version":"7","syncEnabled":true}`, `"syncEnabled":false`},
	} {
		w := managementCall(projectAppMux(ops), tc.method, base+tc.suffix, tc.body)
		if w.Code != 200 || !strings.Contains(w.Body.String(), tc.want) || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID {
			t.Fatalf("%s %s: %d %s", tc.method, tc.suffix, w.Code, w.Body)
		}
		for _, forbidden := range []string{"privateKey", "webhookUrl", "administrators", "authorizedTeams", "credentialVersion"} {
			if strings.Contains(w.Body.String(), forbidden) {
				t.Fatalf("unsafe field %s in %s", forbidden, w.Body)
			}
		}
	}
	if calls != 6 {
		t.Fatal(calls)
	}
}

func TestProjectAppHTTPRejectsInvalidConditions(t *testing.T) {
	mux := projectAppMux(projectAppOps{t: t})
	base := "/api/v1/projects/" + projectID + "/github"
	selection := `"ownershipVersion":"8","appResourceId":"` + appID + `","appVersion":"2","grantId":"` + projectAppGrant + `","installationId":"99"`
	for _, tc := range []struct{ method, suffix, body string }{
		{"GET", "?extra=1", ""},
		{"GET", "/installation", ""},
		{"GET", "/installation?appResourceId=x&appVersion=1&grantId=" + projectAppGrant + "&ownershipVersion=1", ""},
		{"GET", "/installation?appResourceId=" + appID + "&appVersion=01&grantId=" + projectAppGrant + "&ownershipVersion=1", ""},
		{"GET", "/installation?appResourceId=" + appID + "&appVersion=1&grantId=" + projectAppGrant + "&ownershipVersion=0", ""},
		{"GET", "/installation?appResourceId=" + appID + "&appVersion=1&grantId=bad&ownershipVersion=1", ""},
		{"GET", "/installation?appResourceId=" + appID + "&appVersion=1&ownershipVersion=1", ""},
		{"GET", "/installation?appResourceId=" + appID + "&appResourceId=" + appID, ""},
		{"GET", "/installation?bad=%", ""},
		{"POST", "/connect", `{"version":1,` + selection + `}`},
		{"POST", "/connect", `{"version":"1",` + strings.Replace(selection, `"99"`, `"0"`, 1) + `}`},
		{"POST", "/connect", `{"version":"1",` + selection + `,"appVersion":"3"}`},
		{"POST", "/connect?extra=1", `{"version":"1",` + selection + `}`},
		{"POST", "/connect", `{"version":"1","ownershipVersion":"8","appResourceId":null}`},
		{"POST", "/disconnect", `{"version":"1"}`},
		{"POST", "/disconnect", `{"version":null,"ownershipVersion":"1"}`},
		{"POST", "/disconnect", `{"version":"1","ownershipVersion":"0"}`},
		{"POST", "/disconnect", `{"version":"1","ownershipVersion":"1","extra":1}`},
		{"PATCH", "/settings", `{"version":"1","pollIntervalMinutes":1.5}`},
		{"PATCH", "/settings", `{"version":"1","pollIntervalMinutes":0}`},
		{"PATCH", "/settings", `{"version":null,"pollIntervalMinutes":1}`},
		{"PATCH", "/settings", `{"version":"1","pollIntervalMinutes":1,"other":true}`},
		{"PATCH", "/sync", `{"version":"1","syncEnabled":null}`},
		{"PATCH", "/sync", `{"version":"1","syncEnabled":"true"}`},
		{"PATCH", "/sync", `{"version":null,"syncEnabled":true}`},
		{"PATCH", "/sync", `{"version":"1","syncEnabled":true,"other":true}`},
	} {
		w := managementCall(mux, tc.method, base+tc.suffix, tc.body)
		if w.Code != 400 {
			t.Fatalf("%s %s %s: %d %s", tc.method, tc.suffix, tc.body, w.Code, w.Body)
		}
	}
	for _, suffix := range []string{"", "/installation", "/connect", "/disconnect", "/settings", "/sync"} {
		w := managementCall(mux, "DELETE", base+suffix, "")
		if w.Code != 405 || w.Header().Get("Allow") == "" {
			t.Fatalf("%s: %d %s", suffix, w.Code, w.Body)
		}
	}
	w := managementCall(mux, "GET", "/api/v1/projects/bad/github", "")
	if w.Code != 400 {
		t.Fatalf("bad project: %d %s", w.Code, w.Body)
	}
	w = managementCall(mux, "POST", base+"/connect", strings.Repeat(" ", appWriteBytes+1))
	if w.Code != 413 {
		t.Fatalf("oversized body: %d %s", w.Code, w.Body)
	}
}

func TestProjectAppHTTPPreservesOperationRefusals(t *testing.T) {
	failure := &model.Fault{Code: "forbidden", Message: "Owner Team administrator permission is required."}
	ops := projectAppOps{t: t,
		get: func(context.Context, model.Principal, string) (core.ProjectAppStatus, error) {
			return core.ProjectAppStatus{}, failure
		},
		discover: func(context.Context, model.Principal, string, core.ProjectAppSelection) (core.InstallationCandidate, error) {
			return core.InstallationCandidate{}, failure
		},
		connect: func(context.Context, model.Principal, string, core.ProjectAppConnect) (core.ProjectAppStatus, error) {
			return core.ProjectAppStatus{}, failure
		},
		settings: func(context.Context, model.Principal, string, int64, int32) (core.ProjectAppStatus, error) {
			return core.ProjectAppStatus{}, failure
		},
		sync: func(context.Context, model.Principal, string, int64, bool) (core.ProjectAppStatus, error) {
			return core.ProjectAppStatus{}, failure
		},
	}
	base := "/api/v1/projects/" + projectID + "/github"
	for _, tc := range []struct{ method, suffix, body string }{
		{"GET", "", ""},
		{"GET", "/installation?appResourceId=" + appID + "&appVersion=1&grantId=" + projectAppGrant + "&ownershipVersion=1", ""},
		{"POST", "/connect", `{"version":"1","ownershipVersion":"1","appResourceId":"` + appID + `","appVersion":"1","grantId":"` + projectAppGrant + `","installationId":"99"}`},
		{"PATCH", "/settings", `{"version":"1","pollIntervalMinutes":1}`},
		{"PATCH", "/sync", `{"version":"1","syncEnabled":true}`},
	} {
		w := managementCall(projectAppMux(ops), tc.method, base+tc.suffix, tc.body)
		if w.Code != 403 || !strings.Contains(w.Body.String(), `"forbidden"`) {
			t.Fatalf("%s: %d %s", tc.suffix, w.Code, w.Body)
		}
	}
}

func TestProjectAppHTTPFailureOutcomes(t *testing.T) {
	base := "/api/v1/projects/" + projectID + "/github/disconnect"
	for _, tc := range []struct {
		err    error
		status int
		want   string
	}{
		{&model.Fault{Code: "not_found", Message: "not found"}, 404, `"not_found"`},
		{&model.Fault{Code: "github_grant_changed", Message: "changed"}, 409, `"github_grant_changed"`},
		{&model.Fault{Code: "github_not_connected", Message: "not connected"}, 409, `"github_not_connected"`},
		{&model.Fault{Code: "github_connection_unavailable", Message: "unavailable"}, 409, `"github_connection_unavailable"`},
		{&service.ManagementError{Code: "github_connection_unavailable", Message: "unavailable"}, 409, `"github_connection_unavailable"`},
		{&service.ManagementError{Code: "github_unavailable", Message: "unavailable"}, 502, `"github_unavailable"`},
		{&service.ManagementError{Code: "github_rate_limited", Message: "limited"}, 502, `"github_rate_limited"`},
		{&service.ManagementError{Code: "github_write_outcome_unknown", Message: "unknown", Cause: errors.New("commit lost")}, 503, `"writeOutcome":"unknown"`},
	} {
		calls := 0
		ops := projectAppOps{t: t, disconnect: func(context.Context, model.Principal, string, core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
			calls++
			return core.ProjectAppStatus{}, tc.err
		}}
		w := managementCall(projectAppMux(ops), "POST", base, `{"version":"1","ownershipVersion":"1"}`)
		if calls != 1 || w.Code != tc.status || !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("error=%v calls=%d status=%d body=%s", tc.err, calls, w.Code, w.Body)
		}
	}
	bad := projectAppFixture()
	bad.Connection.RepositoryID = pointer(int64(99))
	for _, mutate := range []bool{false, true} {
		_, err := projectAppResponse(bad, mutate)
		var management *service.ManagementError
		if err == nil || errors.As(err, &management) != mutate || (mutate && management.Code != "github_write_outcome_unknown") {
			t.Fatalf("mutate=%v err=%v", mutate, err)
		}
	}
}

func TestProjectAppHTTPCancellationAndNullProjection(t *testing.T) {
	type key struct{}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), key{}, "marker"))
	defer cancel()
	calls := 0
	ops := projectAppOps{t: t, get: func(work context.Context, _ model.Principal, _ string) (core.ProjectAppStatus, error) {
		calls++
		if work.Value(key{}) != "marker" {
			t.Fatal("context marker lost")
		}
		cancel()
		if !errors.Is(work.Err(), context.Canceled) {
			t.Fatal("cancellation lost")
		}
		return core.ProjectAppStatus{}, work.Err()
	}}
	r := httptest.NewRequest("GET", "/api/v1/projects/"+projectID+"/github", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	projectAppMux(ops).ServeHTTP(w, r)
	if calls != 1 || w.Body.Len() != 0 {
		t.Fatalf("calls=%d body=%s", calls, w.Body)
	}
	ops.get = func(context.Context, model.Principal, string) (core.ProjectAppStatus, error) {
		return core.ProjectAppStatus{Status: core.Status{Connection: githubpr.DefaultConnection(projectID)}}, nil
	}
	srv := httptest.NewServer(projectAppMux(ops))
	defer srv.Close()
	response, err := srv.Client().Head(srv.URL + "/api/v1/projects/" + projectID + "/github")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || len(body) != 0 {
		t.Fatalf("HEAD: %d %s %v", response.StatusCode, body, err)
	}
	w = call(projectAppMux(ops), "GET", "/api/v1/projects/"+projectID+"/github")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"canManageConnection":false,"app":null,"grantId":null`) {
		t.Fatalf("null projection: %d %s", w.Code, w.Body)
	}
}

func managementCall(m *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	m.ServeHTTP(w, r)
	return w
}
