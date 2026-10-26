package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func configuredTestConfig() Config {
	return Config{
		DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0",
		StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second,
		PublicOrigin: "https://daynight.example", UniAuthURL: "https://auth.example",
		UniAuthAppID: "configuration-test", UniAuthAppSecret: "configuration-test",
		UniAuthCallbackURL: "https://daynight.example/api/v1/auth/callback",
	}
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
	if err != nil || config.StorageRoot != "storage" || config.ListenAddress != "127.0.0.1:8787" || config.StartupTimeout != 10*time.Second || config.ShutdownTimeout != 10*time.Second || config.TaskSyncOverlap != 10*time.Second {
		t.Fatalf("unexpected defaults: %+v, %v", config, err)
	}
	config, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_LISTEN_ADDR": "[::1]:0"}))
	if err != nil || config.ListenAddress != "[::1]:0" {
		t.Fatalf("IPv6 loopback rejected: %+v, %v", config, err)
	}
	for value, want := range map[string]time.Duration{"250ms": 250 * time.Millisecond, "30s": 30 * time.Second, "1m30s": 90 * time.Second, "1ns": time.Nanosecond} {
		config, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_TASK_SYNC_OVERLAP": value}))
		if err != nil || config.TaskSyncOverlap != want {
			t.Fatalf("explicit task sync overlap %s ignored: %+v %v", value, config, err)
		}
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
	if err != nil || config.StartupTimeout != 2*time.Second || config.ShutdownTimeout != 300*time.Millisecond {
		t.Fatalf("explicit durations ignored: %+v %v", config, err)
	}
	for _, address := range []string{"localhost:80", ":80", "0.0.0.0:80", "[::]:80", "192.0.2.1:80", "[::1%eth0]:80", "127.0.0.1", "127.0.0.1:word", "127.0.0.1:-1", "127.0.0.1:65536", "127.0.0.1:080"} {
		t.Run(address, func(t *testing.T) {
			config := configuredTestConfig()
			config.DatabaseURL = "postgres://secret"
			config.ListenAddress = address
			if err := config.Validate(); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("expected safe validation error: %v", err)
			}
		})
	}
	for _, invalid := range []struct {
		name   string
		change func(*Config)
	}{
		{"missing database", func(config *Config) { config.DatabaseURL = "" }},
		{"blank database", func(config *Config) { config.DatabaseURL = " " }},
		{"missing startup timeout", func(config *Config) { config.StartupTimeout = 0 }},
		{"negative shutdown timeout", func(config *Config) { config.ShutdownTimeout = -time.Second }},
		{"missing task sync overlap", func(config *Config) { config.TaskSyncOverlap = 0 }},
		{"negative task sync overlap", func(config *Config) { config.TaskSyncOverlap = -time.Second }},
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
	config.StorageRoot = "a/root/that/does/not/exist"
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
	if err != nil || !config.AllowHTTPTestOrigin || !config.AllowLoopbackHTTP || config.UniAuthCallbackURL != "http://app.daynight.test:8080/auth/callback" {
		t.Fatalf("explicit test origin and gateway settings rejected: %+v %v", config, err)
	}
	config, err = LoadConfig(configEnvironment(map[string]string{
		"DAYNIGHT_PUBLIC_ORIGIN": "https://daynight.example",
		"DAYNIGHT_UNIAUTH_URL":   "http://127.0.0.1:8081", "DAYNIGHT_ALLOW_LOOPBACK_HTTP": "1",
	}))
	if err != nil || config.AllowHTTPTestOrigin || !config.AllowLoopbackHTTP {
		t.Fatalf("HTTPS primary origin and explicit numeric-loopback gateway rejected: %+v %v", config, err)
	}
}

func TestInvalidAppCredentialConfigurationPrecedesResourceOpening(t *testing.T) {
	const invalidAppID = "private:invalid-app-id"
	const secret = "credential-not-for-diagnostics"
	config := configuredTestConfig()
	config.UniAuthAppID, config.UniAuthAppSecret = invalidAppID, secret
	config.DatabaseURL = "invalid-database-configuration"
	config.StorageRoot = filepath.Join(testStorageRoot(t), "unopened-auth-storage")
	_, loadErr := LoadConfig(configEnvironment(map[string]string{
		"DAYNIGHT_UNIAUTH_APP_ID":     invalidAppID,
		"DAYNIGHT_UNIAUTH_APP_SECRET": secret,
	}))
	validateErr := config.Validate()
	factoryCalled := false
	runtime, startErr := Start(context.Background(), config, testLogger(), func(Dependencies) (http.Handler, error) {
		factoryCalled = true
		return http.NotFoundHandler(), nil
	})
	if runtime != nil || factoryCalled {
		t.Fatal("invalid App credentials reached runtime composition")
	}
	for _, err := range []error{loadErr, validateErr, startErr} {
		var failure *ConfigurationError
		if !errors.As(err, &failure) || !strings.Contains(failure.Field, "DAYNIGHT_UNIAUTH_APP_ID") {
			t.Fatalf("App credential syntax did not retain a configuration error: %v", err)
		}
		cause := errors.Unwrap(failure)
		if cause == nil || !strings.Contains(cause.Error(), "App ID") {
			t.Fatalf("SDK credential validation cause was lost: %v", err)
		}
		for _, message := range []string{err.Error(), cause.Error()} {
			if strings.Contains(message, invalidAppID) || strings.Contains(message, secret) {
				t.Fatal("configuration diagnostics exposed credential values")
			}
		}
	}
	if _, err := os.Stat(config.StorageRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid authentication configuration touched storage: %v", err)
	}
}

func TestSetupGuideCallbackConflictsPrecedeResourceOpening(t *testing.T) {
	for _, callbackPath := range []string{"/setup", "/setup/callback", "/setup/nested/callback"} {
		t.Run(callbackPath, func(t *testing.T) {
			config := configuredTestConfig()
			config.UniAuthCallbackURL = config.PublicOrigin + callbackPath
			config.DatabaseURL = "invalid-database-configuration"
			config.StorageRoot = filepath.Join(testStorageRoot(t), "unopened-setup-storage")
			_, loadErr := LoadConfig(configEnvironment(map[string]string{
				"DAYNIGHT_UNIAUTH_CALLBACK_URL": config.UniAuthCallbackURL,
			}))
			validateErr := config.Validate()
			handler, compositionErr := New(Dependencies{}, config, testLogger())
			factoryCalled := false
			runtime, startErr := Start(context.Background(), config, testLogger(), func(Dependencies) (http.Handler, error) {
				factoryCalled = true
				return http.NotFoundHandler(), nil
			})
			if handler != nil || runtime != nil || factoryCalled {
				t.Fatal("conflicting setup callback reached route or runtime composition")
			}
			for _, err := range []error{loadErr, validateErr, compositionErr, startErr} {
				var failure *ConfigurationError
				if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_UNIAUTH_CALLBACK_URL" || failure.Rule != "must not overlap an application API, page, asset, or health route" {
					t.Fatalf("setup callback conflict lost configuration diagnosis: %v", err)
				}
			}
			if _, err := os.Stat(config.StorageRoot); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("conflicting setup callback touched storage: %v", err)
			}
		})
	}
}

func TestSetupGuideCallbackReservationPreservesDistinctPaths(t *testing.T) {
	for _, callbackPath := range []string{"/auth/callback", "/setup-callback", "/setupcallback", "/auth/setup/callback"} {
		t.Run(callbackPath, func(t *testing.T) {
			config, err := LoadConfig(configEnvironment(map[string]string{
				"DAYNIGHT_UNIAUTH_CALLBACK_URL": "https://daynight.example" + callbackPath,
			}))
			if err != nil {
				t.Fatalf("distinct callback path rejected: %v", err)
			}
			handler, err := New(Dependencies{}, config, testLogger())
			if err != nil || handler == nil {
				t.Fatalf("distinct callback path failed route composition: %v", err)
			}
		})
	}
}
