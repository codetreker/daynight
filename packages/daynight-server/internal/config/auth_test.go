package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestCallbackRouteReservations(t *testing.T) {
	for _, path := range []string{
		"/mcp", "/mcp/callback", "/oauth", "/oauth/consent", "/.well-known/oauth-authorization-server", "/api/v1/oauth/requests", "/api/v2/oauth", "/api/v2/oauth/grants",
		"/api/v1/webhook-event-types", "/api/v1/webhook-event-types/callback", "/api/v1/me/webhooks", "/api/v1/teams/x/webhooks",
		"/setup", "/setup/callback", "/setup/nested/callback", "/login", "/login/callback", "/login/nested/callback",
		"/projects", "/projects/callback", "/teams", "/teams/callback", "/shared-projects", "/shared-projects/callback",
		"/workers", "/workers/callback", "/workers/nested/callback", "/bots", "/bots/callback", "/bots/nested/callback",
		"/device", "/device/callback", "/api/v1/auth/device/code", "/api/v1/auth/device/token",
	} {
		t.Run(path, func(t *testing.T) {
			c := configuredTestConfig()
			c.UniAuth.CallbackURL = c.Server.PublicOrigin + path
			_, loadErr := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_UNIAUTH_CALLBACK_URL": c.UniAuth.CallbackURL}))
			for _, err := range []error{loadErr, c.Validate()} {
				var failure *configvalue.ConfigurationError
				if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_UNIAUTH_CALLBACK_URL" || failure.Rule != "must not overlap an application API, page, asset, or health route" {
					t.Fatalf("callback conflict lost configuration diagnosis: %v", err)
				}
			}
		})
	}
	for _, path := range []string{"/auth/callback", "/setup-callback", "/setupcallback", "/auth/setup/callback", "/login-callback", "/logincallback", "/auth/login/callback", "/projects-callback", "/workers-callback", "/workerscallback", "/auth/workers/callback", "/bots-callback", "/botscallback", "/auth/bots/callback"} {
		t.Run(path, func(t *testing.T) {
			c, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_UNIAUTH_CALLBACK_URL": "https://daynight.example" + path}))
			if err != nil {
				t.Fatalf("distinct callback path rejected: %v", err)
			}
			if err := c.Validate(); err != nil {
				t.Fatalf("distinct callback path failed validation: %v", err)
			}
		})
	}
}

func TestInvalidAppCredentialsRetainSafeCause(t *testing.T) {
	const invalidID, secret = "private:invalid-app-id", "credential-not-for-diagnostics"
	c := configuredTestConfig()
	c.UniAuth.AppID, c.UniAuth.AppSecret = invalidID, secret
	_, loadErr := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_UNIAUTH_APP_ID": invalidID, "DAYNIGHT_UNIAUTH_APP_SECRET": secret}))
	for _, err := range []error{loadErr, c.Validate()} {
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || !strings.Contains(failure.Field, "app_id") {
			t.Fatalf("credential syntax lost configuration diagnosis: %v", err)
		}
		cause := errors.Unwrap(failure)
		if cause == nil || !strings.Contains(cause.Error(), "App ID") {
			t.Fatalf("SDK credential validation cause was lost: %v", err)
		}
		for _, message := range []string{err.Error(), cause.Error()} {
			if strings.Contains(message, invalidID) || strings.Contains(message, secret) {
				t.Fatal("configuration diagnostics exposed credential values")
			}
		}
	}
}
