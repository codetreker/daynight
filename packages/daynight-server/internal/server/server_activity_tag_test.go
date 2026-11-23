package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProductionTagResolveRefusalsDoNotRenewBrowserSessions(t *testing.T) {
	database, plan := newIdentityHTTPPlan(t)
	server := resourceScopeServer(t, database, attachmentTestFiles(t), io.Discard)
	browser := identityBrowser(t)
	user := identityHTTPUser("alice")
	token := httpTestToken(model.SessionCredential)
	resourceScopeCookie(t, browser, server.URL, token)
	headers := map[string]string{"Origin": server.URL, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}
	base := "/api/v1/projects/10000000-0000-4000-8000-000000000001/tags"
	for _, route := range []struct{ method, path, allow string }{
		{"GET", base + "/resolve", "POST"}, {"HEAD", base + "/resolve", "POST"}, {"PATCH", base + "/resolve", "POST"}, {"DELETE", base + "/resolve", "POST"}, {"PUT", base + "/resolve", "POST"},
		{"GET", base + "/colors/resolve", "POST"}, {"HEAD", base + "/colors/resolve", "POST"}, {"PATCH", base + "/colors/resolve", "POST"},
		{"PATCH", base, "GET, HEAD, POST"}, {"POST", base + "/10000000-0000-4000-8000-000000000002", "GET, HEAD, PATCH, DELETE"},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			plan.authenticate(user, model.SessionCredential, token, true)
			response, _ := identityRequest(t, browser, route.method, server.URL+route.path, "", headers, http.StatusMethodNotAllowed)
			if response.Header.Get("Allow") != route.allow || response.Header.Get("Daynight-User-ID") != user.ID || len(response.Cookies()) != 0 {
				t.Fatal("tag method refusal changed authentication or response contract")
			}
		})
	}
	pat := httpTestToken(model.PATCredential)
	plan.authenticate(user, model.PATCredential, pat, true)
	identityRequest(t, identityBrowser(t), http.MethodGet, server.URL+base+"/resolve", "", map[string]string{"Authorization": "Bearer " + pat}, http.StatusMethodNotAllowed)
	identityRequest(t, identityBrowser(t), http.MethodGet, server.URL+base+"/resolve", "", headers, http.StatusUnauthorized)
	plan.authenticate(user, model.SessionCredential, token, true)
	identityRequest(t, browser, http.MethodPatch, server.URL+base+"/resolve", "", map[string]string{"Origin": "https://other.test"}, http.StatusForbidden)

	plan.activity(user, token)
	project := projectHTTPRecord("10000000-0000-4000-8000-000000000001", "Tags", "https://example.test/tags", user.PersonalTeam.ID)
	snapshot := &activityTagSnapshot{httpTestSnapshot: newHTTPTestSnapshot(t), reader: &activityTagReader{t: t, actor: identityHTTPPrincipal(user, model.SessionCredential), project: project}}
	reads := 0
	database.ReadSnapshotCall = func(ctx context.Context, next func(store.SnapshotScope) error) error {
		reads++
		if ctx.Err() != nil || reads > 2 {
			t.Fatal("unexpected tag snapshot")
		}
		return next(snapshot)
	}
	response, body := identityRequest(t, browser, http.MethodPost, server.URL+base+"/resolve", `{"tagIds":["10000000-0000-4000-8000-000000000002"]}`, headers, http.StatusOK)
	if reads != 2 || snapshot.reader.position != 2 || len(response.Cookies()) != 0 || !strings.Contains(string(body), `"name":"Active tag"`) {
		t.Fatalf("tag resolve did not complete its authorized read: snapshots=%d steps=%d body=%s", reads, snapshot.reader.position, body)
	}
}

func TestProductionTerminalHistoryHeadDoesNotRenewBrowserSession(t *testing.T) {
	database, plan := newIdentityHTTPPlan(t)
	server := resourceScopeServer(t, database, attachmentTestFiles(t), io.Discard)
	browser := identityBrowser(t)
	user := identityHTTPUser("alice")
	token := httpTestToken(model.SessionCredential)
	resourceScopeCookie(t, browser, server.URL, token)
	path := "/api/v1/projects/10000000-0000-4000-8000-000000000001/tasks/10000000-0000-4000-8000-000000000002/sessions"
	headers := map[string]string{"Origin": server.URL, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Daynight-Session-Protocol": "daynight.session.v2"}
	plan.authenticate(user, model.SessionCredential, token, true)
	response, _ := identityRequest(t, browser, http.MethodHead, server.URL+path, "", headers, http.StatusMethodNotAllowed)
	if response.Header.Get("Allow") != "GET" || len(response.Cookies()) != 0 {
		t.Fatal("terminal HEAD refusal changed its protocol contract")
	}
	plan.authenticate(user, model.SessionCredential, token, true)
	delete(headers, "Daynight-Session-Protocol")
	identityRequest(t, browser, http.MethodHead, server.URL+path, "", headers, http.StatusBadRequest)
	plan.activity(user, token)
	identityRequest(t, browser, http.MethodGet, server.URL+path, "", headers, http.StatusBadRequest)
}

type activityTagSnapshot struct {
	*httpTestSnapshot
	reader *activityTagReader
}

func (s *activityTagSnapshot) ProjectDAO() store.ProjectReader { return s.reader }
func (s *activityTagSnapshot) TagDAO() store.TagReader         { return s.reader }

type activityTagReader struct {
	store.ProjectReader
	store.TagReader
	t        *testing.T
	actor    model.Principal
	project  model.Project
	position int
}

func (s *activityTagReader) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	if ctx.Err() != nil || p != s.actor || id != s.project.ID || s.position != 0 {
		s.t.Fatal("tag project admission lost context, principal or order")
	}
	s.position++
	return projectHTTPAccess(p, s.project), nil
}
func (s *activityTagReader) ResolveTags(ctx context.Context, project string, ids []string) ([]model.Tag, error) {
	if ctx.Err() != nil || project != s.project.ID || len(ids) != 1 || ids[0] != "10000000-0000-4000-8000-000000000002" || s.position != 1 {
		s.t.Fatal("tag resolution ran before project admission or changed IDs")
	}
	s.position++
	return []model.Tag{{ID: ids[0], ProjectID: project, Name: "Active tag"}}, nil
}
