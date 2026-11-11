package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestCallbackRouteReservations(t *testing.T) {
	for _, path := range []string{
		"/mcp", "/mcp/callback", "/oauth", "/oauth/consent", "/.well-known/oauth-authorization-server", "/api/v1/oauth/requests",
		"/api/v1/webhook-event-types", "/api/v1/webhook-event-types/callback", "/api/v1/me/webhooks", "/api/v1/teams/x/webhooks",
		"/setup", "/setup/callback", "/setup/nested/callback", "/login", "/login/callback", "/login/nested/callback",
		"/projects", "/projects/callback", "/teams", "/teams/callback", "/shared-projects", "/shared-projects/callback",
		"/workers", "/workers/callback", "/workers/nested/callback", "/bots", "/bots/callback", "/bots/nested/callback",
		"/device", "/device/callback", "/api/v1/auth/device/code", "/api/v1/auth/device/token",
	} {
		t.Run(path, func(t *testing.T) {
			c := configuredTestConfig()
			c.UniAuthCallbackURL = c.PublicOrigin + path
			_, loadErr := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_UNIAUTH_CALLBACK_URL": c.UniAuthCallbackURL}))
			for _, err := range []error{loadErr, c.Validate()} {
				var failure *ConfigurationError
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
	c.UniAuthAppID, c.UniAuthAppSecret = invalidID, secret
	_, loadErr := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_UNIAUTH_APP_ID": invalidID, "DAYNIGHT_UNIAUTH_APP_SECRET": secret}))
	for _, err := range []error{loadErr, c.Validate()} {
		var failure *ConfigurationError
		if !errors.As(err, &failure) || !strings.Contains(failure.Field, "DAYNIGHT_UNIAUTH_APP_ID") {
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

func TestAuthSettingsOriginsAndCallbacks(t *testing.T) {
	for _, tc := range []struct {
		name, origin, callback, field string
		allowHTTP                     bool
	}{
		{"secure", "https://example.com", "https://example.com/auth/callback", "", false},
		{"test origin", "http://localhost:8787", "http://localhost:8787/auth/callback", "", true},
		{"origin path", "https://example.com/", "https://example.com/auth/callback", "DAYNIGHT_PUBLIC_ORIGIN", false},
		{"host case", "https://EXAMPLE.com", "https://EXAMPLE.com/auth/callback", "DAYNIGHT_PUBLIC_ORIGIN", false},
		{"default port", "https://example.com:443", "https://example.com:443/auth/callback", "DAYNIGHT_PUBLIC_ORIGIN", false},
		{"http forbidden", "http://localhost:8787", "http://localhost:8787/auth/callback", "DAYNIGHT_PUBLIC_ORIGIN", false},
		{"different origin", "https://example.com", "https://other.example/auth/callback", "DAYNIGHT_UNIAUTH_CALLBACK_URL", false},
		{"noncanonical callback", "https://example.com", "https://example.com/a/../callback", "DAYNIGHT_UNIAUTH_CALLBACK_URL", false},
		{"reserved callback", "https://example.com", "https://example.com/api/v1/me/child", "DAYNIGHT_UNIAUTH_CALLBACK_URL", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			origin, path, err := ValidateAuthSettings(AuthSettings{PublicOrigin: tc.origin, AllowHTTPTestOrigin: tc.allowHTTP}, tc.callback)
			if tc.field == "" {
				if err != nil || origin.String() != tc.origin || path != "/auth/callback" {
					t.Fatalf("got %v %q %v", origin, path, err)
				}
				return
			}
			var failure *ConfigurationError
			if !errors.As(err, &failure) || failure.Field != tc.field {
				t.Fatalf("got %v, want configuration field %s", err, tc.field)
			}
		})
	}
}

func TestConfigurationErrorCause(t *testing.T) {
	cause := errors.New("underlying failure")
	err := &ConfigurationError{Field: "field", Rule: "is invalid", Cause: cause}
	if err.Error() != "field is invalid" || !errors.Is(err, cause) {
		t.Fatalf("configuration error lost its diagnostic or cause: %v", err)
	}
}

func TestTeamHTTPReservedIdentityCallbackPaths(t *testing.T) {
	for _, path := range []string{"/api/v1/teams", "/api/v1/teams/" + uuid.NewString(), "/teams", "/teams/" + uuid.NewString()} {
		_, _, err := ValidateAuthSettings(AuthSettings{PublicOrigin: "https://example.com"}, "https://example.com"+path)
		if err == nil {
			t.Fatalf("identity callback captured Team path %s", path)
		}
	}
}
