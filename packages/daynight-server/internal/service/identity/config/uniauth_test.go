package config

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func TestUniAuthValidationMatchesPinnedSDK(t *testing.T) {
	base := Config{URL: "https://auth.example", AppID: "app", AppSecret: "secret"}
	cases := []struct {
		name string
		edit func(*Config)
	}{
		{"valid", func(*Config) {}},
		{"slash", func(c *Config) { c.URL += "/" }},
		{"path", func(c *Config) { c.URL += "/path" }},
		{"query", func(c *Config) { c.URL += "?" }},
		{"fragment", func(c *Config) { c.URL += "#" }},
		{"credentials", func(c *Config) { c.URL = "https://user:password@auth.example" }},
		{"opaque", func(c *Config) { c.URL = "https:auth.example" }},
		{"bad escape", func(c *Config) { c.URL = "https://auth.example/%xx" }},
		{"invalid utf8 url", func(c *Config) { c.URL = "https://auth.example/" + string([]byte{0xff}) }},
		{"remote http", func(c *Config) { c.URL = "http://auth.example"; c.AllowLoopbackHTTP = true }},
		{"loopback not enabled", func(c *Config) { c.URL = "http://127.0.0.1" }},
		{"loopback enabled", func(c *Config) { c.URL = "http://[::1]:8080"; c.AllowLoopbackHTTP = true }},
		{"localhost enabled", func(c *Config) { c.URL = "http://LOCALHOST"; c.AllowLoopbackHTTP = true }},
		{"empty app", func(c *Config) { c.AppID = "" }},
		{"colon app", func(c *Config) { c.AppID = "private:app" }},
		{"long app", func(c *Config) { c.AppID = strings.Repeat("é", 65) }},
		{"max app", func(c *Config) { c.AppID = strings.Repeat("é", 64) }},
		{"invalid utf8 app", func(c *Config) { c.AppID = string([]byte{0xff}) }},
		{"empty secret", func(c *Config) { c.AppSecret = "" }},
		{"long secret", func(c *Config) { c.AppSecret = strings.Repeat("é", 257) }},
		{"max secret", func(c *Config) { c.AppSecret = strings.Repeat("é", 256) }},
		{"invalid utf8 secret", func(c *Config) { c.AppSecret = string([]byte{0xff}) }},
		{"error order", func(c *Config) { c.URL = "http://auth.example"; c.AppID = "bad:id" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			tc.edit(&c)
			_, want := uniauth.New(uniauth.Config{BaseURL: c.URL, AppID: c.AppID, AppSecret: c.AppSecret, AllowLoopbackHTTP: c.AllowLoopbackHTTP})
			got := c.ValidateCredentials()
			if (got == nil) != (want == nil) {
				t.Fatalf("validator = %v, SDK = %v", got, want)
			}
			if got != nil && (errors.Unwrap(got) == nil || errors.Unwrap(got).Error() != want.Error()) {
				t.Fatalf("validator cause = %v, SDK = %v", errors.Unwrap(got), want)
			}
		})
	}
}

func TestIdentityEnvironmentAndRequiredFields(t *testing.T) {
	values := map[string]string{
		"DAYNIGHT_UNIAUTH_URL":          "http://127.0.0.1:8081",
		"DAYNIGHT_UNIAUTH_APP_ID":       "app",
		"DAYNIGHT_UNIAUTH_APP_SECRET":   "secret",
		"DAYNIGHT_UNIAUTH_CALLBACK_URL": "https://daynight.example/auth/callback",
		"DAYNIGHT_ALLOW_LOOPBACK_HTTP":  "1",
	}
	lookup := func(key string) (string, bool) { v, ok := values[key]; return v, ok }
	marks := make(map[string]string)
	c := DefaultConfig()
	if c != (Config{}) {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if err := c.ApplyEnvironment(lookup, func(f, v string) { marks[f] = v }); err != nil || c.URL != values["DAYNIGHT_UNIAUTH_URL"] || c.AppID != "app" || c.AppSecret != "secret" || c.CallbackURL != values["DAYNIGHT_UNIAUTH_CALLBACK_URL"] || !c.AllowLoopbackHTTP || c.Validate() != nil || !reflect.DeepEqual(marks, map[string]string{"url": "DAYNIGHT_UNIAUTH_URL", "app_id": "DAYNIGHT_UNIAUTH_APP_ID", "app_secret": "DAYNIGHT_UNIAUTH_APP_SECRET", "callback_url": "DAYNIGHT_UNIAUTH_CALLBACK_URL", "allow_loopback_http": "DAYNIGHT_ALLOW_LOOPBACK_HTTP"}) {
		t.Fatalf("identity override: %+v, %v", c, err)
	}
	before := c
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "", false }, func(string, string) { t.Error("absent environment marked") }); err != nil || c != before {
		t.Fatalf("absent environment changed configuration: %+v, %v", c, err)
	}
	invalidCredential := c
	invalidCredential.AppID = "bad:id"
	if err := invalidCredential.Validate(); err == nil || errors.Unwrap(err) == nil {
		t.Fatalf("Validate did not check credentials: %v", err)
	}
	for _, field := range []string{"DAYNIGHT_UNIAUTH_URL", "DAYNIGHT_UNIAUTH_APP_ID", "DAYNIGHT_UNIAUTH_APP_SECRET", "DAYNIGHT_UNIAUTH_CALLBACK_URL"} {
		for _, value := range []string{"", " \t"} {
			updated := c
			switch field {
			case "DAYNIGHT_UNIAUTH_URL":
				updated.URL = value
			case "DAYNIGHT_UNIAUTH_APP_ID":
				updated.AppID = value
			case "DAYNIGHT_UNIAUTH_APP_SECRET":
				updated.AppSecret = value
			case "DAYNIGHT_UNIAUTH_CALLBACK_URL":
				updated.CallbackURL = value
			}
			if err := updated.Validate(); err == nil || err.Error() != map[string]string{"DAYNIGHT_UNIAUTH_URL": "url", "DAYNIGHT_UNIAUTH_APP_ID": "app_id", "DAYNIGHT_UNIAUTH_APP_SECRET": "app_secret", "DAYNIGHT_UNIAUTH_CALLBACK_URL": "callback_url"}[field]+" is required" {
				t.Fatalf("missing %s: %v", field, err)
			}
		}
	}
	for _, value := range []string{"true", "false", "2", "secret-value"} {
		values["DAYNIGHT_ALLOW_LOOPBACK_HTTP"] = value
		if err := c.ApplyEnvironment(lookup, func(string, string) {}); err == nil || err.Error() != "allow_loopback_http must be 0 or 1" {
			t.Fatalf("invalid flag: %v", err)
		}
	}
}
