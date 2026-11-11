package config

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestMCPOriginsConfigurationAndValidationOrder(t *testing.T) {
	c, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_MCP_ALLOWED_ORIGINS": "https://client.example, http://localhost:9000"}))
	if err != nil || len(c.MCP.Origins.AllowedOrigins) != 2 || c.MCP.Origins.AllowedOrigins[0] != "https://client.example" || c.MCP.Origins.AllowedOrigins[1] != "http://localhost:9000" {
		t.Fatalf("MCP allowed origins: %v, %v", c.MCP.Origins.AllowedOrigins, err)
	}
	c, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_MCP_ALLOWED_ORIGINS": "https://client.example, https://second.example:8443"}))
	if err != nil || len(c.MCP.Origins.AllowedOrigins) != 2 || c.MCP.Origins.AllowedOrigins[1] != "https://second.example:8443" {
		t.Fatalf("allowed origins: %#v %v", c.MCP.Origins.AllowedOrigins, err)
	}
	for _, invalid := range []string{"https://client.example/path", "https://client.example?", "null", "https://client.example,", "https://user@client.example", "https://CLIENT.example", "https://client.example#fragment"} {
		_, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_MCP_ALLOWED_ORIGINS": invalid}))
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_MCP_ALLOWED_ORIGINS" || failure.Cause == nil || strings.Contains(err.Error(), invalid) {
			t.Errorf("invalid MCP origin %q: %v", invalid, err)
		}
	}
	c = configuredTestConfig()
	c.MCP.Origins.AllowedOrigins = []string{"https://client.example/path"}
	c.UniAuth.AppID = "invalid:app"
	c.UniAuth.CallbackURL = c.Server.PublicOrigin + "/mcp"
	var failure *configvalue.ConfigurationError
	if err := c.Validate(); !errors.As(err, &failure) || failure.Field != "DAYNIGHT_UNIAUTH_CALLBACK_URL" {
		t.Fatalf("callback error must precede MCP origin: %v", err)
	}
	c.UniAuth.CallbackURL = c.Server.PublicOrigin + "/api/v1/auth/callback"
	if err := c.Validate(); !errors.As(err, &failure) || failure.Field != "DAYNIGHT_MCP_ALLOWED_ORIGINS" {
		t.Fatalf("MCP origin must precede credential validation: %v", err)
	}
	c.MCP.Origins.AllowedOrigins = nil
	if err := c.Validate(); !errors.As(err, &failure) || !strings.Contains(failure.Field, "DAYNIGHT_UNIAUTH_APP_ID") {
		t.Fatalf("invalid credential was not validated: %v", err)
	}
}

func TestOAuthPreregisteredClients(t *testing.T) {
	valid := `{"known":{"client_id":"known","redirect_uris":["https://client.example/callback"]}}`
	c, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS": valid}))
	if err != nil || len(c.OAuth.PreregisteredClients) != 1 || len(c.OAuth.PreregisteredClients["known"]) == 0 {
		t.Fatalf("valid preregistration: %v", err)
	}
	for _, value := range []string{`[]`, `null`, `{"known":null}`, `{"known":{"client_id":"other","redirect_uris":["https://client.example/callback"]}}`, `{"a":{},"a":{}}`, valid + ` {}`} {
		_, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS": value}))
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS" || strings.Contains(err.Error(), value) {
			t.Fatalf("invalid preregistration accepted or disclosed: %v", err)
		}
	}
}

