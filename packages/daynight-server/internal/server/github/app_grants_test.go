package github

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/google/uuid"
)

const testGrantID = "44444444-4444-4444-8444-444444444444"

func grantMux(t *testing.T, ops GrantOperations, actorID string) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, e := authhttp.NewRequestAuthentication(func(_ context.Context, k model.CredentialKind, v string) (model.Principal, error) {
		if v != "valid" {
			return model.Principal{}, authhttp.Failure()
		}
		return model.Principal{Kind: k, UserID: actorID, CredentialID: projectID}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if e != nil {
		t.Fatal(e)
	}
	mux := http.NewServeMux()
	RegisterGrantRoutes(mux, ops, auth, logger)
	return mux
}

func TestGrantAdapterPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)

	t.Run("real_store", func(t *testing.T) {
		testGrantAdapterRealStore(t, db, 42)
	})
	t.Run("personal_owner_json", func(t *testing.T) {
		testGrantAdapterPersonalOwnerJSON(t, db, 43)
	})
	testGrantAdapterTeamRemovalCases(t, db)
}

// The real adapter, manager and PostgreSQL scope must agree on hidden access,
// precise versions and the ordering of revoked grant conflicts.
func testGrantAdapterRealStore(t *testing.T, db *postgres.Store, githubAppID int64) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	appID, teamID, grantID, actorID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams (id,name) VALUES ($1,'Team')`, []any{teamID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,'admin')`, []any{teamID, actorID}},
		{`INSERT INTO github_apps (id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES ($1,$2,'App','App','app','key','secret')`, []any{appID, githubAppID}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES ($1,$2)`, []any{appID, actorID}},
		{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id,revoked_at) VALUES ($1,$2,$3,now())`, []any{grantID, appID, teamID}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	h := grantMux(t, service.NewGrantManager(db, db), actorID)
	base := appPath + "/" + appID
	cases := []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"POST", base + "/team-grant-preview", `{"teamId":"` + teamID + `"}`, 200, `"personalOwner":null`},
		{"POST", base + "/team-grant-preview", `{"teamId":"66666666-6666-4666-8666-666666666666"}`, 404, `"not_found"`},
		{"GET", base + "/team-grants/" + grantID, "", 404, `"not_found"`},
		{"GET", base + "/team-grants/" + grantID + "/revocation-preview", "", 404, `"not_found"`},
		{"POST", base + "/team-grants/" + grantID + "/revoke", `{"version":"1","impactVersion":"2","expectedUserId":"` + actorID + `"}`, 409, `"impact_changed"`},
		{"POST", base + "/team-grants/" + grantID + "/revoke", `{"version":"1","impactVersion":"1","expectedUserId":"` + actorID + `"}`, 409, `"github_grant_changed"`},
		{"GET", base + "/removal-preview", "", 200, `"hiddenProjects":"0"`},
		{"GET", base + "/team-grants", "", 200, `"items":[]`},
		{"GET", "/api/v1/teams/" + teamID + "/github/apps", "", 200, `"items":[]`},
		{"GET", base + "/removal-preview/projects", "", 200, `"items":[]`},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body).WithContext(ctx))
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.code) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body)
		}
	}
	for _, tc := range []struct {
		path, body string
		status     int
	}{
		{base + "/team-grant-preview", `{"teamId":"invalid"}`, 400},
		{base + "/team-grants", `{"id":"` + grantID + `","version":1,"teamId":"` + teamID + `","teamVersion":"1","expectedUserId":"` + actorID + `"}`, 400},
		{base + "/team-grants/" + grantID + "/revoke", `{"version":"1","impactVersion":"1","expectedUserId":"` + actorID + `","extra":1}`, 400},
		{base + "/team-grant-preview", strings.Repeat("x", appWriteBytes+1), 413},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("POST", tc.path, tc.body).WithContext(ctx))
		if w.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body)
		}
	}
	newGrant := uuid.NewString()
	for _, tc := range []struct {
		path, body string
		status     int
		want       string
	}{
		{base + "/team-grants", `{"id":"` + newGrant + `","version":"1","teamId":"` + teamID + `","teamVersion":"1","expectedUserId":"` + actorID + `"}`, 201, newGrant},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("POST", tc.path, tc.body).WithContext(ctx))
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body)
		}
	}
	for _, path := range []string{base + "/team-grants", base + "/team-grants/" + newGrant, base + "/team-grants/" + newGrant + "/revocation-preview", base + "/team-grants/" + newGrant + "/revocation-preview/projects", "/api/v1/teams/" + teamID + "/github/apps"} {
		query := "?limit=1"
		if strings.HasSuffix(path, newGrant) {
			query = ""
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("GET", path+query, "").WithContext(ctx))
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, appRequest("POST", base+"/team-grants/"+newGrant+"/revoke", `{"version":"1","impactVersion":"2","expectedUserId":"`+actorID+`"}`).WithContext(ctx))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"revoked":true`) {
		t.Fatalf("revoke: %d %s", w.Code, w.Body)
	}
	for _, path := range []string{base + "/team-grants?limit=101", "/api/v1/teams/" + teamID + "/github/apps?limit=0", base + "/removal-preview?limit=bad", base + "/team-grants?cursor=x"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("GET", path, "").WithContext(ctx))
		if w.Code != 400 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM github_app_admins WHERE app_resource_id=$1`, appID); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body string }{
		{"POST", base + "/team-grant-preview", `{"teamId":"` + teamID + `"}`},
		{"POST", base + "/team-grants", `{"id":"` + grantID + `","version":"1","teamId":"` + teamID + `","teamVersion":"1","expectedUserId":"` + actorID + `"}`},
		{"POST", base + "/team-grants/" + grantID + "/revoke", `{"version":"1","impactVersion":"1","expectedUserId":"` + actorID + `"}`},
		{"GET", base + "/removal-preview", ""},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body).WithContext(ctx))
		if w.Code != 404 || !strings.Contains(w.Body.String(), `"not_found"`) {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body)
		}
	}
}

