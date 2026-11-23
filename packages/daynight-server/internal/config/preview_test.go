package config

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
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

func TestPreviewOriginHostnameFailureProvenance(t *testing.T) {
	for _, source := range []string{"config.local.yml", "environment"} {
		for _, tc := range []struct {
			name, main, preview, field, variable string
		}{
			{"main hostname", "http://private-main:8787", "http://preview.daynight.localhost:8787", "server.public_origin", "DAYNIGHT_PUBLIC_ORIGIN"},
			{"preview hostname", "http://app.daynight.localhost:8787", "http://private-preview:8787", "server.preview_origin", "DAYNIGHT_PREVIEW_ORIGIN"},
			{"both localhost", "http://localhost:8787", "http://localhost:8787", "server.public_origin", "DAYNIGHT_PUBLIC_ORIGIN"},
			{"same hostname", "http://app.daynight.localhost:8787", "http://app.daynight.localhost:8787", "server.preview_origin", "DAYNIGHT_PREVIEW_ORIGIN"},
			{"same hostname different ports", "http://app.daynight.localhost:8787", "http://app.daynight.localhost:8788", "server.preview_origin", "DAYNIGHT_PREVIEW_ORIGIN"},
		} {
			t.Run(source+"/"+tc.name, func(t *testing.T) {
				root := t.TempDir()
				writeLayer(t, root, "config.yml", validBase)
				callback := tc.main + "/auth/callback"
				values := map[string]string{}
				if source == "environment" {
					values = map[string]string{
						"DAYNIGHT_PUBLIC_ORIGIN":          tc.main,
						"DAYNIGHT_PREVIEW_ORIGIN":         tc.preview,
						"DAYNIGHT_UNIAUTH_CALLBACK_URL":   callback,
						"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1",
					}
				} else {
					writeLayer(t, root, source, fmt.Sprintf("server:\n  public_origin: %s\n  preview_origin: %s\n  allow_http_test_origin: true\nuniauth:\n  callback_url: %s\n", tc.main, tc.preview, callback))
				}
				_, err := LoadServer(root, lookupValues(values))
				var failure *configvalue.ConfigurationError
				if !errors.As(err, &failure) || failure.Field != tc.field || failure.Phase != "validate" || failure.Origin.Source != source {
					t.Fatalf("hostname failure attribution: %#v", err)
				}
				if source == "environment" {
					if failure.Origin.EnvName != tc.variable {
						t.Fatalf("hostname environment source: %+v", failure.Origin)
					}
				} else {
					line := 3
					if tc.field == "server.public_origin" {
						line = 2
					}
					if failure.Origin.Line != line || failure.Origin.Column <= 0 {
						t.Fatalf("hostname YAML source position: %+v", failure.Origin)
					}
				}
				for _, value := range []string{tc.main, tc.preview, callback, "private-main", "private-preview"} {
					if strings.Contains(err.Error(), value) {
						t.Fatalf("hostname diagnosis exposes configured value: %v", err)
					}
				}
			})
		}
	}
}
