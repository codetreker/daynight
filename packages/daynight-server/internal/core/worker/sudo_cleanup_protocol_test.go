package worker

import "testing"

func TestSudoCleanupProtocolOmission(t *testing.T) {
	document := configurationInputDocument()
	document["toolPaths"] = map[string]any{"codex": nil, "copilot": nil}
	for _, entry := range []struct {
		value                      any
		present, preserve, enabled bool
	}{
		{nil, false, true, false}, {false, true, false, false}, {true, true, false, true},
	} {
		if entry.present {
			document["enableSudoCleanup"] = entry.value
		} else {
			delete(document, "enableSudoCleanup")
		}
		value, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document))
		if err != nil || value.PreserveSudoCleanup != entry.preserve || value.EnableSudoCleanup != entry.enabled {
			t.Fatalf("protocol value %v: %+v %v", entry.value, value, err)
		}
		normalized, err := NormalizeConfiguration(value)
		if err != nil || normalized.PreserveSudoCleanup != entry.preserve {
			t.Fatalf("normalization lost omission: %+v %v", normalized, err)
		}
	}
	for _, invalid := range []any{nil, "false", 1} {
		document["enableSudoCleanup"] = invalid
		if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document)); err == nil {
			t.Fatalf("accepted %v", invalid)
		}
	}
}