func configuredTestConfig() Config {
	c := DefaultConfig()
	c.MCP.Transfer.TempBudgetBytes = 0
	c.MCP.Transfer.ReservedFreeBytes = 0
	c.Database.URL = "postgres://database"
	c.Storage.Root = "storage"
	c.Server.ListenAddress = "127.0.0.1:0"
	c.Server.StartupTimeout = 5 * time.Second
	c.Server.ShutdownTimeout = time.Second
	c.TaskSync.Overlap = 10 * time.Second
	c.Server.PublicOrigin = "https://daynight.example"
	c.UniAuth.URL = "https://auth.example"
	c.UniAuth.AppID = "configuration-test"
	c.UniAuth.AppSecret = "configuration-test"
	c.UniAuth.CallbackURL = "https://daynight.example/api/v1/auth/callback"
	return c
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

func TestLoadConfig(t *testing.T) {
	config, err := LoadConfig(configEnvironment(nil))
	if err != nil || config.Storage.Root != "storage" || config.Server.ListenAddress != "127.0.0.1:8787" || config.Server.StartupTimeout != 10*time.Second || config.Server.ShutdownTimeout != 10*time.Second || config.TaskSync.Overlap != 10*time.Second {
		t.Fatalf("unexpected defaults: %+v, %v", config, err)
	}
	config, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_LISTEN_ADDR": "[::1]:0"}))
	if err != nil || config.Server.ListenAddress != "[::1]:0" {
		t.Fatalf("IPv6 loopback rejected: %+v, %v", config, err)
	}
	for value, want := range map[string]time.Duration{"250ms": 250 * time.Millisecond, "30s": 30 * time.Second, "1m30s": 90 * time.Second, "1ns": time.Nanosecond} {
		config, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_TASK_SYNC_OVERLAP": value}))
		if err != nil || config.TaskSync.Overlap != want {
			t.Fatalf("explicit task sync overlap %s ignored: %+v %v", value, config, err)
		}
	}
}

func TestMonitoringRedisConfiguration(t *testing.T) {
	for _, value := range []string{"", "redis://127.0.0.1:6379/0", "redis://127.0.0.1:6379?db=1", "rediss://user:secret@redis.example:6380/1"} {
		c, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_REDIS_URL": value}))
		if err != nil || c.Monitoring.Redis.RedisURL != value {
			t.Fatalf("Redis URL not preserved: %v", err)
		}
	}
	for _, value := range []string{" ", "https://example.com", "unix:///tmp/redis.sock", "redis://host:word", "redis://host:", "redis://host:0", "redis://host:99999", "redis://host/-1", "redis://host?db=-1", "redis://host?db=", "redis://host?pool_size=2147483648", "redis://host?min_idle_conns=999999999", "redis://host?db=0&db=1", "redis://host/invalid", "redis://user:secret@bad%host"} {
		_, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_REDIS_URL": value}))
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_REDIS_URL" || strings.Contains(err.Error(), "secret") {
			t.Fatalf("invalid Redis URL accepted or disclosed: %v", err)
		}
	}
}

func TestMCPTemporaryCapacityConfiguration(t *testing.T) {
	c, err := LoadConfig(configEnvironment(nil))
	if err != nil || c.MCP.Transfer.TempBudgetBytes != 8<<30 || c.MCP.Transfer.ReservedFreeBytes != 1<<30 {
		t.Fatalf("temporary capacity defaults: %+v, %v", c, err)
	}
	c, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_MCP_TEMP_BUDGET_BYTES": "123", "DAYNIGHT_MCP_RESERVED_FREE_BYTES": "0"}))
	if err != nil || c.MCP.Transfer.TempBudgetBytes != 123 || c.MCP.Transfer.ReservedFreeBytes != 0 {
		t.Fatalf("temporary capacity overrides: %+v, %v", c, err)
	}
	for _, field := range []string{"DAYNIGHT_MCP_TEMP_BUDGET_BYTES", "DAYNIGHT_MCP_RESERVED_FREE_BYTES"} {
		for _, value := range []string{"-1", "+1", "01", "1GiB", "9223372036854775808"} {
			_, err := LoadConfig(configEnvironment(map[string]string{field: value}))
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != field {
				t.Fatalf("accepted %s=%q: %v", field, value, err)
			}
		}
	}
	if _, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_MCP_TEMP_BUDGET_BYTES": "0"})); err == nil {
		t.Fatal("zero temporary budget accepted")
	}
}

