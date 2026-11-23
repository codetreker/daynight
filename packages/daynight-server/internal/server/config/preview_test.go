package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestPreviewOriginValidation(t *testing.T) {
	for _, preview := range []string{"https://preview.daynight.cc", "https://files.daynight.cc:8443"} {
		if err := (Config{PublicOrigin: "https://daynight.cc", PreviewOrigin: preview}).ValidatePreviewOrigin(); err != nil {
			t.Fatalf("valid preview origin rejected: %v", err)
		}
	}
	for _, preview := range []string{"", "https://daynight.cc", "https://daynight.cc:8443", "https://preview.external.cc", "https://preview.daynight.cc/", "https://preview.daynight.cc?", "https://preview.daynight.cc#private-value", "https://private-value@preview.daynight.cc", "https://PREVIEW.daynight.cc", "https://preview.daynight.cc.", "https://preview.daynight.cc:443", "https://preview.daynight.cc:99999", "https://preview..daynight.cc", "https://" + strings.Repeat("a.", 128) + "cc", "https://preview_.daynight.cc", "https://-preview.daynight.cc", "https://" + strings.Repeat("a", 64) + ".daynight.cc"} {
		err := (Config{PublicOrigin: "https://daynight.cc", PreviewOrigin: preview}).ValidatePreviewOrigin()
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "preview_origin" || strings.Contains(err.Error(), "private-value") {
			t.Fatalf("invalid preview origin diagnosis: %v", err)
		}
	}
	for _, tc := range []struct {
		main, preview string
		test, valid   bool
	}{
		{"https://app.daynight.cc", "https://preview.daynight.cc", false, true},
		{"http://127.0.0.1:8080", "http://127.0.0.1:8081", true, true},
		{"http://[::1]:8080", "http://[::1]:8081", true, true},
		{"http://127.0.0.1:8080", "http://127.0.0.1:8080", true, false},
		{"http://127.0.0.1:8080", "http://127.0.0.2:8081", true, false},
		{"https://127.0.0.1:8080", "https://127.0.0.1:8081", false, false},
		{"http://192.0.2.1:8080", "http://192.0.2.1:8081", true, false},
		{"http://app.daynight.test:8080", "http://preview.daynight.test:8080", true, true},
		{"http://app.daynight.localhost:8080", "http://preview.daynight.localhost:8080", true, true},
		{"http://app.daynight.test:8080", "http://preview.daynight.test:8080", false, false},
		{"http://daynight.cc", "http://preview.daynight.cc", true, false},
		{"https://one.co.uk", "https://two.co.uk", false, false},
		{"https://one.github.io", "https://two.github.io", false, false},
		{"https://app.daynight.cc", "https://daynight.cc", false, false},
		{"https://daynight.cc", "http://preview.daynight.cc", true, false},
		{"http://127.0.0.1:8080", "http://preview.daynight.test:8080", true, false},
	} {
		err := (Config{PublicOrigin: tc.main, PreviewOrigin: tc.preview, AllowHTTPTestOrigin: tc.test}).ValidatePreviewOrigin()
		if (err == nil) != tc.valid {
			t.Fatalf("main %q preview %q valid %v: %v", tc.main, tc.preview, tc.valid, err)
		}
	}
}

func TestPreviewOriginHostnameDiagnosis(t *testing.T) {
	for _, tc := range []struct {
		name, main, preview, field string
	}{
		{"both single-label", "http://localhost:8787", "http://localhost:8787", "public_origin"},
		{"main single-label", "http://private-main:8787", "http://preview.daynight.localhost:8787", "public_origin"},
		{"preview single-label", "http://app.daynight.localhost:8787", "http://private-preview:8787", "preview_origin"},
		{"main IPv4", "http://127.0.0.1:8787", "http://preview.daynight.localhost:8787", "public_origin"},
		{"preview IPv4", "http://app.daynight.localhost:8787", "http://127.0.0.1:8787", "preview_origin"},
		{"main IPv6", "http://[::1]:8787", "http://preview.daynight.localhost:8787", "public_origin"},
		{"preview IPv6", "http://app.daynight.localhost:8787", "http://[::1]:8787", "preview_origin"},
		{"main trailing dot", "http://app.daynight.localhost.:8787", "http://preview.daynight.localhost:8787", "public_origin"},
		{"preview trailing dot", "http://app.daynight.localhost:8787", "http://preview.daynight.localhost.:8787", "preview_origin"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := (Config{PublicOrigin: tc.main, PreviewOrigin: tc.preview, AllowHTTPTestOrigin: true}).ValidatePreviewOrigin()
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != tc.field {
				t.Fatalf("hostname attribution: %v", err)
			}
			for _, rule := range []string{"lowercase", "DNS hostname", "dot", "IP addresses", "single-label", "trailing dots"} {
				if !strings.Contains(failure.Rule, rule) {
					t.Fatalf("hostname rule omits %q: %s", rule, failure.Rule)
				}
			}
			if strings.Contains(err.Error(), tc.main) || strings.Contains(err.Error(), tc.preview) || strings.Contains(err.Error(), "private-main") || strings.Contains(err.Error(), "private-preview") {
				t.Fatalf("hostname diagnosis exposes configured values: %v", err)
			}
		})
	}
}

func TestPreviewOriginSameHostnameDiagnosis(t *testing.T) {
	for _, preview := range []string{"https://app.daynight.cc", "https://app.daynight.cc:8443"} {
		err := (Config{PublicOrigin: "https://app.daynight.cc", PreviewOrigin: preview}).ValidatePreviewOrigin()
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "preview_origin" || !strings.Contains(failure.Rule, "hostname different") || !strings.Contains(failure.Rule, "different ports") {
			t.Fatalf("same-hostname isolation diagnosis: %v", err)
		}
	}
}