// A storage failure must not be recast as a missing or changed grant.
type failedGrantStore struct {
	store.GitHubGrantStore
	err error
}

func (f failedGrantStore) ReadGitHubGrants(context.Context, func(store.GitHubGrantReadDAO) error) error {
	if f.err != nil {
		return f.err
	}
	return &store.Error{Phase: "read", DatabaseFailure: true}
}
func TestGrantAdapterDatabaseFailure(t *testing.T) {
	h := grantMux(t, service.NewGrantManager(failedGrantStore{}, nil), userID)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, appRequest("GET", appPath+"/"+appID+"/team-grants/"+testGrantID, ""))
	if w.Code != 500 || !strings.Contains(w.Body.String(), `"internal_error"`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	for _, tc := range []struct {
		err  error
		code int
		body string
	}{
		{context.DeadlineExceeded, 504, `"timeout"`},
		{&store.Error{Phase: "read", DatabaseFailure: true, Cause: context.DeadlineExceeded}, 500, `"internal_error"`},
		{&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionNotCommitted, Cause: context.DeadlineExceeded}, 500, `"internal_error"`},
	} {
		h := grantMux(t, service.NewGrantManager(failedGrantStore{err: tc.err}, nil), userID)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest("GET", appPath+"/"+appID+"/team-grants/"+testGrantID, ""))
		if w.Code != tc.code || !strings.Contains(w.Body.String(), tc.body) {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
	}
}

// The Team is retired between locating the grant and taking its root lock.
type retiringGrantStore struct {
	*postgres.Store
	retire func() error
}

func (s retiringGrantStore) WriteGitHubGrant(ctx context.Context, teamID, appID, actorID string, op func(store.GitHubGrantWriteDAO) error) (store.Completion, error) {
	if err := s.retire(); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return s.Store.WriteGitHubGrant(ctx, teamID, appID, actorID, op)
}
func testGrantAdapterTeamRemovalCases(t *testing.T, db *postgres.Store) {
	t.Helper()
	for _, tc := range []struct {
		name        string
		githubAppID int64
		revoke      bool
		changed     bool
		want        int
		code        string
	}{
		{"revoked and impact changed", 44, true, true, 409, "impact_changed"},
		{"revoked", 45, true, false, 409, "github_grant_changed"},
		{"live orphan", 46, false, false, 500, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			appID, teamID, grantID, actorID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`INSERT INTO teams (id,name) VALUES ($1,'Team')`, []any{teamID}},
				{`INSERT INTO github_apps (id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES ($1,$2,'App','App','app','key','secret')`, []any{appID, tc.githubAppID}},
				{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES ($1,$2)`, []any{appID, actorID}},
				{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES ($1,$2,$3)`, []any{grantID, appID, teamID}},
			} {
				if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
					t.Fatal(err)
				}
			}
			s := retiringGrantStore{Store: db, retire: func() error {
				if tc.revoke {
					if _, e := db.Pool.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, grantID); e != nil {
						return e
					}
				}
				if tc.changed {
					if _, e := db.Pool.Exec(ctx, `UPDATE github_apps SET impact_version=impact_version+1 WHERE id=$1`, appID); e != nil {
						return e
					}
				}
				_, e := db.Pool.Exec(ctx, `DELETE FROM teams WHERE id=$1`, teamID)
				return e
			}}
			h := grantMux(t, service.NewGrantManager(s, db), actorID)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, appRequest("POST", appPath+"/"+appID+"/team-grants/"+grantID+"/revoke", `{"version":"1","impactVersion":"1","expectedUserId":"`+actorID+`"}`).WithContext(ctx))
			if w.Code != tc.want || !strings.Contains(w.Body.String(), tc.code) {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
		})
	}
}

