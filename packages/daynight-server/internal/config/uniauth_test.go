package config

import (
	"errors"
	"strings"
	"testing"

	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func TestUniAuthValidationMatchesPinnedSDK(t *testing.T) {
	base := Config{UniAuthURL: "https://auth.example", UniAuthAppID: "app", UniAuthAppSecret: "secret"}
	cases := []struct {
		name string
		edit func(*Config)
	}{
		{"valid", func(*Config) {}},
		{"slash", func(c *Config) { c.UniAuthURL += "/" }},
		{"path", func(c *Config) { c.UniAuthURL += "/path" }},
		{"query", func(c *Config) { c.UniAuthURL += "?" }},
		{"fragment", func(c *Config) { c.UniAuthURL += "#" }},
		{"credentials", func(c *Config) { c.UniAuthURL = "https://user:password@auth.example" }},
		{"opaque", func(c *Config) { c.UniAuthURL = "https:auth.example" }},
		{"bad escape", func(c *Config) { c.UniAuthURL = "https://auth.example/%xx" }},
		{"invalid utf8 url", func(c *Config) { c.UniAuthURL = "https://auth.example/" + string([]byte{0xff}) }},
		{"remote http", func(c *Config) { c.UniAuthURL = "http://auth.example"; c.AllowLoopbackHTTP = true }},
		{"loopback not enabled", func(c *Config) { c.UniAuthURL = "http://127.0.0.1" }},
		{"loopback enabled", func(c *Config) { c.UniAuthURL = "http://[::1]:8080"; c.AllowLoopbackHTTP = true }},
		{"localhost enabled", func(c *Config) { c.UniAuthURL = "http://LOCALHOST"; c.AllowLoopbackHTTP = true }},
		{"empty app", func(c *Config) { c.UniAuthAppID = "" }},
		{"colon app", func(c *Config) { c.UniAuthAppID = "private:app" }},
		{"long app", func(c *Config) { c.UniAuthAppID = strings.Repeat("é", 65) }},
		{"max app", func(c *Config) { c.UniAuthAppID = strings.Repeat("é", 64) }},
		{"invalid utf8 app", func(c *Config) { c.UniAuthAppID = string([]byte{0xff}) }},
		{"empty secret", func(c *Config) { c.UniAuthAppSecret = "" }},
		{"long secret", func(c *Config) { c.UniAuthAppSecret = strings.Repeat("é", 257) }},
		{"max secret", func(c *Config) { c.UniAuthAppSecret = strings.Repeat("é", 256) }},
		{"invalid utf8 secret", func(c *Config) { c.UniAuthAppSecret = string([]byte{0xff}) }},
		{"error order", func(c *Config) { c.UniAuthURL = "http://auth.example"; c.UniAuthAppID = "bad:id" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			tc.edit(&c)
			_, want := uniauth.New(uniauth.Config{BaseURL: c.UniAuthURL, AppID: c.UniAuthAppID, AppSecret: c.UniAuthAppSecret, AllowLoopbackHTTP: c.AllowLoopbackHTTP})
			got := validateUniAuth(c)
			if (got == nil) != (want == nil) {
				t.Fatalf("validator = %v, SDK = %v", got, want)
			}
			if got != nil && (errors.Unwrap(got) == nil || errors.Unwrap(got).Error() != want.Error()) {
				t.Fatalf("validator cause = %v, SDK = %v", errors.Unwrap(got), want)
			}
		})
	}
}

func TestLoadAndValidateRejectUniAuthBeforeListenAddress(t *testing.T) {
	for _, tc := range []struct {
		name, field, value, cause string
	}{
		{"url", "DAYNIGHT_UNIAUTH_URL", "http://remote.example", "BaseURL requires HTTPS"},
		{"app id", "DAYNIGHT_UNIAUTH_APP_ID", "private:app", "App ID requires"},
		{"secret", "DAYNIGHT_UNIAUTH_APP_SECRET", strings.Repeat("s", 513), "App Secret requires"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			values := map[string]string{tc.field: tc.value, "DAYNIGHT_LISTEN_ADDR": "invalid"}
			_, loadErr := LoadConfig(configEnvironment(values))
			c := configuredTestConfig()
			c.ListenAddress = "invalid"
			switch tc.field {
			case "DAYNIGHT_UNIAUTH_URL":
				c.UniAuthURL = tc.value
			case "DAYNIGHT_UNIAUTH_APP_ID":
				c.UniAuthAppID = tc.value
			case "DAYNIGHT_UNIAUTH_APP_SECRET":
				c.UniAuthAppSecret = tc.value
			}
			for _, err := range []error{loadErr, c.Validate()} {
				var failure *ConfigurationError
				if !errors.As(err, &failure) || !strings.Contains(failure.Field, tc.field) || failure.Cause == nil || !strings.Contains(failure.Cause.Error(), tc.cause) {
					t.Fatalf("expected UniAuth error before listen address: %v", err)
				}
				if strings.Contains(err.Error(), tc.value) || strings.Contains(failure.Cause.Error(), tc.value) {
					t.Fatal("diagnostic exposed configuration value")
				}
			}
		})
	}
}
