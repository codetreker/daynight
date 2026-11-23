package worker

import (
	"encoding/json"
	"testing"

	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func TestRawConfigurationProjectionRejectsCorruptTargetsAndUsesArchiveColumn(t *testing.T) {
	for _, raw := range []string{`[`, `null`, `[]`} {
		if _, err := (rawConfigurationProjection{raw: json.RawMessage(raw)}).MarshalJSON(); err == nil {
			t.Fatalf("corrupt stored target accepted: %s", raw)
		}
	}
	for _, tc := range []struct {
		name         string
		archive      *bool
		capabilities workerprotocol.Capabilities
		wantArchive  string
		wantPaths    bool
	}{
		{"no archive capability", new(true), workerprotocol.Capabilities{}, "", false},
		{"archive unknown", nil, workerprotocol.Capabilities{ToolPaths: true, ArchiveSessions: true}, "null", true},
		{"archive enabled", new(true), workerprotocol.Capabilities{ToolPaths: true, ArchiveSessions: true}, "true", true},
		{"archive disabled", new(false), workerprotocol.Capabilities{ToolPaths: true, ArchiveSessions: true}, "false", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := json.RawMessage(`{"agentControlMode":"herdr","toolPaths":{"codex":null,"copilot":null,"herdr":{"kind":"auto"}},"archiveSessions":"old","future":42}`)
			encoded, err := (rawConfigurationProjection{raw: raw, archive: tc.archive, capabilities: tc.capabilities}).MarshalJSON()
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if string(got["agentControlMode"]) != `"herdr"` || string(got["future"]) != "42" || string(got["enableSudoCleanup"]) != "false" || string(got["archiveSessions"]) != tc.wantArchive || (got["toolPaths"] != nil) != tc.wantPaths {
				t.Fatalf("projection lost raw facts or column: %s", encoded)
			}
		})
	}
}
