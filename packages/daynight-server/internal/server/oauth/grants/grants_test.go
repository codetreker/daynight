package grants

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
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
}

func (s observedLifecycle) ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error) {
	return s.items, s.now, nil
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

func (u unknownLifecycle) RevokeSessionGrant(ctx context.Context, principal model.Principal, id string) (bool, error) {
	_, err := u.lifecycle.RevokeSessionGrant(ctx, principal, id)
	if err != nil {
		return false, err
	}
	return false, core.ErrAuthorizationUnknown
}

func TestOwnerGrantsHTTP(t *testing.T) {
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
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
	response := list(alice)
	pageResult := testsupport.DecodeResponse[page](t, response, 200)
	if response.Header().Get("Daynight-User-ID") != user.ID || response.Header().Get("Cache-Control") != "no-store" || len(pageResult.Grants) != 2 || pageResult.Grants[0].ID != active.Grant.ID || pageResult.Grants[0].Status != "active" || pageResult.Grants[0].ClientName != "Test app" || pageResult.Grants[1].ID != expired.Grant.ID || pageResult.Grants[1].Status != "expired" || strings.Contains(response.Body.String(), active.AccessToken) || strings.Contains(response.Body.String(), active.RefreshToken) {
		t.Fatalf("owner page: %d %s", response.Code, response.Body)
	}
	if got := testsupport.DecodeResponse[page](t, list(bob), 200); got.UserID != other.ID || len(got.Grants) != 0 {
		t.Fatalf("other page: %+v", got)
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
				return authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
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
