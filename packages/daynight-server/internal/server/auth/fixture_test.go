package auth

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

type authHarness = testsupport.AuthHarness[*Authentication]

func authTestHarness(t *testing.T) *authHarness {
	return testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*Authentication, error) {
		return NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	}, func(auth *Authentication, mux httpx.RouteRegistrar) error {
		if err := auth.RegisterPATScopeRoutes(mux, nil); err != nil {
			return err
		}
		return auth.RegisterScopedDeviceRoutes(mux, testsupport.ScopeCatalog(t, scopepolicy.MCP))
	})
}

func createScopedHTTPPAT(t *testing.T, h *authHarness, cookie *http.Cookie, name string, expiry *time.Time) *httptest.ResponseRecorder {
	t.Helper()
	cookies := []*http.Cookie{cookie}
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), http.StatusOK)
	catalog, enabled := h.Identity.DeviceScopeCatalog()
	if !enabled {
		t.Fatal("PAT scope catalog is unavailable")
	}
	body := testsupport.JSONBody(t, map[string]any{"name": name, "expiresAt": expiry, "expectedUserId": user.ID, "catalogRevision": catalog.CatalogRevision, "scopes": []string{"task:read"}})
	return h.Request("POST", "/api/v2/me/tokens", body, cookies, nil, h.Origin)
}
