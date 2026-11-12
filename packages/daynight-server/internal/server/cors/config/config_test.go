package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestAllowedOrigin(t *testing.T) {
	for _, tc := range []struct {
		origin string
		http   bool
		valid  bool
	}{
		{"", false, true}, {"https://client.example", false, true}, {"https://client.example:8443", false, true},
		{"https://[::1]", false, true}, {"https://127.0.0.1", false, true},
		{"https://[::ffff:7f00:1]", false, true}, {"https://[::ffff:127.0.0.1]", false, false},
		{"http://[::ffff:7f00:1]:9000", true, true}, {"http://[::ffff:127.0.0.1]:9000", true, false},
		{"http://[::ffff:7f00:1]:9000", false, false}, {"http://[::ffff:c000:201]:9000", true, false},
		{"http://localhost:9000", true, true}, {"http://127.0.0.2:9000", true, true}, {"http://[::1]:9000", true, true},
		{"http://localhost:9000", false, false}, {"http://client.example", true, false}, {"http://localhost.example", true, false},
		{"https://*.example", false, false}, {"*", false, false}, {"null", false, false}, {"https://client.example/", false, false},
		{"https://client.example/path", false, false}, {"https://user@client.example", false, false}, {"https://client.example?", false, false},
		{"https://client.example#", false, false}, {"https://client.example#fragment", false, false}, {"https://CLIENT.example", false, false},
		{"https://client.example:443", false, false}, {"http://localhost:80", true, false}, {"https://client.example:08443", false, false},
		{"https://client.example:0", false, false}, {"https://client.example:65536", false, false}, {"https://client.example:", false, false},
		{"https://[0:0:0:0:0:0:0:1]", false, false}, {"https://[fe80::1%25lo]", false, false}, {"https://例.example", false, false},
		{"https://127.1", false, false}, {"https://0x7f000001", false, false}, {"https://0177.0.0.1", false, false},
		{" https://client.example", false, false}, {"https://client.example,https://second.example", false, false},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			err := (Config{AllowedOrigin: tc.origin}).Validate(tc.http)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v: %v", tc.valid, err)
			}
			if !tc.valid {
				var failure *configvalue.ConfigurationError
				if !errors.As(err, &failure) || failure.Field != "allowed_origin" || strings.Contains(err.Error(), tc.origin) {
					t.Fatalf("configuration failure disclosed value or lost field: %v", err)
				}
			}
		})
	}
}

func TestAllowedOriginPatchAndEnvironment(t *testing.T) {
	c := Config{AllowedOrigin: "https://client.example"}
	if err := (Patch{}).ApplyTo(&c); err != nil || c.AllowedOrigin != "https://client.example" {
		t.Fatalf("omitted patch: %+v %v", c, err)
	}
	value := ""
	if err := (Patch{AllowedOrigin: &value}).ApplyTo(&c); err != nil || c.AllowedOrigin != "" {
		t.Fatalf("explicit empty patch: %+v %v", c, err)
	}
	c.AllowedOrigin = "https://client.example"
	marked := false
	if err := c.ApplyEnvironment(func(key string) (string, bool) { return "", key == "DAYNIGHT_S2S_ALLOWED_ORIGIN" }, func(field, variable string) {
		marked = field == "allowed_origin" && variable == "DAYNIGHT_S2S_ALLOWED_ORIGIN"
	}); err != nil || c.AllowedOrigin != "" || !marked {
		t.Fatalf("explicit empty environment: %+v %v marked=%v", c, err, marked)
	}
	c.AllowedOrigin = "https://client.example"
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "", false }, func(string, string) { t.Fatal("omitted environment marked") }); err != nil || c.AllowedOrigin != "https://client.example" {
		t.Fatalf("omitted environment: %+v %v", c, err)
	}
}
