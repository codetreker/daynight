package grants

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

func TestRetiredStepGrantEditPreservesIdentity(t *testing.T) {
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	cookie := h.Login(t, "retired-step-grant-user")
	cookies := []*http.Cookie{cookie}
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 200)
	var issued core.IssuedFamily
	completion, err := h.Database.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
		var err error
		issued, err = core.IssueFamily(t.Context(), scope.CredentialFamilyDAO(), core.IssueInput{UserID: user.ID, ClientID: "test", ClientSnapshot: []byte(`{"clientId":"test","clientName":"Example"}`), Resource: h.Origin + "/mcp"}, time.Now())
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("issue: %+v %v", completion, err)
	}
	if _, err := h.Database.Pool.Exec(t.Context(), `UPDATE oauth_grants SET business_scopes=ARRAY['step:read','step:write','task:read'],scope_version=1 WHERE id=$1`, issued.Grant.ID); err != nil {
		t.Fatal(err)
	}
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	life := core.NewGrantLifecycle(h.Database)
	manager, err := core.NewScopedGrantManagement(life, catalog)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterScopedRoutesWithScopeObserver(mux, life, manager, h.Auth, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	h.Handler = mux
	path := "/api/v3/oauth/grants/" + issued.Grant.ID + "/scopes"
	patch := func(version string, scopes []string) int {
		body := testsupport.JSONBody(t, map[string]any{"expectedUserId": user.ID, "expectedScopeVersion": version, "catalogRevision": catalog.CatalogRevision, "scopes": scopes})
		return h.Request("PATCH", path, body, cookies, nil, h.Origin).Code
	}
	if got := patch("1", []string{"task:read"}); got != 200 {
		t.Fatalf("remove old scopes: %d", got)
	}
	if got := patch("2", []string{"step:read", "task:read"}); got != 400 {
		t.Fatalf("re-add retired scope: %d", got)
	}
	read := h.Request("GET", "/api/v3/oauth/grants", "", cookies, nil, "")
	var page struct {
		Grants []struct {
			ID          string    `json:"id"`
			ScopePolicy scopeView `json:"scopePolicy"`
		} `json:"grants"`
	}
	if read.Code != 200 || json.Unmarshal(read.Body.Bytes(), &page) != nil || len(page.Grants) != 1 || page.Grants[0].ID != issued.Grant.ID || page.Grants[0].ScopePolicy.ScopeVersion != "2" || !slices.Equal(page.Grants[0].ScopePolicy.Scopes, []scopepolicy.ScopeID{"task:read"}) {
		t.Fatalf("read back: %d %s", read.Code, read.Body)
	}
}
