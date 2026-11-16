package config

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"strings"
	"testing"
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
