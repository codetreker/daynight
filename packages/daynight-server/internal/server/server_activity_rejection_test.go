package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProductionCookieProjectWritesRequireOriginBeforeRenewal(t *testing.T) {
	database, plan := newIdentityHTTPPlan(t)
	server := resourceScopeServer(t, database, attachmentTestFiles(t), io.Discard)
	browser := identityBrowser(t)
	user := identityHTTPUser("alice")
	token := httpTestToken(model.SessionCredential)
	resourceScopeCookie(t, browser, server.URL, token)
	input := jsonBody(t, api.CreateProjectRequest{Name: "Origin check", RepoURL: "https://example.test/origin", ExpectedUserID: user.ID})
	for _, tc := range []struct {
		name    string
		origins []string
	}{
		{name: "missing"}, {name: "empty", origins: []string{""}},
		{name: "duplicate", origins: []string{server.URL, server.URL}},
		{name: "mismatched", origins: []string{"https://other.test"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			plan.authenticate(user, model.SessionCredential, token, true)
			r, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+"/api/v1/projects", strings.NewReader(input))
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Sec-Fetch-Site", "same-origin")
			r.Header.Set("Sec-Fetch-Mode", "cors")
			r.Header.Set("Sec-Fetch-Dest", "empty")
			for _, origin := range tc.origins {
				r.Header.Add("Origin", origin)
			}
			response, err := browser.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusForbidden || len(response.Cookies()) != 0 {
				t.Fatalf("invalid Cookie write Origin: HTTP %d", response.StatusCode)
			}
		})
	}
	plan.authenticate(user, model.SessionCredential, token, true)
	identityRequest(t, browser, http.MethodPatch, server.URL+"/api/v2/me/tokens/20000000-0000-4000-8000-000000000001/description", `{"expectedUserId":"`+user.ID+`","description":"Origin check"}`, map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}, http.StatusForbidden)
	for _, tc := range []struct {
		name, site string
		active     bool
	}{
		{name: "valid_metadata", site: "same-origin", active: true},
		{name: "origin_only", active: true},
		{name: "ineligible_metadata", site: "cross-site"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.active {
				plan.activity(user, token)
			} else {
				plan.authenticate(user, model.SessionCredential, token, true)
			}
			actor := identityHTTPPrincipal(user, model.SessionCredential)
			projectHTTPCreate(t, database, actor, "Origin check", "https://example.test/origin", user.PersonalTeam.ID, false)
			headers := map[string]string{"Origin": server.URL}
			if tc.site != "" {
				headers["Sec-Fetch-Site"], headers["Sec-Fetch-Mode"], headers["Sec-Fetch-Dest"] = tc.site, "cors", "empty"
			}
			identityRequest(t, browser, http.MethodPost, server.URL+"/api/v1/projects", input, headers, http.StatusCreated)
		})
	}
	pat := httpTestToken(model.PATCredential)
	plan.authenticate(user, model.PATCredential, pat, true)
	projectHTTPCreate(t, database, identityHTTPPrincipal(user, model.PATCredential), "Origin check", "https://example.test/origin", user.PersonalTeam.ID, false)
	identityRequest(t, identityBrowser(t), http.MethodPost, server.URL+"/api/v1/projects", input, map[string]string{"Authorization": "Bearer " + pat}, http.StatusCreated)

	plan.activity(user, token)
	plan.user(user)
	identityRequest(t, browser, http.MethodGet, server.URL+"/api/v1/me", "", map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}, http.StatusOK)
}

