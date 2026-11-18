package usage

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) { v, ok := values[key]; return v, ok }
}
func TestUsageConfigurationIsExplicitAndRestartStable(t *testing.T) {
	shared := strings.Repeat("s", 32)
	first, enabled, err := environmentOptions(lookup(nil), shared)
	if err != nil || !enabled || first.WriteEnabled || len(first.CursorKey) != 32 {
		t.Fatal(first, enabled, err)
	}
	second, _, err := environmentOptions(lookup(nil), shared)
	if err != nil || !bytes.Equal(first.CursorKey, second.CursorKey) {
		t.Fatal("unstable key", err)
	}
	a, err := New(nil, first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(nil, second)
	if err != nil {
		t.Fatal(err)
	}
	token, err := a.encodeCursor(cursor{Binding: "scope", Revision: "revision", ExpiresAt: "2099-01-01T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.decodeCursor(token, time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal("restart invalidated cursor", err)
	}
	if _, enabled, err = environmentOptions(lookup(nil), ""); err != nil || enabled {
		t.Fatal("unconfigured usage capability", enabled, err)
	}
	explicit := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	options, enabled, err := environmentOptions(lookup(map[string]string{"DAYNIGHT_USAGE_CURSOR_KEY": explicit, "DAYNIGHT_USAGE_WRITE_ENABLED": "true", "DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1@1.0.11+1.0.105"}), shared)
	if err != nil || !enabled || !options.WriteEnabled || !bytes.Equal(options.CursorKey, bytes.Repeat([]byte{7}, 32)) || len(options.QualifiedProfiles) != 1 {
		t.Fatal(options, enabled, err)
	}
	for _, bad := range []map[string]string{
		{"DAYNIGHT_USAGE_WRITE_ENABLED": ""}, {"DAYNIGHT_USAGE_WRITE_ENABLED": "TRUE"}, {"DAYNIGHT_USAGE_WRITE_ENABLED": "1"},
		{"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "unknown@version"}, {"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1"}, {"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1@version,"},
		{"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1@version,copilot-event-1.0.11-v1@version"},
		{"DAYNIGHT_USAGE_CURSOR_KEY": ""}, {"DAYNIGHT_USAGE_CURSOR_KEY": "short"}, {"DAYNIGHT_USAGE_CURSOR_KEY": explicit + "="},
	} {
		if _, _, err = environmentOptions(lookup(bad), shared); err == nil {
			t.Fatalf("invalid configuration accepted: %v", bad)
		}
	}
	if _, _, err = environmentOptions(lookup(map[string]string{"DAYNIGHT_USAGE_WRITE_ENABLED": "true"}), ""); err == nil {
		t.Fatal("write without signing configuration")
	}
	if _, _, err = environmentOptions(lookup(nil), "short"); err == nil {
		t.Fatal("short fallback secret")
	}
	if _, err = New(nil, Options{CursorKey: []byte("short")}); err == nil {
		t.Fatal("constructor accepted short key")
	}
}
