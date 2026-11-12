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