func TestConfigRejectsInvalidInputs(t *testing.T) {
	for _, field := range []string{"DAYNIGHT_STARTUP_TIMEOUT", "DAYNIGHT_SHUTDOWN_TIMEOUT", "DAYNIGHT_TASK_SYNC_OVERLAP"} {
		for _, value := range []string{"-1s", "0s", "password", "1", "99999999999999999999h"} {
			_, err := LoadConfig(configEnvironment(map[string]string{field: value}))
			if err == nil || !strings.Contains(err.Error(), field) || strings.Contains(err.Error(), value) {
				t.Fatalf("invalid duration not safely diagnosed: %v", err)
			}
		}
	}
	config, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_STARTUP_TIMEOUT": "2s", "DAYNIGHT_SHUTDOWN_TIMEOUT": "300ms"}))
	if err != nil || config.Server.StartupTimeout != 2*time.Second || config.Server.ShutdownTimeout != 300*time.Millisecond {
		t.Fatalf("explicit durations ignored: %+v %v", config, err)
	}
	for _, address := range []string{"localhost:80", ":80", "0.0.0.0:80", "[::]:80", "192.0.2.1:80", "[::1%eth0]:80", "127.0.0.1", "127.0.0.1:word", "127.0.0.1:-1", "127.0.0.1:65536", "127.0.0.1:080"} {
		t.Run(address, func(t *testing.T) {
			config := configuredTestConfig()
			config.Database.URL = "postgres://secret"
			config.Server.ListenAddress = address
			if err := config.Validate(); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("expected safe validation error: %v", err)
			}
		})
	}
	for _, invalid := range []struct {
		name   string
		change func(*Config)
	}{
		{"missing database", func(config *Config) { config.Database.URL = "" }},
		{"blank database", func(config *Config) { config.Database.URL = " " }},
		{"missing startup timeout", func(config *Config) { config.Server.StartupTimeout = 0 }},
		{"negative shutdown timeout", func(config *Config) { config.Server.ShutdownTimeout = -time.Second }},
		{"missing task sync overlap", func(config *Config) { config.TaskSync.Overlap = 0 }},
		{"negative task sync overlap", func(config *Config) { config.TaskSync.Overlap = -time.Second }},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			config := configuredTestConfig()
			invalid.change(&config)
			if err := config.Validate(); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
}

func TestStorageRootConfiguration(t *testing.T) {
	for _, root := range []string{"", " \t"} {
		_, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_STORAGE_ROOT": root}))
		if err == nil || err.Error() != "DAYNIGHT_STORAGE_ROOT is required" {
			t.Fatalf("missing root was not diagnosed: %v", err)
		}
	}
	config := configuredTestConfig()
	config.Storage.Root = "a/root/that/does/not/exist"
	if err := config.Validate(); err != nil {
		t.Fatalf("configuration validation performed filesystem initialization: %v", err)
	}
}

func TestAuthenticationConfigurationIsRequiredAndFlagsAreExplicit(t *testing.T) {
	for _, field := range []string{
		"DAYNIGHT_PUBLIC_ORIGIN", "DAYNIGHT_UNIAUTH_URL", "DAYNIGHT_UNIAUTH_APP_ID",
		"DAYNIGHT_UNIAUTH_APP_SECRET", "DAYNIGHT_UNIAUTH_CALLBACK_URL",
	} {
		for _, value := range []string{"", " \t"} {
			_, err := LoadConfig(configEnvironment(map[string]string{field: value}))
			if err == nil || err.Error() != field+" is required" {
				t.Fatalf("missing %s was not diagnosed: %v", field, err)
			}
		}
	}
	for _, field := range []string{"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN", "DAYNIGHT_ALLOW_LOOPBACK_HTTP"} {
		for _, value := range []string{"true", "false", "2", "secret-value"} {
			_, err := LoadConfig(configEnvironment(map[string]string{field: value}))
			if err == nil || err.Error() != field+" must be 0 or 1" {
				t.Fatalf("invalid %s flag was not safely diagnosed: %v", field, err)
			}
		}
	}
	config, err := LoadConfig(configEnvironment(map[string]string{
		"DAYNIGHT_PUBLIC_ORIGIN":          "http://app.daynight.test:8080",
		"DAYNIGHT_UNIAUTH_CALLBACK_URL":   "http://app.daynight.test:8080/auth/callback",
		"DAYNIGHT_UNIAUTH_URL":            "http://127.0.0.1:8081",
		"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1", "DAYNIGHT_ALLOW_LOOPBACK_HTTP": "1",
	}))
	if err != nil || !config.Server.AllowHTTPTestOrigin || !config.UniAuth.AllowLoopbackHTTP || config.UniAuth.CallbackURL != "http://app.daynight.test:8080/auth/callback" {
		t.Fatalf("explicit test origin and gateway settings rejected: %+v %v", config, err)
	}
	config, err = LoadConfig(configEnvironment(map[string]string{
		"DAYNIGHT_PUBLIC_ORIGIN": "https://daynight.example",
		"DAYNIGHT_UNIAUTH_URL":   "http://127.0.0.1:8081", "DAYNIGHT_ALLOW_LOOPBACK_HTTP": "1",
	}))
	if err != nil || config.Server.AllowHTTPTestOrigin || !config.UniAuth.AllowLoopbackHTTP {
		t.Fatalf("HTTPS primary origin and explicit numeric-loopback gateway rejected: %+v %v", config, err)
	}
}

