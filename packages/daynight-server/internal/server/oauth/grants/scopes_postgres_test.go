package grants

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

type unknownWriter struct{ store.GrantLifecycleWriter }

func (u unknownWriter) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	c, err := u.GrantLifecycleWriter.WriteGrantLifecycle(ctx, fn)
	if err != nil || c.Outcome != store.TransactionCommitted {
		return c, err
	}
	return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true}
}

func TestScopedGrantsPostgresHTTP(t *testing.T) {
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	alice, bob := h.Login(t, "scope-alice"), h.Login(t, "scope-bob")
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{alice}, nil, ""), 200)
	other := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{bob}, nil, ""), 200)
	var issued core.IssuedFamily
	c, err := h.Database.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
		var err error
		issued, err = core.IssueFamily(t.Context(), scope.CredentialFamilyDAO(), core.IssueInput{UserID: user.ID, ClientID: "test", ClientSnapshot: []byte(`{"clientId":"test","clientName":"Example"}`), Resource: h.Origin + "/mcp"}, time.Now())
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("issue: %+v %v", c, err)
	}
	if _, err := h.Database.Pool.Exec(t.Context(), `UPDATE oauth_grants SET business_scopes=ARRAY['task:read'],scope_version=1 WHERE id=$1`, issued.Grant.ID); err != nil {
		t.Fatal(err)
	}
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read", "project:read"})
	if err != nil {
		t.Fatal(err)
	}
	life := core.NewGrantLifecycle(h.Database)
	manager, err := core.NewScopedGrantManagement(life, catalog)
	if err != nil {
		t.Fatal(err)
	}
	install := func(scoped scopedManagement) {
		mux := http.NewServeMux()
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		observed := map[string]ScopeRoute{}
		RegisterScopedRoutesWithScopeObserver(mux, life, scoped, h.Auth, logger, func(route ScopeRoute) { observed[route.Pattern] = route })
		for _, want := range []ScopeRoute{
			{Pattern: "GET /api/v3/oauth/grants", BrowserOnly: true},
			{Pattern: "HEAD /api/v3/oauth/grants", BrowserOnly: true, Fallback: true},
			{Pattern: "/api/v3/oauth/grants", BrowserOnly: true, Fallback: true},
			{Pattern: "PATCH /api/v3/oauth/grants/{id}/scopes", BrowserOnly: true},
			{Pattern: "/api/v3/oauth/grants/{id}/scopes", BrowserOnly: true, Fallback: true},
		} {
			if observed[want.Pattern] != want {
				t.Fatalf("route classification: %+v", observed)
			}
		}
		h.Handler = httpx.RequestLogging(logger, mux)
	}
	install(manager)
	path := "/api/v3/oauth/grants/" + issued.Grant.ID + "/scopes"
	body := func(owner, version, selected string) string {
		return `{"expectedUserId":"` + owner + `","expectedScopeVersion":"` + version + `","catalogRevision":"` + catalog.CatalogRevision + `","scopes":["` + selected + `"]}`
	}
	patch := func(cookie *http.Cookie, origin, content string) int {
		return h.Request("PATCH", path, content, []*http.Cookie{cookie}, nil, origin).Code
	}
	if got := patch(alice, "https://foreign.example", body(user.ID, "1", "project:read")); got != 403 {
		t.Fatalf("origin: %d", got)
	}
	if got := patch(bob, h.Origin, body(other.ID, "1", "project:read")); got != 404 {
		t.Fatalf("other owner: %d", got)
	}
	if got := patch(alice, h.Origin, body(user.ID, "1", "project:read")); got != 200 {
		t.Fatalf("update: %d", got)
	}
	if got := patch(alice, h.Origin, body(user.ID, "1", "task:read")); got != 409 {
		t.Fatalf("stale: %d", got)
	}
	unknown, err := core.NewScopedGrantManagement(core.NewGrantLifecycle(unknownWriter{h.Database}), catalog)
	if err != nil {
		t.Fatal(err)
	}
	install(unknown)
	response := h.Request("PATCH", path, body(user.ID, "2", "task:read"), []*http.Cookie{alice}, nil, h.Origin)
	if response.Code != 503 || !strings.Contains(response.Body.String(), "write_outcome_unknown") {
		t.Fatalf("unknown: %d %s", response.Code, response.Body)
	}
	install(manager)
	read := h.Request("GET", "/api/v3/oauth/grants", "", []*http.Cookie{alice}, nil, "")
	var page struct {
		Grants []struct {
			ID          string    `json:"id"`
			ScopePolicy scopeView `json:"scopePolicy"`
		} `json:"grants"`
	}
	if read.Code != 200 || json.Unmarshal(read.Body.Bytes(), &page) != nil || len(page.Grants) != 1 || page.Grants[0].ID != issued.Grant.ID || page.Grants[0].ScopePolicy.ScopeVersion != "3" || len(page.Grants[0].ScopePolicy.Scopes) != 1 || page.Grants[0].ScopePolicy.Scopes[0] != "task:read" {
		t.Fatalf("read back: %d %s", read.Code, read.Body)
	}
}
