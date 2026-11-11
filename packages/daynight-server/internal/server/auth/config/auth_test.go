package config

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

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
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != tc.field {
				t.Fatalf("got %v, want configuration field %s", err, tc.field)
			}
		})
	}
}

func TestConfigurationErrorCause(t *testing.T) {
	cause := errors.New("underlying failure")
	err := &configvalue.ConfigurationError{Field: "field", Rule: "is invalid", Cause: cause}
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

func TestSessionChannelCallbackPathsReserved(t *testing.T) {
	config := AuthSettings{PublicOrigin: "https://daynight.example.com"}
	for _, root := range []string{"/api/v1/session-capabilities", "/api/v1/test-session-capabilities", "/api/v1/controller-channel", "/api/v1/controller-resources"} {
		for _, path := range []string{root, root + "/child"} {
			if _, _, err := ValidateAuthSettings(config, config.PublicOrigin+path); err == nil {
				t.Fatal("callback overlaps session route", path)
			}
		}
	}
}
