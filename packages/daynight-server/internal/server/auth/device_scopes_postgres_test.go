package auth

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestScopedDeviceHTTPApprovalToLegacyCLIRedemption(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "scoped-device-user")
	pat, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read", "team:read"})
	if err != nil {
		t.Fatal(err)
	}
	mcp, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.NewWithDeviceScopes(h.Database, nil, h.Origin+"/api/v1/auth/callback", pat)
	auth, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: h.Origin, AllowHTTPTestOrigin: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	if err := auth.RegisterScopedDeviceRoutes(mux, mcp); err != nil {
		t.Fatal(err)
	}
	h.Auth, h.Handler = auth, mux
	d := deviceHTTPStart(t, h)
	cookies := []*http.Cookie{cookie}
	inspect := h.Request("POST", "/api/v2/auth/device/inspect", `{"userCode":"`+d.UserCode+`"}`, cookies, nil, h.Origin)
	var view struct {
		CatalogRevision string `json:"catalogRevision"`
		Status          string `json:"status"`
	}
	if inspect.Code != 200 || json.Unmarshal(inspect.Body.Bytes(), &view) != nil || view.Status != "pending" || view.CatalogRevision != pat.CatalogRevision {
		t.Fatalf("inspect: %d %s", inspect.Code, inspect.Body)
	}
	user := inspect.Header().Get("Daynight-User-ID")
	d.ExpectedUserID = user
	old := h.Request("POST", "/api/v1/auth/device/decision", deviceBody(d, "approve"), cookies, nil, h.Origin)
	if old.Code != 400 {
		t.Fatalf("legacy approval: %d %s", old.Code, old.Body)
	}
	body := `{"userCode":"` + d.UserCode + `","decision":"approve","expectedUserId":"` + user + `","catalogRevision":"` + view.CatalogRevision + `","scopes":["task:read"]}`
	if w := h.Request("POST", "/api/v2/auth/device/decision", body, cookies, nil, h.Origin); w.Code != 204 {
		t.Fatalf("decision: %d %s", w.Code, w.Body)
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE device_authorizations SET next_poll_at=$1`, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	response := deviceHTTPPoll(h, d)
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &token) != nil || token.AccessToken == "" || token.TokenType != "Bearer" {
		t.Fatalf("legacy token: %d %s", response.Code, response.Body)
	}
	var scopes []string
	var version int64
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT business_scopes, scope_version FROM personal_access_tokens WHERE token_hash=$1`, secret.Hash(token.AccessToken)).Scan(&scopes, &version); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(scopes, []string{"task:read"}) || version != 1 {
		t.Fatalf("persisted scopes=%v version=%d", scopes, version)
	}
	deviceHTTPOAuthError(t, deviceHTTPPoll(h, d), 400, "invalid_grant")
	var count int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM personal_access_tokens WHERE user_id=$1`, user).Scan(&count); err != nil || count != 1 {
		t.Fatalf("token count=%d err=%v", count, err)
	}
}
