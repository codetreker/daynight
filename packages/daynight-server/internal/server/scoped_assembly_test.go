package server

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

func TestScopedAssemblyRejectsIncompleteDependencies(t *testing.T) {
	failure := errors.New("controlled assembly failure")
	for _, tc := range []struct {
		name    string
		change  func(*service.App, *config.Config)
		message string
		cause   error
	}{
		{"scope construction", func(a *service.App, _ *config.Config) { a.ScopeError = failure }, "controlled assembly failure", failure},
		{"scope source", func(a *service.App, _ *config.Config) { a.Scoped = nil }, "credential scope assembly is unavailable", nil},
		{"preview construction", func(a *service.App, _ *config.Config) { a.PreviewSSOError = failure }, "controlled assembly failure", failure},
		{"usage construction", func(a *service.App, _ *config.Config) { a.UsageError = failure }, "controlled assembly failure", failure},
		{"usage recorder", func(a *service.App, _ *config.Config) { a.CredentialUsage = nil }, "credential usage recorder is unavailable", nil},
		{"OAuth profile", func(a *service.App, _ *config.Config) { a.OAuthProfile = nil; a.OAuthError = failure }, "OAuth public profile is unavailable", failure},
		{"Bot authorization", func(a *service.App, _ *config.Config) { a.Bots = nil }, "scoped Bot services are required", nil},
		{"download authorization", func(a *service.App, _ *config.Config) { a.Downloads = nil }, "scoped download service is required", nil},
		{"preview capability", func(a *service.App, _ *config.Config) {
			a.Identity = assemblyIdentityWithoutPreview{a.Identity.(*identityservice.Identity)}
		}, "preview SSO is unavailable", nil},
		{"S2S secret", func(_ *service.App, c *config.Config) { c.S2S.SharedKey = "short" }, "shared_key must be empty or contain 32 through 256 visible ASCII bytes", nil},
		{"public origin", func(_ *service.App, c *config.Config) { c.Server.PublicOrigin = "invalid" }, "DAYNIGHT_PUBLIC_ORIGIN", nil},
		{"MCP origins", func(_ *service.App, c *config.Config) { c.MCP.Origins.AllowedOrigins = []string{"invalid"} }, "origin", nil},
		{"PAT catalog", func(a *service.App, _ *config.Config) {
			a.Identity = assemblyIdentityWithoutCatalog{a.Identity.(*identityservice.Identity)}
		}, "PAT scope catalog is unavailable", nil},
		{"preview origin", func(_ *service.App, c *config.Config) { c.Server.PreviewOrigin = "invalid" }, "preview SSO requires exact configured origins", nil},
		{"grant lifecycle", func(a *service.App, _ *config.Config) { a.OAuthGrants = nil }, "OAuth lifecycle is required", nil},
		{"Task sync", func(a *service.App, _ *config.Config) { a.TaskSync = nil }, "scoped Task read routes require all dependencies", nil},
		{"legacy OAuth approval", func(a *service.App, _ *config.Config) { a.OAuthProfile.Authorizations = &oauthservice.Authorizations{} }, "scoped authorization is not enabled", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := configuredTestConfig()
			client, err := service.NewIdentityClient(cfg.UniAuth)
			if err != nil {
				t.Fatal(err)
			}
			app := service.NewModules(cfg, newHTTPTestStore(t), nil, attachmentTestFiles(t), client)
			app.CredentialUsage = unusedUsageRecorder(testLogger())
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := app.Engine.Stop(ctx); err != nil {
					t.Error(err)
				}
			})
			tc.change(app, &cfg)
			handler, err := New(app, cfg, testLogger())
			if handler != nil || err == nil || !strings.Contains(err.Error(), tc.message) || tc.cause != nil && !errors.Is(err, tc.cause) {
				t.Fatalf("incomplete assembly published handler=%v error=%v; want %q cause=%v", handler, err, tc.message, tc.cause)
			}
		})
	}
}

type assemblyIdentityWithoutPreview struct{ *identityservice.Identity }

func (assemblyIdentityWithoutPreview) PreviewSSO() *identityservice.PreviewSSO { return nil }

type assemblyIdentityWithoutCatalog struct{ *identityservice.Identity }

func (assemblyIdentityWithoutCatalog) DeviceScopeCatalog() (scopepolicy.CatalogSnapshot, bool) {
	return scopepolicy.CatalogSnapshot{}, false
}
