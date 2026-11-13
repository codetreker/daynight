package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrivateKeyFormatsAndRefusals(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaPKCS8, err := x509.MarshalPKCS8PrivateKey(rsaKey)
	if err != nil {
		t.Fatal(err)
	}
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecPKCS8, err := x509.MarshalPKCS8PrivateKey(ec)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, kind string
		data       []byte
		suffix     string
		valid      bool
	}{
		{"rsa-pkcs1", "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(rsaKey), "", true},
		{"rsa-pkcs8", "PRIVATE KEY", rsaPKCS8, "", true},
		{"ec-pkcs8", "PRIVATE KEY", ecPKCS8, "", false},
		{"wrong-label", "CERTIFICATE", rsaPKCS8, "", false},
		{"corrupt-key", "RSA PRIVATE KEY", []byte("private-secret"), "", false},
		{"trailing-data", "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(rsaKey), "private-secret", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "key.pem")
			content := append(pem.EncodeToMemory(&pem.Block{Type: tc.kind, Bytes: tc.data}), []byte(tc.suffix)...)
			if err := os.WriteFile(path, content, 0600); err != nil {
				t.Fatal(err)
			}
			key, err := (Config{PrivateKeyFile: path}).PrivateKey()
			if tc.valid {
				if err != nil || key.N.Cmp(rsaKey.N) != 0 {
					t.Fatalf("valid key: %v", err)
				}
			} else if err == nil || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("invalid or exposed: %v", err)
			}
		})
	}
	if _, err := (Config{PrivateKeyFile: filepath.Join(t.TempDir(), "missing")}).PrivateKey(); err == nil {
		t.Fatal("missing key accepted")
	}
}

func TestEnvironmentValidation(t *testing.T) {
	for _, tc := range []struct{ env, value, field string }{
		{"DAYNIGHT_GITHUB_ENABLED", "true", "enabled"},
		{"DAYNIGHT_GITHUB_APP_ID", "01", "app_id"},
		{"DAYNIGHT_GITHUB_APP_ID", "-1", "app_id"},
	} {
		var c Config
		marks := map[string]string{}
		err := c.ApplyEnvironment(func(k string) (string, bool) { return tc.value, k == tc.env }, func(field, variable string) { marks[field] = variable })
		if err == nil || marks[tc.field] != tc.env {
			t.Fatalf("invalid %s accepted or unmarked: %v", tc.env, err)
		}
	}
	var c Config
	values := map[string]string{"DAYNIGHT_GITHUB_ENABLED": "1", "DAYNIGHT_GITHUB_APP_ID": "42", "DAYNIGHT_GITHUB_PRIVATE_KEY_FILE": "app.pem", "DAYNIGHT_GITHUB_WEBHOOK_SECRET": "secret"}
	if err := c.ApplyEnvironment(func(k string) (string, bool) { v, ok := values[k]; return v, ok }, func(string, string) {}); err != nil || !c.Enabled || c.AppID != 42 || c.PrivateKeyFile != "app.pem" || c.WebhookSecret != "secret" {
		t.Fatalf("overrides: %v", err)
	}
}
