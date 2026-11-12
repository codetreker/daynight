package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestS2SAllowedOriginLayering(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase+"s2s:\n  allowed_origin: https://base.example\n")
	writeLayer(t, root, "config.local.yml", "s2s:\n  allowed_origin: https://local.example\n")
	for _, tc := range []struct {
		values map[string]string
		want   string
	}{
		{nil, "https://local.example"},
		{map[string]string{"DAYNIGHT_S2S_ALLOWED_ORIGIN": "https://env.example"}, "https://env.example"},
		{map[string]string{"DAYNIGHT_S2S_ALLOWED_ORIGIN": ""}, ""},
	} {
		c, err := LoadServer(root, lookupValues(tc.values))
		if err != nil || c.S2S.AllowedOrigin != tc.want {
			t.Fatalf("allowed origin=%q want=%q: %v", c.S2S.AllowedOrigin, tc.want, err)
		}
	}
	writeLayer(t, root, "config.local.yml", "s2s:\n  allowed_origin: \"\"\n")
	c, err := LoadServer(root, lookupValues(nil))
	if err != nil || c.S2S.AllowedOrigin != "" {
		t.Fatalf("explicit empty local YAML: %+v %v", c.S2S, err)
	}
}

func TestS2SAllowedOriginStartupValidation(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase+"s2s:\n  allowed_origin: https://private.example/path\n")
	_, err := LoadServer(root, lookupValues(nil))
	var failure *configvalue.ConfigurationError
	if !errors.As(err, &failure) || failure.Field != "s2s.allowed_origin" || failure.Phase != "validate" || failure.Origin.Source != "config.yml" || failure.Origin.Line != 11 || strings.Contains(err.Error(), "private.example") {
		t.Fatalf("YAML validation origin: %#v %v", failure, err)
	}
	_, err = LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_S2S_ALLOWED_ORIGIN": "http://localhost:9000"}))
	if !errors.As(err, &failure) || failure.Origin.EnvName != "DAYNIGHT_S2S_ALLOWED_ORIGIN" || failure.Field != "s2s.allowed_origin" {
		t.Fatalf("HTTP origin without test gate: %#v %v", failure, err)
	}
	c, err := LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_S2S_ALLOWED_ORIGIN": "http://localhost:9000", "DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1"}))
	if err != nil || c.S2S.AllowedOrigin != "http://localhost:9000" {
		t.Fatalf("explicit loopback test origin: %+v %v", c.S2S, err)
	}
	_, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_S2S_ALLOWED_ORIGIN": "https://private.example/path"}))
	if !errors.As(err, &failure) || failure.Field != "allowed_origin" {
		t.Fatalf("legacy configuration validation: %v", err)
	}
	c, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_S2S_ALLOWED_ORIGIN": "https://client.example"}))
	if err != nil || c.S2S.AllowedOrigin != "https://client.example" {
		t.Fatalf("environment configuration: %+v %v", c.S2S, err)
	}
}

func TestS2SSharedKeyLayering(t *testing.T) {
	root := t.TempDir()
	baseKey, localKey, envKey := strings.Repeat("B", 32), strings.Repeat("L", 64), strings.Repeat("E", 256)
	writeLayer(t, root, "config.yml", validBase+"s2s:\n  shared_key: "+baseKey+"\n  allowed_origin: https://base.example\n")
	writeLayer(t, root, "config.local.yml", "s2s:\n  shared_key: "+localKey+"\n")
	for _, tc := range []struct {
		name   string
		values map[string]string
		want   string
	}{
		{"local", nil, localKey},
		{"environment", map[string]string{"DAYNIGHT_S2S_SHARED_KEY": envKey}, envKey},
		{"empty environment", map[string]string{"DAYNIGHT_S2S_SHARED_KEY": ""}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := LoadServer(root, lookupValues(tc.values))
			if err != nil || c.S2S.SharedKey != tc.want || c.S2S.AllowedOrigin != "https://base.example" {
				t.Fatalf("shared key layering failed: %v", err)
			}
		})
	}
	writeLayer(t, root, "config.local.yml", "s2s:\n  shared_key: \"\"\n")
	c, err := LoadServer(root, lookupValues(nil))
	if err != nil || c.S2S.SharedKey != "" {
		t.Fatalf("explicit empty YAML failed: %v", err)
	}
}

func TestS2SSharedKeyStartupValidation(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase)
	for _, tc := range []struct {
		name, key string
		valid     bool
	}{
		{"disabled", "", true}, {"minimum", strings.Repeat("!", 32), true},
		{"maximum", strings.Repeat("~", 256), true}, {"no prefix", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", true},
		{"short", strings.Repeat("k", 31), false}, {"long", strings.Repeat("k", 257), false},
		{"space", strings.Repeat("k", 31) + " ", false}, {"tab", strings.Repeat("k", 31) + "\t", false},
		{"control", strings.Repeat("k", 31) + "\x00", false}, {"del", strings.Repeat("k", 31) + "\x7f", false},
		{"non ASCII", strings.Repeat("k", 31) + "é", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_S2S_SHARED_KEY": tc.key}))
			if tc.valid {
				if err != nil {
					t.Fatalf("valid key rejected: %v", err)
				}
				return
			}
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != "s2s.shared_key" || failure.Phase != "validate" || failure.Origin.EnvName != "DAYNIGHT_S2S_SHARED_KEY" || strings.Contains(err.Error(), tc.key) {
				t.Fatalf("invalid shared key diagnostic: %#v %v", failure, err)
			}
		})
	}
	writeLayer(t, root, "config.yml", validBase+"s2s:\n  shared_key: do-not-expose-this-secret\n")
	_, err := LoadServer(root, lookupValues(nil))
	var failure *configvalue.ConfigurationError
	if !errors.As(err, &failure) || failure.Field != "s2s.shared_key" || failure.Origin.Source != "config.yml" || failure.Origin.Line != 11 || strings.Contains(err.Error(), "do-not-expose") {
		t.Fatalf("YAML key diagnostic: %#v %v", failure, err)
	}
	_, err = LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_S2S_SHARED_KEY": "not-valid"}))
	if !errors.As(err, &failure) || failure.Field != "shared_key" {
		t.Fatalf("legacy config validation: %v", err)
	}
	c, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_S2S_SHARED_KEY": strings.Repeat("x", 32)}))
	if err != nil || c.S2S.SharedKey != strings.Repeat("x", 32) {
		t.Fatalf("legacy shared key config: %v", err)
	}
}
