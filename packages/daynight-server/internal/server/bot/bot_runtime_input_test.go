package bot

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestBotRuntimeStrictEnvelopes(t *testing.T) {
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	grant := sp.Grant{Protocol: sp.Protocol, TestExecutionID: reg.TestExecutionID, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	register := sessioncore.BotRegistration{BotVersion: 1, Registration: reg, Configuration: model.BotConfiguration{WorkerID: uuid.NewString(), Cwd: "/tmp", Provider: "codex", Args: []string{}}, RoleConfiguration: model.BotRoleConfiguration{Instructions: "Role", Revision: "v1", Digest: "digest"}}
	code := "preflight_failed"
	report := sessioncore.BotReport{BotVersion: 1, Result: model.BotStartupResult{State: "failed", Code: &code}}
	cases := []struct {
		name   string
		input  any
		decode func([]byte) error
	}{
		{"register", register, func(b []byte) error { _, e := botRegisterInput(b); return e }},
		{"grant", sessioncore.BotGrant{BotVersion: 1, Grant: grant}, func(b []byte) error { _, e := botGrantInput(b); return e }},
		{"report", report, func(b []byte) error { _, e := botReportInput(b); return e }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, _ := json.Marshal(tc.input)
			if err := tc.decode(raw); err != nil {
				t.Fatal(err)
			}
			for _, bad := range []string{`null`, `[]`, `{}`, `{"botVersion":"1","botVersion":"2"}`, string(raw) + ` {}`} {
				if tc.decode([]byte(bad)) == nil {
					t.Errorf("accepted %s", bad)
				}
			}
			for _, value := range []any{nil, 1, "0", "01", "+1", "9223372036854775808", "a"} {
				var obj map[string]any
				_ = json.Unmarshal(raw, &obj)
				obj["botVersion"] = value
				b, _ := json.Marshal(obj)
				if tc.decode(b) == nil {
					t.Errorf("accepted version %v", value)
				}
			}
			var obj map[string]any
			_ = json.Unmarshal(raw, &obj)
			obj["extra"] = true
			b, _ := json.Marshal(obj)
			if tc.decode(b) == nil {
				t.Fatal("accepted unknown field")
			}
		})
	}
	mutations := []struct {
		kind   string
		mutate func(map[string]any)
	}{
		{"register", func(v map[string]any) { v["registration"] = nil }},
		{"register", func(v map[string]any) { v["configuration"] = nil }},
		{"register", func(v map[string]any) { v["configuration"].(map[string]any)["args"] = nil }},
		{"register", func(v map[string]any) { v["configuration"].(map[string]any)["args"] = []any{nil} }},
		{"register", func(v map[string]any) { v["configuration"].(map[string]any)["model"] = true }},
		{"register", func(v map[string]any) { v["roleConfiguration"] = nil }},
		{"grant", func(v map[string]any) { v["grant"] = nil }},
		{"grant", func(v map[string]any) { v["nativeSessionId"] = 12 }},
		{"report", func(v map[string]any) { v["result"] = nil }},
		{"report", func(v map[string]any) { v["result"].(map[string]any)["state"] = 12 }},
		{"report", func(v map[string]any) { v["controllerId"] = nil }},
		{"report", func(v map[string]any) { v["controllerInstanceId"] = nil }},
		{"report", func(v map[string]any) { v["fence"] = map[string]any{"claimId": uuid.NewString()} }},
	}
	for _, mutation := range mutations {
		for _, tc := range cases {
			if tc.name != mutation.kind {
				continue
			}
			raw, _ := json.Marshal(tc.input)
			var obj map[string]any
			_ = json.Unmarshal(raw, &obj)
			mutation.mutate(obj)
			bad, _ := json.Marshal(obj)
			if tc.decode(bad) == nil {
				t.Errorf("accepted invalid %s: %s", tc.name, bad)
			}
		}
	}
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: reg.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}
	report.Fence = &fence
	raw, _ := json.Marshal(report)
	if _, err := botReportInput(raw); err != nil {
		t.Fatal(err)
	}
	if _, err := botRuntimeObject([]byte(`{"instructions":"\ud800"}`), "instructions"); err == nil {
		t.Fatal("accepted lone surrogate")
	}
}
