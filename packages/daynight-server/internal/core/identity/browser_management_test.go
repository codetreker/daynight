package identity

import (
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestClassifyBrowserUserAgent(t *testing.T) {
	tests := []struct{ ua, browser, os string }{
		{"Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36 Edg/130", "Edge", "Windows"},
		{"Mozilla/5.0 (iPhone) Version/18 Mobile Safari/604.1", "Safari", "iOS"},
		{"Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36", "Chrome", "Android"},
		{"Mozilla/5.0 (Macintosh) Firefox/130", "Firefox", "macOS"},
		{"Mozilla/5.0 (X11; Linux) Chrome/130 OPR/110", "Opera", "Linux"},
		{"unknown", "", ""}, {strings.Repeat("a", 4097) + " Chrome/1 Windows NT", "", ""},
	}
	for _, tc := range tests {
		b, o := ClassifyBrowserUserAgent(tc.ua)
		if (b == nil) != (tc.browser == "") || b != nil && *b != tc.browser || (o == nil) != (tc.os == "") || o != nil && *o != tc.os {
			t.Fatalf("classification = %v %v, want %s %s", b, o, tc.browser, tc.os)
		}
	}
}

func TestCreateSessionRejectsUnboundedClassificationBeforeInsert(t *testing.T) {
	for _, tc := range []struct{ browser, os *string }{
		{browserLabel("unexpected user agent"), nil}, {nil, browserLabel("unknown platform")},
	} {
		dao := &identityDAO{}
		err := NewIdentity("").CreateSession(t.Context(), dao, model.Session{Browser: tc.browser, OS: tc.os})
		if err == nil || len(dao.calls) != 0 {
			t.Fatalf("invalid classification reached storage: %v %v", err, dao.calls)
		}
	}
}
func browserLabel(value string) *string { return &value }
