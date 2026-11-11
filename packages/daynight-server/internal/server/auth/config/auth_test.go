package config

import (
	"errors"
	"testing"

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
