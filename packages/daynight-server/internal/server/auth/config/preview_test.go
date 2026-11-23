package config

import "testing"

func TestPreviewSSOCallbackRoutesReserved(t *testing.T) {
	settings := AuthSettings{PublicOrigin: "https://daynight.test"}
	for _, path := range []string{"/api/v1/auth/preview", "/api/v1/auth/preview/authorize", "/api/v1/auth/preview/authorize/child", "/auth/sso", "/auth/sso/start"} {
		if _, _, err := ValidateAuthSettings(settings, settings.PublicOrigin+path); err == nil {
			t.Fatalf("SSO callback overlap allowed: %s", path)
		}
	}
}
