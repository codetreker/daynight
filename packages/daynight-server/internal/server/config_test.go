package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
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

func TestInvalidAppCredentialConfigurationPrecedesResourceOpening(t *testing.T) {
	const invalidAppID = "private:invalid-app-id"
	const secret = "credential-not-for-diagnostics"
	config := configuredTestConfig()
	config.UniAuthAppID, config.UniAuthAppSecret = invalidAppID, secret
	config.DatabaseURL = "invalid-database-configuration"
	config.StorageRoot = filepath.Join(testStorageRoot(t), "unopened-auth-storage")
	_, loadErr := configpkg.LoadConfig(configEnvironment(map[string]string{
		"DAYNIGHT_UNIAUTH_APP_ID":     invalidAppID,
		"DAYNIGHT_UNIAUTH_APP_SECRET": secret,
	}))
	validateErr := config.Validate()
	app, startErr := service.OpenApp(context.Background(), config)
	if app != nil {
		t.Fatal("invalid App credentials reached runtime composition")
	}
	for _, err := range []error{loadErr, validateErr, startErr} {
		var failure *configpkg.ConfigurationError
		if !errors.As(err, &failure) || !strings.Contains(failure.Field, "DAYNIGHT_UNIAUTH_APP_ID") {
			t.Fatalf("App credential syntax did not retain a configuration error: %v", err)
		}
		cause := errors.Unwrap(failure)
		if cause == nil || !strings.Contains(cause.Error(), "App ID") {
			t.Fatalf("SDK credential validation cause was lost: %v", err)
		}
		for _, message := range []string{err.Error(), cause.Error()} {
			if strings.Contains(message, invalidAppID) || strings.Contains(message, secret) {
				t.Fatal("configuration diagnostics exposed credential values")
			}
		}
	}
	if _, err := os.Stat(config.StorageRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid authentication configuration touched storage: %v", err)
	}
}

func TestPublicPageCallbackConflictsPrecedeResourceOpening(t *testing.T) {
	for _, callbackPath := range []string{"/mcp", "/mcp/callback", "/oauth", "/oauth/consent", "/.well-known/oauth-authorization-server", "/api/v1/oauth/requests", "/api/v1/webhook-event-types", "/api/v1/webhook-event-types/callback", "/api/v1/me/webhooks", "/api/v1/teams/x/webhooks", "/setup", "/setup/callback", "/setup/nested/callback", "/login", "/login/callback", "/login/nested/callback", "/projects", "/projects/callback", "/teams", "/teams/callback", "/shared-projects", "/shared-projects/callback", "/workers", "/workers/callback", "/workers/nested/callback", "/bots", "/bots/callback", "/bots/nested/callback"} {
		t.Run(callbackPath, func(t *testing.T) {
			config := configuredTestConfig()
			config.UniAuthCallbackURL = config.PublicOrigin + callbackPath
			config.DatabaseURL = "invalid-database-configuration"
			config.StorageRoot = filepath.Join(testStorageRoot(t), "unopened-public-page-storage")
			_, loadErr := configpkg.LoadConfig(configEnvironment(map[string]string{
				"DAYNIGHT_UNIAUTH_CALLBACK_URL": config.UniAuthCallbackURL,
			}))
			validateErr := config.Validate()
			handler, compositionErr := newTestHandler(Dependencies{}, config, testLogger())
			app, startErr := service.OpenApp(context.Background(), config)
			if handler != nil || app != nil {
				t.Fatal("conflicting public-page callback reached route or runtime composition")
			}
			for _, err := range []error{loadErr, validateErr, compositionErr, startErr} {
				var failure *configpkg.ConfigurationError
				if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_UNIAUTH_CALLBACK_URL" || failure.Rule != "must not overlap an application API, page, asset, or health route" {
					t.Fatalf("public-page callback conflict lost configuration diagnosis: %v", err)
				}
			}
			if _, err := os.Stat(config.StorageRoot); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("conflicting public-page callback touched storage: %v", err)
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

func TestMCPAllowedOriginsConfiguration(t *testing.T) {
	config, err := configpkg.LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_MCP_ALLOWED_ORIGINS": "https://client.example, https://second.example:8443"}))
	if err != nil || len(config.MCPAllowedOrigins) != 2 || config.MCPAllowedOrigins[1] != "https://second.example:8443" {
		t.Fatalf("allowed origins: %#v %v", config.MCPAllowedOrigins, err)
	}
	for _, value := range []string{"https://client.example/path", "https://client.example?", "null", "https://client.example,", "https://user@client.example"} {
		_, err := configpkg.LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_MCP_ALLOWED_ORIGINS": value}))
		var failure *configpkg.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_MCP_ALLOWED_ORIGINS" {
			t.Errorf("invalid origin %q: %v", value, err)
		}
	}
}
