package server

import (
	"context"
	"errors"
	"testing"
	"time"

	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	databaseconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/config"
	serverconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/config"
	applicationconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/application/config"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"
	configvalue "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
)

func configuredTestConfig() configpkg.Config {
	c := configpkg.Config{
		Database: databaseconfig.Config{URL: "postgres://database"},
		Storage:  storageconfig.Config{Root: "storage"},
		Server:   serverconfig.Config{ListenAddress: "127.0.0.1:0", StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, PublicOrigin: "https://daynight.example"},
		TaskSync: applicationconfig.TaskSyncConfig{Overlap: 10 * time.Second},
		UniAuth:  identityconfig.Config{URL: "https://auth.example", AppID: "configuration-test", AppSecret: "configuration-test", CallbackURL: "https://daynight.example/api/v1/auth/callback"},
	}
	c.MCP.Transfer = configpkg.DefaultConfig().MCP.Transfer
	return c
}

func configEnvironment(values map[string]string) func(string) string {
	base := map[string]string{
		"DAYNIGHT_DATABASE_URL": "postgres://database", "DAYNIGHT_STORAGE_ROOT": "storage",
		"DAYNIGHT_PUBLIC_ORIGIN": "https://daynight.example", "DAYNIGHT_UNIAUTH_URL": "https://auth.example",
		"DAYNIGHT_UNIAUTH_APP_ID": "configuration-test", "DAYNIGHT_UNIAUTH_APP_SECRET": "configuration-test",
		"DAYNIGHT_UNIAUTH_CALLBACK_URL": "https://daynight.example/api/v1/auth/callback",
	}
	for field, value := range values {
		base[field] = value
	}
	return func(key string) string { return base[key] }
}

func TestPublicPageCallbackConflictsPreventRouteComposition(t *testing.T) {
	for _, callbackPath := range []string{"/mcp", "/mcp/callback", "/oauth", "/oauth/consent", "/.well-known/oauth-authorization-server", "/api/v1/oauth/requests", "/api/v2/oauth", "/api/v2/oauth/grants", "/api/v1/webhook-event-types", "/api/v1/webhook-event-types/callback", "/api/v1/me/webhooks", "/api/v1/teams/x/webhooks", "/setup", "/setup/callback", "/setup/nested/callback", "/login", "/login/callback", "/login/nested/callback", "/projects", "/projects/callback", "/teams", "/teams/callback", "/shared-projects", "/shared-projects/callback", "/workers", "/workers/callback", "/workers/nested/callback", "/bots", "/bots/callback", "/bots/nested/callback"} {
		t.Run(callbackPath, func(t *testing.T) {
			config := configuredTestConfig()
			config.UniAuth.CallbackURL = config.Server.PublicOrigin + callbackPath
			handler, err := newTestHandler(Dependencies{}, config, testLogger())
			var failure *configvalue.ConfigurationError
			if handler != nil || !errors.As(err, &failure) || failure.Field != "DAYNIGHT_UNIAUTH_CALLBACK_URL" || failure.Rule != "must not overlap an application API, page, asset, or health route" {
				t.Fatalf("conflicting callback reached route composition or lost diagnosis: %v", err)
			}
		})
	}
}

func TestPublicPageCallbackReservationPreservesDistinctPaths(t *testing.T) {
	for _, callbackPath := range []string{"/auth/callback", "/setup-callback", "/setupcallback", "/auth/setup/callback", "/login-callback", "/logincallback", "/auth/login/callback", "/projects-callback", "/workers-callback", "/workerscallback", "/auth/workers/callback", "/bots-callback", "/botscallback", "/auth/bots/callback"} {
		t.Run(callbackPath, func(t *testing.T) {
			config, err := configpkg.LoadConfig(configEnvironment(map[string]string{
				"DAYNIGHT_UNIAUTH_CALLBACK_URL": "https://daynight.example" + callbackPath,
			}))
			if err != nil {
				t.Fatalf("distinct callback path rejected: %v", err)
			}
			handler, err := newTestHandler(Dependencies{Store: &httpTestStore{t: t}}, config, testLogger())
			if err != nil || handler == nil {
				t.Fatalf("distinct callback path failed route composition: %v", err)
			}
			t.Cleanup(func() { _ = handler.(Handler).Shutdown(context.Background()) })
		})
	}
}