func TestGrantOperationOutcomeAndCancellation(t *testing.T) {
	h := &grantHandler{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, tc := range []struct {
		name   string
		err    error
		cancel bool
		want   int
		code   string
	}{
		{"local timeout", context.DeadlineExceeded, false, 504, "timeout"},
		{"unknown commit", &service.ManagementError{Code: "github_write_outcome_unknown", Message: "unknown", Cause: context.DeadlineExceeded}, false, 503, "github_write_outcome_unknown"},
		{"client cancelled", context.Canceled, true, 200, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", nil)
			if tc.cancel {
				ctx, cancel := context.WithCancel(r.Context())
				cancel()
				r = r.WithContext(ctx)
			}
			w := httptest.NewRecorder()
			h.bodyOperation(w, r, model.Principal{}, "grant_create", true, func(context.Context, *http.Request) (any, int, string, error) { return nil, 0, "", tc.err })
			if w.Code != tc.want || !strings.Contains(w.Body.String(), tc.code) || tc.cancel && w.Body.Len() != 0 {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
		})
	}
}

func testGrantAdapterPersonalOwnerJSON(t *testing.T, db *postgres.Store, githubAppID int64) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	appID, teamID, grantID, actorID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	owner := uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,name,email,avatar_url,created_at,updated_at) VALUES($1,$2,'Alice','secret@example.test','private',now(),now())`, []any{owner, uuid.NewString()}},
		{`INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, []any{teamID, owner}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,$2,'App','App','app','key','secret')`, []any{appID, githubAppID}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{appID, actorID}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	h := grantMux(t, service.NewGrantManager(db, db), actorID)
	base := appPath + "/" + appID
	check := func(team any) {
		t.Helper()
		m, ok := team.(map[string]any)
		if !ok || len(m) != 5 || m["id"] != teamID || m["kind"] != "personal" || m["name"] != nil || m["version"] != "1" {
			t.Fatalf("team: %#v", team)
		}
		o, ok := m["personalOwner"].(map[string]any)
		if !ok || len(o) != 2 || o["userId"] != owner || o["name"] != "Alice" {
			t.Fatalf("owner: %#v", m["personalOwner"])
		}
	}
	request := func(method, path, body string, status int) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, appRequest(method, path, body).WithContext(ctx))
		if w.Code != status {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
		var value map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	preview := request("POST", base+"/team-grant-preview", `{"teamId":"`+teamID+`"}`, 200)
	check(preview["targetTeam"])
	if preview["grant"] != nil {
		t.Fatal(preview)
	}
	created := request("POST", base+"/team-grants", `{"id":"`+grantID+`","version":"1","teamId":"`+teamID+`","teamVersion":"1","expectedUserId":"`+actorID+`"}`, 201)
	check(created["team"])
	preview = request("POST", base+"/team-grant-preview", `{"teamId":"`+teamID+`"}`, 200)
	check(preview["targetTeam"])
	check(preview["grant"].(map[string]any)["team"])
	check(request("GET", base+"/team-grants/"+grantID, "", 200)["team"])
	page := request("GET", base+"/team-grants", "", 200)
	items := page["items"].([]any)
	if len(items) != 1 {
		t.Fatal(page)
	}
	check(items[0].(map[string]any)["team"])
	if _, err := db.Pool.Exec(ctx, `DELETE FROM github_app_admins WHERE app_resource_id=$1`, appID); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{base + "/team-grants", base + "/team-grants/" + grantID} {
		request("GET", path, "", 404)
	}
}
