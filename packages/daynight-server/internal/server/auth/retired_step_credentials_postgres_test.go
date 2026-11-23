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
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

// The same persisted authorization survives replacing the available catalog.
func TestRetiredStepDeviceApprovalAndPATEdit(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "retired-step-device-user")
	cookies := []*http.Cookie{cookie}
	old, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read", "step:read", "step:write"})
	if err != nil {
		t.Fatal(err)
	}
	current, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	mcp, err := scopepolicy.NewCatalogSnapshot(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	if old.CatalogRevision == current.CatalogRevision {
		t.Fatal("catalog revision did not change")
	}
	install := func(catalog scopepolicy.CatalogSnapshot) {
		identity := identityservice.NewWithDeviceScopes(h.Database, nil, h.Origin+"/api/v1/auth/callback", catalog)
		a, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: h.Origin, AllowHTTPTestOrigin: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatal(err)
		}
		mux := http.NewServeMux()
		if err := a.RegisterPATScopeRoutes(mux, nil); err != nil {
			t.Fatal(err)
		}
		if err := a.RegisterScopedDeviceRoutes(mux, mcp); err != nil {
			t.Fatal(err)
		}
		h.Auth, h.Handler = a, mux
	}
	install(old)
	approved := deviceHTTPStart(t, h)
	pending := deviceHTTPStart(t, h)
	decision := func(d deviceStartResponse, revision string, scopes []string) string {
		return testsupport.JSONBody(t, map[string]any{"userCode": d.UserCode, "decision": "approve", "expectedUserId": d.ExpectedUserID, "catalogRevision": revision, "scopes": scopes})
	}
	oldScopes := []string{"step:read", "step:write", "task:read"}
	if w := h.Request("POST", "/api/v2/auth/device/decision", decision(approved, old.CatalogRevision, oldScopes), cookies, nil, h.Origin); w.Code != 204 {
		t.Fatalf("old approval: %d %s", w.Code, w.Body)
	}
	install(current)
	inspect := h.Request("POST", "/api/v2/auth/device/inspect", `{"userCode":"`+pending.UserCode+`"}`, cookies, nil, h.Origin)
	var view struct {
		CatalogRevision string `json:"catalogRevision"`
		Status          string `json:"status"`
	}
	if inspect.Code != 200 || json.Unmarshal(inspect.Body.Bytes(), &view) != nil || view.Status != "pending" || view.CatalogRevision != current.CatalogRevision {
		t.Fatalf("new inspection: %d %s", inspect.Code, inspect.Body)
	}
	if w := h.Request("POST", "/api/v2/auth/device/decision", decision(pending, old.CatalogRevision, oldScopes), cookies, nil, h.Origin); w.Code != 409 {
		t.Fatalf("stale decision: %d %s", w.Code, w.Body)
	}
	if w := h.Request("POST", "/api/v2/auth/device/decision", decision(pending, current.CatalogRevision, oldScopes), cookies, nil, h.Origin); w.Code != 400 {
		t.Fatalf("retired selection: %d %s", w.Code, w.Body)
	}
	if w := h.Request("POST", "/api/v2/auth/device/decision", decision(pending, current.CatalogRevision, []string{"task:read"}), cookies, nil, h.Origin); w.Code != 204 {
		t.Fatalf("current decision: %d %s", w.Code, w.Body)
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE device_authorizations SET next_poll_at=$1 WHERE device_code_hash=$2`, time.Now().Add(-time.Second), secret.Hash(approved.DeviceCode)); err != nil {
		t.Fatal(err)
	}
	response := deviceHTTPPoll(h, approved)
	var issued struct {
		AccessToken string `json:"access_token"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &issued) != nil || issued.AccessToken == "" {
		t.Fatalf("old approval redemption: HTTP %d or invalid token response", response.Code)
	}
	var tokenID string
	var scopes []string
	var version int64
	if err := h.Database.Pool.QueryRow(t.Context(), `SELECT id::text,business_scopes,scope_version FROM personal_access_tokens WHERE token_hash=$1`, secret.Hash(issued.AccessToken)).Scan(&tokenID, &scopes, &version); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(scopes, oldScopes) || version != 1 {
		t.Fatalf("redeemed scopes=%v version=%d", scopes, version)
	}
	path := "/api/v2/me/tokens/" + tokenID + "/scopes"
	patch := func(version string, scopes []string) *http.Response {
		w := h.Request("PATCH", path, testsupport.JSONBody(t, map[string]any{"expectedUserId": approved.ExpectedUserID, "expectedScopeVersion": version, "catalogRevision": current.CatalogRevision, "scopes": scopes}), cookies, nil, h.Origin)
		return w.Result()
	}
	removed := patch("1", []string{"task:read"})
	removed.Body.Close()
	if removed.StatusCode != 200 {
		t.Fatalf("remove old scopes: %d", removed.StatusCode)
	}
	added := patch("2", oldScopes)
	added.Body.Close()
	if added.StatusCode != 400 {
		t.Fatalf("re-add retired scopes: %d", added.StatusCode)
	}
	if err := h.Database.Pool.QueryRow(t.Context(), `SELECT business_scopes,scope_version FROM personal_access_tokens WHERE id=$1`, tokenID).Scan(&scopes, &version); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(scopes, []string{"task:read"}) || version != 2 {
		t.Fatalf("edited token %s: scopes=%v version=%d", tokenID, scopes, version)
	}
}
