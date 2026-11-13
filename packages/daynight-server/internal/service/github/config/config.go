// Package config owns the GitHub App deployment settings.
package config

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	Enabled        bool   `yaml:"enabled"`
	AppID          int64  `yaml:"app_id"`
	PrivateKeyFile string `yaml:"private_key_file"`
	WebhookSecret  string `yaml:"webhook_secret"`
}

type Patch struct {
	Enabled        *bool   `yaml:"enabled"`
	AppID          *int64  `yaml:"app_id"`
	PrivateKeyFile *string `yaml:"private_key_file"`
	WebhookSecret  *string `yaml:"webhook_secret"`
}

func DefaultConfig() Config { return Config{} }
func (p Patch) ApplyTo(c *Config) error {
	if p.Enabled != nil {
		c.Enabled = *p.Enabled
	}
	if p.AppID != nil {
		c.AppID = *p.AppID
	}
	if p.PrivateKeyFile != nil {
		c.PrivateKeyFile = *p.PrivateKeyFile
	}
	if p.WebhookSecret != nil {
		c.WebhookSecret = *p.WebhookSecret
	}
	return nil
}
func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(string, string)) error {
	if v, ok := lookup("DAYNIGHT_GITHUB_ENABLED"); ok {
		mark("enabled", "DAYNIGHT_GITHUB_ENABLED")
		b, err := configvalue.Flag(v, "enabled")
		if err != nil {
			return err
		}
		c.Enabled = b
	}
	if v, ok := lookup("DAYNIGHT_GITHUB_APP_ID"); ok {
		mark("app_id", "DAYNIGHT_GITHUB_APP_ID")
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 || strconv.FormatInt(n, 10) != v {
			return &configvalue.ConfigurationError{Field: "app_id", Rule: "must be a positive decimal integer"}
		}
		c.AppID = n
	}
	for _, item := range []struct {
		field, variable string
		target          *string
	}{
		{"private_key_file", "DAYNIGHT_GITHUB_PRIVATE_KEY_FILE", &c.PrivateKeyFile},
		{"webhook_secret", "DAYNIGHT_GITHUB_WEBHOOK_SECRET", &c.WebhookSecret},
	} {
		if v, ok := lookup(item.variable); ok {
			mark(item.field, item.variable)
			*item.target = v
		}
	}
	return nil
}
func (c *Config) ResolvePaths(root string) error {
	if c.PrivateKeyFile != "" {
		c.PrivateKeyFile = configvalue.ResolvePath(root, c.PrivateKeyFile)
	}
	return nil
}

// PrivateKey parses and validates an RSA PEM file without exposing its contents in errors.
func (c Config) PrivateKey() (*rsa.PrivateKey, error) {
	invalid := func(rule string) error { return &configvalue.ConfigurationError{Field: "private_key_file", Rule: rule} }
	data, err := os.ReadFile(c.PrivateKeyFile)
	if err != nil {
		return nil, invalid("cannot be read")
	}
	block, rest := pem.Decode(data)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, invalid("must contain one RSA private key PEM")
	}
	var key *rsa.PrivateKey
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
func (c Config) Validate() error {
	if !c.Enabled {
		return nil
	}
	if c.AppID <= 0 {
		return &configvalue.ConfigurationError{Field: "app_id", Rule: "must be a positive integer when GitHub is enabled"}
	}
	if strings.TrimSpace(c.PrivateKeyFile) == "" {
		return &configvalue.ConfigurationError{Field: "private_key_file", Rule: "is required when GitHub is enabled"}
	}
	if strings.TrimSpace(c.WebhookSecret) == "" {
		return &configvalue.ConfigurationError{Field: "webhook_secret", Rule: "is required when GitHub is enabled"}
	}
	_, err := c.PrivateKey()
	return err
}
