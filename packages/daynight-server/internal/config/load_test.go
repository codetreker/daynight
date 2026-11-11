package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func writeLayer(t *testing.T, root, name, content string) {
	t.Helper()
	dir := filepath.Join(root, "config")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
func lookupValues(values map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := values[k]; return v, ok }
}

const validBase = `server:
  public_origin: https://daynight.example
database:
  url: postgres://db
uniauth:
  url: https://auth.example
  app_id: daynight
  app_secret: test-secret
  callback_url: https://daynight.example/auth/callback
`

func TestLayeredFilesAndOverrides(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase+`storage:
  root: data/link/../storage
server_extra: {ignored: value}
monitoring:
  redis_url: redis://localhost:6379
mcp:
  allowed_origins: [https://client.example]
  reserved_free_bytes: 123
webhook:
  enabled: true
`)
	writeLayer(t, root, "config.local.yml", `mcp:
  allowed_origins: []
  reserved_free_bytes: 0
monitoring:
  redis_url: ""
webhook:
  enabled: false
`)
	c, err := LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_STARTUP_TIMEOUT": "2s"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Storage.Root != root+"/data/link/../storage" || c.Monitoring.Redis.RedisURL != "" || c.Webhook.Enabled || c.MCP.Transfer.ReservedFreeBytes != 0 || len(c.MCP.Origins.AllowedOrigins) != 0 || c.Server.StartupTimeout != 2*time.Second || !c.LocalOverrideLoaded {
		t.Fatalf("unexpected merged config: %+v", c)
	}
	if _, err := os.Stat(filepath.Join(root, "data")); !os.IsNotExist(err) {
		t.Fatal("loading created storage")
	}
}
func TestInvalidYAMLNeverHiddenByLaterLayers(t *testing.T) {
	for _, tc := range []struct{ name, base, field string }{
		{"duplicate_unknown", "unknown: {secret: 1, secret: 2}", ""},
		{"duplicate_quoted", "unknown: {a: 1, 'a': 2}", ""},
		{"duplicate_numeric", "unknown: {1: a, 0x1: b}", ""},
		{"wrong_scalar", "webhook: {enabled: 'false'}", "webhook.enabled"},
		{"alias_wrong", "x: &bad 'false'\nwebhook: {enabled: *bad}", "webhook.enabled"},
		{"merge_wrong", "x: &bad {enabled: 'false'}\nwebhook: {<<: *bad}", "webhook.enabled"},
		{"null", "database: {url: null}", "database.url"},
		{"wrong_list", "mcp: {allowed_origins: [1]}", "mcp.allowed_origins"},
		{"noncanonical_integer", "mcp: {reserved_free_bytes: 0x10}", "mcp.reserved_free_bytes"},
		{"unknown_tag", "database: {url: !private abc}", "database.url"},
		{"duration", "server: {startup_timeout: no-unit}", "server.startup_timeout"},
		{"duration_unitless_zero", "server: {startup_timeout: '0'}", "server.startup_timeout"},
		{"extra_document", "{}\n---\n{}", ""},
		{"syntax", "secret: [private-secret", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeLayer(t, root, "config.yml", tc.base)
			writeLayer(t, root, "config.local.yml", validBase)
			_, err := LoadServer(root, lookupValues(nil))
			var f *configvalue.ConfigurationError
			if !errors.As(err, &f) || f.Phase != "decode" || f.Origin.Source != "config.yml" || f.Field != tc.field || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("failure %#v cause: %v", err, errors.Unwrap(err))
			}
		})
	}
}
func TestMergeAndAliasKeepEffectiveValueAndPosition(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase+`defaults: &defaults
  enabled: "not a boolean"
webhook:
  <<: *defaults
  enabled: false
`)
	c, err := LoadServer(root, lookupValues(nil))
	if err != nil || c.Webhook.Enabled {
		t.Fatalf("merge: %+v %v", c, err)
	}
	writeLayer(t, root, "config.yml", validBase+`invalid: &negative 0
mcp:
  temp_budget_bytes: *negative
`)
	_, err = LoadServer(root, lookupValues(nil))
	var f *configvalue.ConfigurationError
	if !errors.As(err, &f) || f.Field != "mcp.temp_budget_bytes" || f.Origin.Source != "config.yml" || f.Origin.Line != 10 {
		t.Fatalf("alias origin: %#v", err)
	}
}
func TestStorageVerificationOnlyUsesDatabaseAndStorage(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", `database: {url: postgres://db}
storage: {root: data}
uniauth: {url: ""}
server: {public_origin: ""}
`)
	c, err := LoadStorageVerification(root, lookupValues(map[string]string{"DAYNIGHT_WEBHOOK_ENABLED": "invalid", "DAYNIGHT_UNIAUTH_URL": "invalid"}))
	if err != nil || c.Storage.Root != root+"/data" || c.Database.URL != "postgres://db" {
		t.Fatalf("minimal verification: %+v %v", c, err)
	}
	writeLayer(t, root, "config.local.yml", "server: {startup_timeout: bad}\n")
	if _, err = LoadStorageVerification(root, lookupValues(nil)); err == nil {
		t.Fatal("invalid unused field accepted")
	}
}
func TestEmptyMissingAndReadFailures(t *testing.T) {
	for _, body := range []string{"", "# comment\n", "{}"} {
		t.Run(body, func(t *testing.T) {
			root := t.TempDir()
			writeLayer(t, root, "config.yml", body)
			c, err := LoadStorageVerification(root, lookupValues(map[string]string{"DAYNIGHT_DATABASE_URL": "db"}))
			if err != nil || c.Storage.Root != root+"/storage" {
				t.Fatalf("empty: %+v %v", c, err)
			}
		})
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing", filepath.Join(root, "config", "config.yml")); err != nil {
		t.Fatal(err)
	}
	_, err := LoadStorageVerification(root, lookupValues(nil))
	var f *configvalue.ConfigurationError
	if !errors.As(err, &f) || f.Phase != "read" || !errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), root) {
		t.Fatalf("read error: %#v", err)
	}
}
func TestEnvironmentErrorOriginAndEmptyValue(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase)
	_, err := LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_WEBHOOK_ENABLED": ""}))
	var f *configvalue.ConfigurationError
	if !errors.As(err, &f) || f.Field != "webhook.enabled" || f.Phase != "override" || f.Origin.Source != "environment" || f.Origin.EnvName != "DAYNIGHT_WEBHOOK_ENABLED" {
		t.Fatalf("override: %#v", err)
	}
}

func TestRootPreservesSymlinkTraversal(t *testing.T) {
	parent := t.TempDir()
	real := filepath.Join(parent, "real", "child")
	if err := os.MkdirAll(real, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(parent, "link")); err != nil {
		t.Fatal(err)
	}
	physical := filepath.Join(parent, "real")
	writeLayer(t, physical, "config.yml", "database: {url: postgres://db}\n")
	root := filepath.Join(parent, "link") + "/.."
	c, err := LoadStorageVerification(root, lookupValues(nil))
	if err != nil || c.Database.URL != "postgres://db" || c.Storage.Root != root+"/storage" {
		t.Fatalf("root traversal: %+v %v", c, err)
	}
}

func TestAllYAMLFields(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", `server:
  listen_address: 127.0.0.1:0
  public_origin: https://daynight.example
  startup_timeout: 2s
  shutdown_timeout: 3s
  allow_http_test_origin: false
database: {url: "postgres://db"}
storage: {root: data}
monitoring: {redis_url: "redis://localhost:6379", metrics_listen_address: "127.0.0.1:0"}
uniauth:
  url: https://auth.example
  app_id: daynight
  app_secret: test-secret
  callback_url: https://daynight.example/auth/callback
  allow_loopback_http: false
mcp:
  allowed_origins: [https://client.example]
  temp_budget_bytes: 4096
  reserved_free_bytes: 0
oauth:
  preregistered_clients:
    app:
      client_id: app
      redirect_uris: [https://client.example/callback]
      extension: null
webhook: {enabled: true}
task_sync: {overlap: 12s}
image_decoder: {node_path: bin/node, helper_path: image/helper.js, manifest_path: image/manifest.json, temporary_directory: tmp}
`)
	c, err := LoadServer(root, lookupValues(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Server.ListenAddress != "127.0.0.1:0" || c.Server.PublicOrigin != "https://daynight.example" || c.Server.StartupTimeout != 2*time.Second || c.Server.ShutdownTimeout != 3*time.Second || c.Server.AllowHTTPTestOrigin || c.Database.URL != "postgres://db" || c.Storage.Root != root+"/data" || c.Monitoring.Redis.RedisURL != "redis://localhost:6379" || c.Monitoring.Metrics.MetricsListenAddress != "127.0.0.1:0" || c.UniAuth.URL != "https://auth.example" || c.UniAuth.AppID != "daynight" || c.UniAuth.AppSecret != "test-secret" || c.UniAuth.CallbackURL != "https://daynight.example/auth/callback" || c.UniAuth.AllowLoopbackHTTP || len(c.MCP.Origins.AllowedOrigins) != 1 || c.MCP.Transfer.TempBudgetBytes != 4096 || c.MCP.Transfer.ReservedFreeBytes != 0 || len(c.OAuth.PreregisteredClients["app"]) == 0 || !c.Webhook.Enabled || c.TaskSync.Overlap != 12*time.Second || c.ImageDecoder.NodePath != root+"/bin/node" || c.ImageDecoder.HelperPath != root+"/image/helper.js" || c.ImageDecoder.ManifestPath != root+"/image/manifest.json" || c.ImageDecoder.TemporaryDirectory != root+"/tmp" {
		t.Fatal("a YAML field was not applied")
	}
}

func TestServerSemanticFailureOrigins(t *testing.T) {
	for _, tc := range []struct{ name, layer, field, source, phase string }{
		{"blank storage", "storage: {root: ' '}\n", "storage.root", "config.local.yml", "validate"},
		{"public origin", "server: {public_origin: 'invalid'}\n", "server.public_origin", "config.local.yml", "validate"},
		{"callback", "uniauth: {callback_url: 'https://daynight.example/mcp'}\n", "uniauth.callback_url", "config.local.yml", "validate"},
		{"mcp origin", "mcp: {allowed_origins: ['https://client.example/path']}\n", "mcp.allowed_origins", "config.local.yml", "validate"},
		{"credential", "uniauth: {app_id: 'private:bad'}\n", "uniauth.app_id", "config.local.yml", "validate"},
		{"listener", "server: {listen_address: 'invalid'}\n", "server.listen_address", "config.local.yml", "validate"},
		{"metrics", "monitoring: {metrics_listen_address: 'invalid'}\n", "monitoring.metrics_listen_address", "config.local.yml", "validate"},
		{"timeout", "server: {shutdown_timeout: 11s}\n", "server.shutdown_timeout", "config.local.yml", "validate"},
		{"decoder", "image_decoder: {node_path: bin/node}\n", "image_decoder.helper_path", "defaults", "validate"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeLayer(t, root, "config.yml", validBase)
			writeLayer(t, root, "config.local.yml", tc.layer)
			_, err := LoadServer(root, lookupValues(nil))
			var f *configvalue.ConfigurationError
			if !errors.As(err, &f) || f.Field != tc.field || f.Origin.Source != tc.source || f.Phase != tc.phase {
				t.Fatalf("unexpected failure: %#v", err)
			}
		})
	}
}

func TestCompoundDuplicateKeysInIgnoredYAML(t *testing.T) {
	for _, body := range []string{
		"unknown:\n  ? [a, b]\n  : one\n  ? [a, b]\n  : two\n",
		"unknown:\n  ? {a: 1, b: 2}\n  : one\n  ? {b: 2, a: 1}\n  : two\n",
	} {
		root := t.TempDir()
		writeLayer(t, root, "config.yml", body)
		_, err := LoadStorageVerification(root, lookupValues(nil))
		var f *configvalue.ConfigurationError
		if !errors.As(err, &f) || !strings.Contains(f.Rule, "duplicate") {
			t.Fatalf("duplicate key accepted: %v", err)
		}
	}
}

func TestStorageVerificationChecksUnusedOAuthTypes(t *testing.T) {
	for _, tc := range []struct{ name, yaml string }{
		{"scalar", "oauth: {preregistered_clients: secret}\n"},
		{"null", "oauth: {preregistered_clients: null}\n"},
		{"alias scalar", "bad: &bad secret\noauth: {preregistered_clients: *bad}\n"},
		{"metadata alias tag", "bad: &bad !private secret\noauth: {preregistered_clients: {client: {extension: *bad}}}\n"},
		{"metadata non-json number", "oauth: {preregistered_clients: {client: {extension: .nan}}}\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeLayer(t, root, "config.yml", "database: {url: postgres://db}\n"+tc.yaml)
			_, err := LoadStorageVerification(root, lookupValues(nil))
			var f *configvalue.ConfigurationError
			if !errors.As(err, &f) || f.Phase != "decode" || f.Field != "oauth.preregistered_clients" || f.Origin.Source != "config.yml" || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unexpected OAuth type failure: %#v", err)
			}
		})
	}
	root := t.TempDir()
	writeLayer(t, root, "config.yml", "database: {url: postgres://db}\noauth: {preregistered_clients: {client: {extension: null}}}\n")
	if _, err := LoadStorageVerification(root, lookupValues(nil)); err != nil {
		t.Fatalf("JSON null extension rejected: %v", err)
	}
}
