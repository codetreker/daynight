package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
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
			content := append(pem.EncodeToMemory(&pem.Block{Type: tc.kind, Bytes: tc.data}), []byte(tc.suffix)...)
			key, err := ParsePrivateKey(content)
			if tc.valid {
				if err != nil || key.N.Cmp(rsaKey.N) != 0 {
					t.Fatalf("valid key: %v", err)
				}
			} else if err == nil || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("invalid or exposed: %v", err)
			}
		})
	}
}

func TestParsePrivateKeyStrictContent(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	parsed, err := ParsePrivateKey([]byte(" \n" + encoded + "\n "))
	if err != nil || parsed.N.Cmp(key.N) != 0 {
		t.Fatalf("valid PEM: %v", err)
	}
	for _, input := range []string{
		"secret-prefix\n" + encoded,
		encoded + "secret-suffix",
		encoded + encoded,
		"-----BEGIN RSA PRIVATE KEY-----\ncorrupt\n" + encoded,
	} {
		if _, err = ParsePrivateKey([]byte(input)); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("extra or invalid content accepted or exposed: %v", err)
		}
	}
}
