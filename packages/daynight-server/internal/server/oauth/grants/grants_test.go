package grants

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/google/uuid"
)

type unknownLifecycle struct{ lifecycle }

type observedLifecycle struct {
	items []store.OAuthGrant
	now   time.Time
	err   error
}

func (s observedLifecycle) ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error) {
	return s.items, s.now, s.err
}

func (s observedLifecycle) RevokeSessionGrant(context.Context, model.Principal, string) (bool, error) {
	return false, nil
}

func TestListUsesObservationTimeAndUTC(t *testing.T) {
	now := time.Now().UTC()
	zone := time.FixedZone("offset", 8*60*60)
	revoked := now.In(zone)
	items := []store.OAuthGrant{
		{ID: uuid.NewString(), ClientID: "test", ClientSnapshot: []byte(`{"clientId":"test"}`), CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		{ID: uuid.NewString(), ClientID: "test", ClientSnapshot: []byte(`{"clientId":"test"}`), CreatedAt: now, ExpiresAt: now.Add(time.Hour), RevokedAt: &revoked},
	}
	h := routes{grants: observedLifecycle{items: items, now: now.Add(2 * time.Hour)}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	w := httptest.NewRecorder()
	h.list(w, httptest.NewRequest("GET", "/api/v1/oauth/grants", nil), model.Principal{UserID: uuid.NewString()})
	var page struct {
		Grants []grantView `json:"grants"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Grants) != 2 || page.Grants[0].Status != "expired" || page.Grants[1].Status != "revoked" || !strings.Contains(w.Body.String(), `"revokedAt":"`+now.Format(time.RFC3339Nano)+`"`) {
		t.Fatalf("observation time or UTC: %d %s", w.Code, w.Body)
	}
}

func TestVersionedGrantProjections(t *testing.T) {
	now := time.Date(2026, 11, 12, 12, 0, 0, 123000000, time.UTC)
	used := now.In(time.FixedZone("offset", 8*60*60))
	items := []store.OAuthGrant{
		{ID: uuid.NewString(), ClientID: "test", ClientSnapshot: []byte(`{"clientId":"test","clientName":"Example"}`), CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastUsedAt: &used},
		{ID: uuid.NewString(), ClientID: "test", ClientSnapshot: []byte(`{"clientId":"test"}`), CreatedAt: now, ExpiresAt: now.Add(-time.Hour)},
	}
	h := routes{grants: observedLifecycle{items: items, now: now}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	principal := model.Principal{UserID: uuid.NewString()}
	read := func(version string) map[string]json.RawMessage {
		t.Helper()
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/api/"+version+"/oauth/grants", nil)
		if version == "v1" {
			h.list(w, r, principal)
		} else {
			h.listV2(w, r, principal)
		}
		var page map[string]json.RawMessage
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page) != 2 || string(page["userId"]) != `"`+principal.UserID+`"` {
			t.Fatalf("%s page: %d %s", version, w.Code, w.Body)
		}
		return page
	}
	v1, v2 := read("v1"), read("v2")
	var old, current []map[string]json.RawMessage
	if json.Unmarshal(v1["grants"], &old) != nil || json.Unmarshal(v2["grants"], &current) != nil || len(old) != 2 || len(current) != 2 {
		t.Fatal("invalid grant arrays")
	}
	for i := range old {
		if len(old[i]) != 9 || len(current[i]) != 10 {
			t.Fatalf("field counts: %v %v", old[i], current[i])
		}
		usage, ok := current[i]["lastUsedAt"]
		if !ok {
			t.Fatal("missing lastUsedAt")
		}
		want := `null`
		if i == 0 {
			want = `"` + now.Format(time.RFC3339Nano) + `"`
		}
		if string(usage) != want {
			t.Fatalf("usage = %s, want %s", usage, want)
		}
		delete(current[i], "lastUsedAt")
		if !reflect.DeepEqual(old[i], current[i]) {
			t.Fatalf("v1/v2 mismatch: %v %v", old[i], current[i])
		}
	}
}

func TestListRejectsInvalidRequestAndUnavailableData(t *testing.T) {
	principal := model.Principal{UserID: uuid.NewString()}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name, path string
		service    observedLifecycle
		status     int
	}{
		{"query", "/api/v1/oauth/grants?extra=1", observedLifecycle{}, 400},
		{"read failure", "/api/v1/oauth/grants", observedLifecycle{err: errors.New("storage unavailable")}, 500},
		{"malformed snapshot", "/api/v1/oauth/grants", observedLifecycle{items: []store.OAuthGrant{{ClientID: "test", ClientSnapshot: []byte(`{`)}}}, 500},
		{"different snapshot client", "/api/v1/oauth/grants", observedLifecycle{items: []store.OAuthGrant{{ClientID: "test", ClientSnapshot: []byte(`{"clientId":"other"}`)}}}, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := routes{grants: tc.service, logger: logger}
			w := httptest.NewRecorder()
			h.list(w, httptest.NewRequest("GET", tc.path, nil), principal)
			if w.Code != tc.status {
				t.Fatalf("status: %d %s", w.Code, w.Body)
			}
		})
	}
}

func (u unknownLifecycle) RevokeSessionGrant(ctx context.Context, principal model.Principal, id string) (bool, error) {
	_, err := u.lifecycle.RevokeSessionGrant(ctx, principal, id)
	if err != nil {
		return false, err
	}
	return false, core.ErrAuthorizationUnknown
}

func TestOwnerGrantsHTTP(t *testing.T) {
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	alice := h.Login(t, "grant-alice")
	bob := h.Login(t, "grant-bob")
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{alice}, nil, ""), 200)
	other := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{bob}, nil, ""), 200)
	pat := testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t, h.Request("POST", "/api/v1/me/tokens", `{"name":"owner-test","expiresAt":null}`, []*http.Cookie{alice}, nil, h.Origin), 201)
	grants := core.NewGrantLifecycle(h.Database)
	install := func(service lifecycle) {
		mux := http.NewServeMux()
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		RegisterRoutes(mux, service, h.Auth, logger)
		h.Handler = httpx.RequestLogging(logger, mux)
	}
	install(grants)
	list := func(cookie *http.Cookie) *httptest.ResponseRecorder {
		return h.Request("GET", "/api/v1/oauth/grants", "", []*http.Cookie{cookie}, nil, "")
	}
	type page struct {
		UserID string      `json:"userId"`
		Grants []grantView `json:"grants"`
	}
	empty := testsupport.DecodeResponse[page](t, list(alice), 200)
	if empty.UserID != user.ID || empty.Grants == nil || len(empty.Grants) != 0 {
		t.Fatalf("empty: %+v", empty)
	}
	issue := func(now time.Time) core.IssuedFamily {
		t.Helper()
		var result core.IssuedFamily
		completion, err := h.Database.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
			var e error
			result, e = core.IssueFamily(t.Context(), scope.CredentialFamilyDAO(), core.IssueInput{UserID: user.ID, ClientID: "test-client", ClientSnapshot: []byte(`{"clientId":"test-client","clientName":"Test app"}`), Resource: h.Origin + "/mcp"}, now)
			return e
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("issue: %+v %v", completion, err)
		}
		return result
	}
	active := issue(time.Now())
	expired := issue(time.Now().Add(-31 * 24 * time.Hour))
	usedAt := time.Now().UTC().Truncate(time.Microsecond)
	completion, err := h.Database.WriteCredentialUsage(t.Context(), []model.CredentialUsageEvent{{Kind: model.UsageSubjectOAuthGrant, UserID: user.ID, SubjectID: active.Grant.ID, At: usedAt}})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("write usage: %+v %v", completion, err)
	}
	response := list(alice)
	if strings.Contains(response.Body.String(), "lastUsedAt") {
		t.Fatalf("v1 exposed usage metadata: %s", response.Body)
	}
	pageResult := testsupport.DecodeResponse[page](t, response, 200)
	if response.Header().Get("Daynight-User-ID") != user.ID || response.Header().Get("Cache-Control") != "no-store" || len(pageResult.Grants) != 2 || pageResult.Grants[0].ID != active.Grant.ID || pageResult.Grants[0].Status != "active" || pageResult.Grants[0].ClientName != "Test app" || pageResult.Grants[1].ID != expired.Grant.ID || pageResult.Grants[1].Status != "expired" || strings.Contains(response.Body.String(), active.AccessToken) || strings.Contains(response.Body.String(), active.RefreshToken) {
		t.Fatalf("owner page: %d %s", response.Code, response.Body)
	}
	if got := testsupport.DecodeResponse[page](t, list(bob), 200); got.UserID != other.ID || len(got.Grants) != 0 {
		t.Fatalf("other page: %+v", got)
	}
	responseV2 := h.Request("GET", "/api/v2/oauth/grants", "", []*http.Cookie{alice}, nil, "")
	var pageV2 struct {
		UserID string        `json:"userId"`
		Grants []grantViewV2 `json:"grants"`
	}
	if responseV2.Code != 200 || json.Unmarshal(responseV2.Body.Bytes(), &pageV2) != nil || pageV2.UserID != user.ID || len(pageV2.Grants) != 2 || pageV2.Grants[0].ID != active.Grant.ID || pageV2.Grants[0].LastUsedAt == nil || !pageV2.Grants[0].LastUsedAt.Equal(usedAt) || pageV2.Grants[1].LastUsedAt != nil || responseV2.Header().Get("Daynight-User-ID") != user.ID || responseV2.Header().Get("Cache-Control") != "no-store" || strings.Contains(responseV2.Body.String(), active.AccessToken) || strings.Contains(responseV2.Body.String(), active.RefreshToken) {
		t.Fatalf("v2 owner page: %d %s", responseV2.Code, responseV2.Body)
	}
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v2/oauth/grants?extra=1", "", []*http.Cookie{alice}, nil, ""), 400, "invalid_input")
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v2/oauth/grants", "", nil, nil, ""), 401, "unauthenticated")
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v2/oauth/grants", "", nil, []string{"Bearer " + pat.Token}, ""), 403, "forbidden")
	for _, method := range []string{"HEAD", "POST"} {
		got := h.Request(method, "/api/v2/oauth/grants", "", []*http.Cookie{alice}, nil, h.Origin)
		if got.Code != 405 || got.Header().Get("Allow") != "GET" || got.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %v", method, got.Code, got.Header())
		}
	}
	path := "/api/v1/oauth/grants/" + active.Grant.ID + "/revoke"
	body := `{"expectedUserId":"` + user.ID + `"}`
	request := func(cookie *http.Cookie, origin, content string) *httptest.ResponseRecorder {
		return h.Request("POST", path, content, []*http.Cookie{cookie}, nil, origin)
	}
	for _, origin := range []string{"", "https://foreign.example"} {
		testsupport.AssertProjectError(t, request(alice, origin, body), 403, "forbidden")
	}
	testsupport.AssertProjectError(t, request(bob, h.Origin, body), 409, "identity_mismatch")
	testsupport.AssertProjectError(t, request(bob, h.Origin, `{"expectedUserId":"`+other.ID+`"}`), 404, "not_found")
	for _, content := range []string{`{}`, `{"expectedUserId":null}`, `{"expectedUserId":"bad"}`, `{"expectedUserId":"` + user.ID + `","extra":true}`} {
		testsupport.AssertProjectError(t, request(alice, h.Origin, content), 400, "invalid_input")
	}
	for _, method := range []string{"GET", "POST"} {
		target := "/api/v1/oauth/grants"
		if method == "POST" {
			target = path
		}
		testsupport.AssertProjectError(t, h.Request(method, target, body, []*http.Cookie{alice}, []string{"Bearer " + pat.Token}, h.Origin), 403, "forbidden")
		testsupport.AssertProjectError(t, h.Request(method, target, body, []*http.Cookie{alice}, []string{"Bearer " + active.AccessToken}, h.Origin), 401, "unauthenticated")
	}
	changed := struct {
		Changed bool `json:"changed"`
	}{}
	if err := json.Unmarshal(request(alice, h.Origin, body).Body.Bytes(), &changed); err != nil || !changed.Changed {
		t.Fatalf("revoke: %+v %v", changed, err)
	}
	repeated := testsupport.DecodeResponse[struct {
		Changed bool `json:"changed"`
	}](t, request(alice, h.Origin, body), 200)
	if repeated.Changed {
		t.Fatal("repeat changed grant")
	}
	pageResult = testsupport.DecodeResponse[page](t, list(alice), 200)
	if pageResult.Grants[0].Status != "revoked" || pageResult.Grants[0].RevokedAt == nil {
		t.Fatalf("revoked page: %+v", pageResult)
	}
	if _, err := oauthservice.NewAuthenticator(h.Database).AuthenticateAccess(t.Context(), active.AccessToken, h.Origin+"/mcp"); err == nil {
		t.Fatal("revoked access authenticated")
	}
	if _, err := grants.Rotate(t.Context(), active.RefreshToken, "test-client", h.Origin+"/mcp", func(context.Context, string) error { return nil }); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("revoked refresh: %v", err)
	}
	unknown := issue(time.Now())
	path = "/api/v1/oauth/grants/" + unknown.Grant.ID + "/revoke"
	install(unknownLifecycle{grants})
	testsupport.AssertProjectError(t, request(alice, h.Origin, body), 503, "write_outcome_unknown")
	observed := testsupport.DecodeResponse[page](t, list(alice), 200)
	if observed.Grants[0].ID != unknown.Grant.ID || observed.Grants[0].Status != "revoked" {
		t.Fatalf("current state: %+v", observed)
	}
	path = "/api/v1/oauth/grants/" + uuid.NewString() + "/revoke"
	testsupport.AssertProjectError(t, request(alice, h.Origin, body), 404, "not_found")
}

func TestRevokeRechecksSessionAfterGrantLockWait(t *testing.T) {
	for _, scenario := range []string{"logout", "expiry"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
				return authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
			})
			cookie := h.Login(t, "grant-wait-"+scenario)
			req := httptest.NewRequest("GET", "/", nil)
			req.AddCookie(cookie)
			principal, err := h.Auth.AuthenticateRequest(req)
			if err != nil {
				t.Fatal(err)
			}
			var issued core.IssuedFamily
			completion, err := h.Database.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
				var e error
				issued, e = core.IssueFamily(ctx, scope.CredentialFamilyDAO(), core.IssueInput{UserID: principal.UserID, ClientID: "test-client", ClientSnapshot: []byte(`{"clientId":"test-client"}`), Resource: h.Origin + "/mcp"}, time.Now())
				return e
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("issue: %+v %v", completion, err)
			}
			grants := core.NewGrantLifecycle(h.Database)
			mux := http.NewServeMux()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			RegisterRoutes(mux, grants, h.Auth, logger)
			h.Handler = httpx.RequestLogging(logger, mux)
			lock, err := h.Database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(context.Background())
			if _, err := lock.Exec(ctx, `SELECT id FROM oauth_grants WHERE id=$1 FOR UPDATE`, issued.Grant.ID); err != nil {
				t.Fatal(err)
			}
			response := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				response <- h.Request("POST", "/api/v1/oauth/grants/"+issued.Grant.ID+"/revoke", `{"expectedUserId":"`+principal.UserID+`"}`, []*http.Cookie{cookie}, nil, h.Origin)
			}()
			for {
				var waiting bool
				if err := h.Database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock')`, int32(lock.Conn().PgConn().PID())).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal("revoke did not wait for grant lock")
				case <-time.After(10 * time.Millisecond):
				}
			}
			if scenario == "logout" {
				if err := h.Identity.Logout(ctx, principal); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := h.Database.Pool.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1`, principal.CredentialID); err != nil {
					t.Fatal(err)
				}
				if _, err := h.Database.Pool.Exec(ctx, `SELECT pg_sleep(0.2)`); err != nil {
					t.Fatal(err)
				}
			}
			if err := lock.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-response:
				testsupport.AssertProjectError(t, got, 401, "unauthenticated")
			case <-ctx.Done():
				t.Fatal("revoke did not complete")
			}
			if _, err := oauthservice.NewAuthenticator(h.Database).AuthenticateAccess(ctx, issued.AccessToken, h.Origin+"/mcp"); err != nil {
				t.Fatalf("rejected revoke changed access: %v", err)
			}
			if _, err := grants.Rotate(ctx, issued.RefreshToken, "test-client", h.Origin+"/mcp", func(context.Context, string) error { return nil }); err != nil {
				t.Fatalf("rejected revoke changed refresh: %v", err)
			}
		})
	}
}