func TestWebhookConfiguration(t *testing.T) {
	c, err := LoadConfig(configEnvironment(nil))
	if err != nil || c.Webhook.Enabled {
		t.Fatalf("webhooks should default disabled: %v", err)
	}
	for _, v := range []string{"true", "yes", "2"} {
		_, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_WEBHOOK_ENABLED": v}))
		var invalid *configvalue.ConfigurationError
		if !errors.As(err, &invalid) || invalid.Field != "DAYNIGHT_WEBHOOK_ENABLED" {
			t.Fatalf("invalid flag %q: %v", v, err)
		}
	}
	c, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_WEBHOOK_ENABLED": "1"}))
	if err != nil || !c.Webhook.Enabled {
		t.Fatalf("enabled webhook configuration: %v", err)
	}
	_, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_SHUTDOWN_TIMEOUT": "11s"}))
	if err == nil {
		t.Fatal("shutdown exceeded shared budget")
	}
}

func TestImageValidationConfiguration(t *testing.T) {
	c, err := LoadConfig(configEnvironment(nil))
	if err != nil || c.ImageDecoder.NodePath != "" || c.ImageDecoder.HelperPath != "" || c.ImageDecoder.ManifestPath != "" || c.ImageDecoder.TemporaryDirectory != "" {
		t.Fatalf("decoder must remain unavailable without explicit artifacts: %+v %v", c, err)
	}
	values := map[string]string{
		"DAYNIGHT_IMAGE_NODE_PATH":      "/opt/daynight/bin/node",
		"DAYNIGHT_IMAGE_HELPER_PATH":    "/opt/daynight/media/image-validation-helper.js",
		"DAYNIGHT_IMAGE_MANIFEST_PATH":  "/opt/daynight/media/image-validation-manifest.json",
		"DAYNIGHT_IMAGE_TEMP_DIRECTORY": "/var/lib/daynight/image-validation",
	}
	c, err = LoadConfig(configEnvironment(values))
	if err != nil || c.ImageDecoder.NodePath != values["DAYNIGHT_IMAGE_NODE_PATH"] || c.ImageDecoder.HelperPath != values["DAYNIGHT_IMAGE_HELPER_PATH"] || c.ImageDecoder.ManifestPath != values["DAYNIGHT_IMAGE_MANIFEST_PATH"] || c.ImageDecoder.TemporaryDirectory != values["DAYNIGHT_IMAGE_TEMP_DIRECTORY"] {
		t.Fatalf("explicit decoder configuration: %+v %v", c, err)
	}
	for field := range values {
		for _, invalid := range []string{"", "relative/path", "/absolute/../path", "/absolute/line\nbreak"} {
			copy := make(map[string]string, len(values))
			for k, v := range values {
				copy[k] = v
			}
			copy[field] = invalid
			_, err := LoadConfig(configEnvironment(copy))
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != field {
				t.Fatalf("accepted invalid %s: %v", field, err)
			}
		}
	}
}

func TestEnvironmentDecodingPreservesErrorOrder(t *testing.T) {
	_, err := LoadConfig(configEnvironment(map[string]string{
		"DAYNIGHT_TASK_SYNC_OVERLAP":      "invalid",
		"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "invalid",
	}))
	var failure *configvalue.ConfigurationError
	if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_TASK_SYNC_OVERLAP" {
		t.Fatalf("task sync duration must be decoded before the HTTP flag: %v", err)
	}
}
