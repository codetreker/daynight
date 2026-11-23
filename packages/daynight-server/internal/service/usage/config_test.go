package usage

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestScopedEnvironmentRejectsConfigurationBeforeConstructingProducer(t *testing.T) {
	t.Setenv("DAYNIGHT_USAGE_WRITE_ENABLED", "invalid")
	t.Setenv("DAYNIGHT_USAGE_QUALIFIED_PROFILES", "")
	service, err := ScopedFromEnvironment(nil, nil)
	var invalid *configvalue.ConfigurationError
	if service != nil || !errors.As(err, &invalid) || invalid.Field != "DAYNIGHT_USAGE_WRITE_ENABLED" {
		t.Fatalf("configuration error was hidden by missing authorization: service=%v error=%v", service, err)
	}
	t.Setenv("DAYNIGHT_USAGE_WRITE_ENABLED", "true")
	if service, err = ScopedFromEnvironment(nil, nil); service != nil || err == nil || !strings.Contains(err.Error(), "usage producer authorization is required") {
		t.Fatalf("valid configuration accepted missing producer authorization: service=%v error=%v", service, err)
	}
}

func TestScopedEnvironmentInstallsExactProducerAuthorization(t *testing.T) {
	t.Setenv("DAYNIGHT_USAGE_WRITE_ENABLED", "true")
	t.Setenv("DAYNIGHT_USAGE_QUALIFIED_PROFILES", "copilot-event-1.0.11-v1@1.0.11+1.0.105")
	actor := model.Principal{Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	failure := errors.New("producer authorization unavailable")
	calls := 0
	service, err := ScopedFromEnvironment(nil, func(ctx context.Context, scope store.UsageScope, actual model.Principal, at time.Time, write bool) (model.CredentialAuthorization, error) {
		calls++
		if ctx != t.Context() || scope != nil || actual != actor || !at.Equal(now) || !write {
			t.Fatal("producer authorization received different operation inputs")
		}
		return model.CredentialAuthorization{}, failure
	})
	if err != nil || service == nil || service.Capabilities()["writeEnabled"] != true {
		t.Fatalf("enabled scoped usage assembly: service=%v error=%v", service, err)
	}
	if err := service.requireProducer(t.Context(), nil, actor, now, true); !errors.Is(err, failure) || calls != 1 {
		t.Fatalf("configured producer source was not preserved: calls=%d error=%v", calls, err)
	}
}

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

func TestCodexQualificationRequiresThePinnedResponseProfileAndVersion(t *testing.T) {
	entry := "codex-response-0.169.0-v1@0.169.0"
	service, err := New(nil, Options{WriteEnabled: true, QualifiedProfiles: []string{entry}})
	if err != nil {
		t.Fatal(err)
	}
	p, err := service.profile("codex-response-0.169.0-v1", "codex", "0.169.0")
	if err != nil || p.Capability.Qualification != "verified" {
		t.Fatal("pinned response profile was not qualified", p, err)
	}
	p, err = service.profile("codex-response-0.169.0-v1", "codex", "0.169.1")
	if err != nil || p.Capability.Qualification != "unverified" {
		t.Fatal("qualification leaked to another version", p, err)
	}
	p, err = service.profile("codex-snapshot-unaccountable-v1", "codex", "0.169.0")
	if err != nil || p.Capability.Qualification != "unsupported" {
		t.Fatal("qualification upgraded legacy snapshots", p, err)
	}
	for _, invalid := range []string{
		"codex-response-0.169.0-v1@0.169.1", "codex-response-0.169.0-v1@unknown", "codex-response-0.169.0-v1@0.169.0-beta",
		"codex-snapshot-unaccountable-v1@0.169.0", "codex-response-0.169.0-v1@ 0.169.0",
	} {
		if _, err := New(nil, Options{QualifiedProfiles: []string{invalid}}); err == nil {
			t.Fatalf("invalid Codex qualification accepted: %s", invalid)
		}
	}
	profiles := service.Capabilities()["profiles"].([]profileAdvertisement)
	found := false
	for _, advertised := range profiles {
		if advertised.ID == "codex-response-0.169.0-v1" {
			found = true
			if advertised.Capability.Qualification != "unverified" || len(advertised.QualifiedVersions) != 1 || advertised.QualifiedVersions[0].ProviderVersion != "0.169.0" || advertised.QualifiedVersions[0].Capability.Qualification != "verified" {
				t.Fatal("advertised qualification changed its version scope", advertised)
			}
		}
	}
	if !found {
		t.Fatal("response profile was omitted from capabilities")
	}
}
