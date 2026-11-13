package config

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestGitHubConfigurationLayersAndValidation(t *testing.T) {
	root := t.TempDir()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(root, "app.pem")
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err = os.WriteFile(keyPath, pemBytes, 0600); err != nil {
		t.Fatal(err)
	}
	writeLayer(t, root, "config.yml", validBase+`github:
  enabled: true
  app_id: 7
  private_key_file: app.pem
  webhook_secret: private-secret
`)
	writeLayer(t, root, "config.local.yml", `github:
  app_id: 8
`)
	c, err := LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_GITHUB_APP_ID": "9"}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.GitHub.Enabled || c.GitHub.AppID != 9 || c.GitHub.PrivateKeyFile != keyPath || c.GitHub.WebhookSecret != "private-secret" {
		t.Fatalf("wrong config: %+v", c.GitHub)
	}
	if got, err := c.GitHub.PrivateKey(); err != nil || got.N.Cmp(key.N) != 0 {
		t.Fatalf("invalid loaded key: %v", err)
	}
	for _, tc := range []struct{ name, config, field string }{
		{"unknown", `github: {unexpected: private-secret}`, "github"},
		{"unknown-merge", "github:\n  <<: {unexpected: private-secret}\n", "github"},
		{"id-type", `github: {app_id: '7'}`, "github.app_id"},
		{"id-missing", `github: {enabled: true}`, "github.app_id"},
		{"key-missing", `github: {enabled: true, app_id: 1}`, "github.private_key_file"},
		{"secret-missing", `github: {enabled: true, app_id: 1, private_key_file: app.pem}`, "github.webhook_secret"},
		{"bad-key", `github: {enabled: true, app_id: 1, private_key_file: bad.pem, webhook_secret: private-secret}`, "github.private_key_file"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(root, "bad.pem"), []byte("private-secret"), 0600); err != nil {
				t.Fatal(err)
			}
			writeLayer(t, root, "config.yml", validBase+tc.config+"\n")
			writeLayer(t, root, "config.local.yml", "")
			_, err := LoadServer(root, lookupValues(nil))
			var f *configvalue.ConfigurationError
			if !errors.As(err, &f) || f.Field != tc.field || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("expected safe %s error: %v", tc.field, err)
			}
		})
	}
	writeLayer(t, root, "config.yml", validBase+"github: {enabled: false}\n")
	if _, err := LoadServer(root, lookupValues(nil)); err != nil {
		t.Fatalf("disabled GitHub requires credentials: %v", err)
	}
	_, err = LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_GITHUB_ENABLED": "1", "DAYNIGHT_GITHUB_APP_ID": "not-a-number"}))
	var f *configvalue.ConfigurationError
	if !errors.As(err, &f) || f.Field != "github.app_id" || f.Origin.EnvName != "DAYNIGHT_GITHUB_APP_ID" {
		t.Fatalf("wrong env origin: %v", err)
	}
}
