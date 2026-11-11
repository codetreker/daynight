package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestOriginsEnvironmentAndValidation(t *testing.T) {
	c := DefaultConfig()
	mark := ""
	err := c.ApplyEnvironment(func(string) (string, bool) { return "https://client.example, http://localhost:9000", true }, func(field, variable string) { mark = field + ":" + variable })
	if err != nil || len(c.AllowedOrigins) != 2 || c.AllowedOrigins[0] != "https://client.example" || c.AllowedOrigins[1] != "http://localhost:9000" || mark != "allowed_origins:DAYNIGHT_MCP_ALLOWED_ORIGINS" || c.Validate() != nil {
		t.Fatalf("origins: %+v, %v, %s", c, err, mark)
	}
	for _, value := range []string{"https://client.example/path", "https://client.example?", "null", "https://client.example,", "https://user@client.example", "https://CLIENT.example", "https://client.example#fragment"} {
		c = DefaultConfig()
		_ = c.ApplyEnvironment(func(string) (string, bool) { return value, true }, func(string, string) {})
		err := c.Validate()
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_MCP_ALLOWED_ORIGINS" || failure.Cause == nil || strings.Contains(err.Error(), value) {
			t.Fatalf("invalid origin: %v", err)
		}
	}
	c = Config{AllowedOrigins: []string{"https://example.com"}}
	_ = c.ApplyEnvironment(func(string) (string, bool) { return "", true }, func(string, string) {})
	if len(c.AllowedOrigins) != 0 {
		t.Fatal("explicit empty value did not clear origins")
	}
}
