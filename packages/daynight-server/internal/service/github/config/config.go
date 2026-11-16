// Package config parses GitHub App private keys.
package config

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

// ParsePrivateKey parses exactly one RSA PEM block without exposing its contents
// in errors. Callers must enforce any input size limit before calling it.
func ParsePrivateKey(data []byte) (*rsa.PrivateKey, error) {
	invalid := func(rule string) error { return &configvalue.ConfigurationError{Field: "private_key_file", Rule: rule} }
	data = []byte(strings.TrimSpace(string(data)))
	text := string(data)
	var begin, end string
	switch {
	case strings.HasPrefix(text, "-----BEGIN RSA PRIVATE KEY-----"):
		begin, end = "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"
	case strings.HasPrefix(text, "-----BEGIN PRIVATE KEY-----"):
		begin, end = "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"
	default:
		return nil, invalid("must contain one RSA private key PEM")
	}
	closeAt := strings.Index(text[len(begin):], end)
	if closeAt < 0 || strings.Contains(text[len(begin):len(begin)+closeAt], "-----BEGIN ") {
		return nil, invalid("must contain one RSA private key PEM")
	}
	block, rest := pem.Decode(data)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, invalid("must contain one RSA private key PEM")
	}
	var key *rsa.PrivateKey
	var err error
	switch block.Type {
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "PRIVATE KEY":
		var parsed any
		parsed, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		if err == nil {
			var ok bool
			key, ok = parsed.(*rsa.PrivateKey)
			if !ok {
				return nil, invalid("must contain an RSA private key")
			}
		}
	default:
		return nil, invalid("must contain an RSA private key")
	}
	if err != nil || key == nil || key.Validate() != nil {
		return nil, invalid("must contain a valid RSA private key")
	}
	return key, nil
}
