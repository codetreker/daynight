package config

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"testing"
)

func TestPreviewOriginLayersAndFailureProvenance(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase)
	writeLayer(t, root, "config.local.yml", "server:\n  preview_origin: https://files.daynight.example\n")
	c, err := LoadServer(root, lookupValues(nil))
	if err != nil || c.Server.PreviewOrigin != "https://files.daynight.example" {
		t.Fatalf("local preview origin: %+v %v", c.Server, err)
	}
	c, err = LoadServer(root, lookupValues(map[string]string{"DAYNIGHT_PREVIEW_ORIGIN": "https://documents.daynight.example"}))
	if err != nil || c.Server.PreviewOrigin != "https://documents.daynight.example" {
		t.Fatalf("environment preview origin: %+v %v", c.Server, err)
	}
	for _, tc := range []struct {
		value, source string
		environment   bool
	}{
		{"", "config.local.yml", false}, {"https://preview.external.example", "config.local.yml", false},
		{"", "environment", true}, {"https://preview.external.example", "environment", true},
	} {
		values := map[string]string{}
		if tc.environment {
			values["DAYNIGHT_PREVIEW_ORIGIN"] = tc.value
		} else {
			writeLayer(t, root, "config.local.yml", "server:\n  preview_origin: '"+tc.value+"'\n")
		}
		_, err := LoadServer(root, lookupValues(values))
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "server.preview_origin" || failure.Origin.Source != tc.source || failure.Phase != "validate" {
			t.Fatalf("preview source lost: %#v", err)
		}
		if tc.environment && failure.Origin.EnvName != "DAYNIGHT_PREVIEW_ORIGIN" {
			t.Fatalf("preview environment source lost: %+v", failure.Origin)
		}
	}
}