func TestMethodRejectionRoutesDoNotRenewBrowserSessions(t *testing.T) {
	database, plan := newIdentityHTTPPlan(t)
	server := resourceScopeServer(t, database, attachmentTestFiles(t), io.Discard)
	browser := identityBrowser(t)
	user := identityHTTPUser("alice")
	token := httpTestToken(model.SessionCredential)
	resourceScopeCookie(t, browser, server.URL, token)
	headers := map[string]string{"Origin": server.URL, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"}
	search := "/api/v1/projects/10000000-0000-4000-8000-000000000001/tasks/search"
	resolve := "/api/v1/teams/10000000-0000-4000-8000-000000000002/members/resolve"
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, search}, {http.MethodHead, search}, {http.MethodPatch, search}, {http.MethodDelete, search},
		{http.MethodPatch, resolve}, {http.MethodDelete, resolve},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			plan.authenticate(user, model.SessionCredential, token, true)
			response, _ := identityRequest(t, browser, route.method, server.URL+route.path, "", headers, http.StatusMethodNotAllowed)
			if response.Header.Get("Allow") != "POST" || response.Header.Get("Daynight-User-ID") != user.ID || len(response.Cookies()) != 0 {
				t.Fatal("authenticated method refusal lost its protocol contract")
			}
		})
	}
	pat := httpTestToken(model.PATCredential)
	plan.authenticate(user, model.PATCredential, pat, true)
	identityRequest(t, identityBrowser(t), http.MethodGet, server.URL+search, "", map[string]string{"Authorization": "Bearer " + pat}, http.StatusMethodNotAllowed)
	identityRequest(t, identityBrowser(t), http.MethodGet, server.URL+search, "", headers, http.StatusUnauthorized)
	plan.authenticate(user, model.SessionCredential, token, true)
	identityRequest(t, browser, http.MethodPatch, server.URL+resolve, "", map[string]string{"Origin": "https://other.test"}, http.StatusForbidden)

	plan.activity(user, token)
	plan.user(user)
	identityRequest(t, browser, http.MethodGet, server.URL+"/api/v1/me", "", headers, http.StatusOK)

	plan.activity(user, token)
	actor := identityHTTPPrincipal(user, model.SessionCredential)
	project := projectHTTPRecord("10000000-0000-4000-8000-000000000001", "Search", "https://example.test/search", user.PersonalTeam.ID)
	snapshot := &activitySearchSnapshot{t: t, actor: actor, project: project}
	reads := 0
	database.ReadTaskSearchCall = func(ctx context.Context, next func(store.TaskSearchSnapshot) error) error {
		reads++
		if reads != 1 || ctx.Err() != nil {
			t.Fatal("unexpected search snapshot")
		}
		return next(snapshot)
	}
	identityRequest(t, browser, http.MethodPost, server.URL+search, `{"query":"active"}`, headers, http.StatusOK)
	if reads != 1 || snapshot.position != 3 {
		t.Fatal("registered search handler did not complete its authorized read")
	}
}

type activitySearchSnapshot struct {
	store.TaskSearchSnapshot
	t        *testing.T
	actor    model.Principal
	project  model.Project
	position int
}

func (s *activitySearchSnapshot) check(ctx context.Context, id string, position int) {
	if ctx.Err() != nil || id != s.project.ID || s.position != position {
		s.t.Fatal("search snapshot lost context, project or read ordering")
	}
	s.position++
}
func (s *activitySearchSnapshot) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	s.check(ctx, id, 0)
	projectHTTPCheck(s.t, p, s.actor)
	return projectHTTPAccess(p, s.project), nil
}
func (s *activitySearchSnapshot) Fence(ctx context.Context, id string) (store.TaskSearchFence, error) {
	s.check(ctx, id, 1)
	return store.TaskSearchFence{Epoch: "10000000-0000-4000-8000-000000000003", Count: "0", VersionSum: "0"}, nil
}
func (s *activitySearchSnapshot) Matches(ctx context.Context, id string, input store.TaskSearchQuery) (store.TaskSearchPage, error) {
	s.check(ctx, id, 2)
	if input.Limit != 50 || input.Expression == nil || input.After != nil {
		s.t.Fatal("search snapshot lost the initial query")
	}
	return store.TaskSearchPage{Items: []store.TaskSearchRow{}}, nil
}
