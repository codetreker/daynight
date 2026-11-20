package usage

import (
	"strings"
	"testing"
)

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) { v, ok := values[key]; return v, ok }
}

func TestUsageConfigurationRequiresNoCursorKey(t *testing.T) {
	options, enabled, err := environmentOptions(lookup(nil))
	if err != nil || !enabled || options.WriteEnabled || len(options.QualifiedProfiles) != 0 {
		t.Fatal(options, enabled, err)
	}
	options, enabled, err = environmentOptions(lookup(map[string]string{
		"DAYNIGHT_USAGE_CURSOR_KEY":         "invalid and ignored",
		"DAYNIGHT_USAGE_WRITE_ENABLED":      "true",
		"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1@1.0.11+1.0.105",
	}))
	if err != nil || !enabled || !options.WriteEnabled || len(options.QualifiedProfiles) != 1 {
		t.Fatal(options, enabled, err)
	}
	for _, bad := range []map[string]string{
		{"DAYNIGHT_USAGE_WRITE_ENABLED": ""}, {"DAYNIGHT_USAGE_WRITE_ENABLED": "TRUE"}, {"DAYNIGHT_USAGE_WRITE_ENABLED": "1"},
		{"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "unknown@version"}, {"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1"}, {"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1@version,"},
		{"DAYNIGHT_USAGE_QUALIFIED_PROFILES": "copilot-event-1.0.11-v1@version,copilot-event-1.0.11-v1@version"},
	} {
		if _, _, err = environmentOptions(lookup(bad)); err == nil {
			t.Fatalf("invalid configuration accepted: %v", bad)
		}
	}
}

func TestFromEnvironmentCreatesUsageWithoutKeys(t *testing.T) {
	t.Setenv("DAYNIGHT_S2S_SHARED_KEY", "")
	t.Setenv("DAYNIGHT_USAGE_CURSOR_KEY", "")
	t.Setenv("DAYNIGHT_USAGE_WRITE_ENABLED", "false")
	t.Setenv("DAYNIGHT_USAGE_QUALIFIED_PROFILES", "")
	service, err := FromEnvironment(nil)
	if err != nil || service == nil || service.Capabilities()["writeEnabled"] != false {
		t.Fatal(service, err)
	}
	t.Setenv("DAYNIGHT_USAGE_WRITE_ENABLED", "invalid")
	if service, err = FromEnvironment(nil); err == nil || service != nil || !strings.Contains(err.Error(), "DAYNIGHT_USAGE_WRITE_ENABLED") {
		t.Fatal(service, err)
	}
}
