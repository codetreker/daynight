package server

import (
	"context"
	"errors"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
)

func configuredTestConfig() configpkg.Config {
	return configpkg.Config{
		DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0",
		StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second,
		PublicOrigin: "https://daynight.example", UniAuthURL: "https://auth.example",
		UniAuthAppID: "configuration-test", UniAuthAppSecret: "configuration-test",
		UniAuthCallbackURL: "https://daynight.example/api/v1/auth/callback",
	}
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
	for _, callbackPath := range []string{"/mcp", "/mcp/callback", "/oauth", "/oauth/consent", "/.well-known/oauth-authorization-server", "/api/v1/oauth/requests", "/api/v1/webhook-event-types", "/api/v1/webhook-event-types/callback", "/api/v1/me/webhooks", "/api/v1/teams/x/webhooks", "/setup", "/setup/callback", "/setup/nested/callback", "/login", "/login/callback", "/login/nested/callback", "/projects", "/projects/callback", "/teams", "/teams/callback", "/shared-projects", "/shared-projects/callback", "/workers", "/workers/callback", "/workers/nested/callback", "/bots", "/bots/callback", "/bots/nested/callback"} {
		t.Run(callbackPath, func(t *testing.T) {
			config := configuredTestConfig()
			config.UniAuthCallbackURL = config.PublicOrigin + callbackPath
			handler, err := newTestHandler(Dependencies{}, config, testLogger())
			var failure *configpkg.ConfigurationError
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
