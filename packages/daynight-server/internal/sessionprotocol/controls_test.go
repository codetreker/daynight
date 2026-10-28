package sessionprotocol

import (
	"strings"
	"testing"
)

func controlsFixture() map[string]any {
	return map[string]any{"revision": "9007199254740993", "settings": []any{map[string]any{"id": "model", "category": "model", "label": "Model", "description": nil, "value": "native", "options": []any{map[string]any{"value": "native", "label": "Native"}}, "mutable": true, "scope": "session"}}, "commands": []any{map[string]any{"id": "compact", "name": "compact", "description": "Compact context", "argumentHint": nil, "available": true}}, "settingsError": nil, "commandsError": nil}
}

func TestControlsCommandsAndOptionalSnapshotFields(t *testing.T) {
	if controls, err := DecodeControls(relayJSON(t, controlsFixture())); err != nil || controls.Revision != "9007199254740993" {
		t.Fatal("controls precision lost", err)
	}
	for _, kind := range []string{"update_setting", "execute_command", "refresh_controls"} {
		c := relayObject(t, commandFixture(t, "send-message"))
		c["kind"] = kind
		switch kind {
		case "update_setting":
			c["payload"] = map[string]any{"settingId": "model", "value": "native", "expectedControlsRevision": "9007199254740993"}
		case "execute_command":
			c["payload"] = map[string]any{"commandId": "compact", "arguments": "", "expectedControlsRevision": "9007199254740993", "expectedTurnId": nil}
		default:
			c["payload"] = map[string]any{}
		}
		if command, err := DecodeCommand(relayJSON(t, c)); err != nil {
			t.Fatalf("%s rejected: %v", kind, err)
		} else {
			receipt := Operation{Fence: command.Fence, Protocol: Protocol, OperationID: command.OperationID, Kind: kind, State: "confirmed"}
			if parsed, err := DecodeOperation(relayJSON(t, receipt)); err != nil || parsed.Kind != kind {
				t.Fatal("new operation receipt rejected", err)
			}
		}
		c["payload"].(map[string]any)["unexpected"] = true
		if _, err := DecodeCommand(relayJSON(t, c)); err == nil {
			t.Fatal("unknown field accepted", kind)
		}
	}
	s := relayObject(t, commandFixture(t, "snapshot"))
	s["controls"] = controlsFixture()
	s["turnStartedAt"] = "2026-10-28T05:00:00.000Z"
	if _, err := DecodeSnapshot(relayJSON(t, s)); err != nil {
		t.Fatal("new snapshot rejected", err)
	}
	delete(s, "controls")
	delete(s, "turnStartedAt")
	if _, err := DecodeSnapshot(relayJSON(t, s)); err != nil {
		t.Fatal("old snapshot rejected", err)
	}
}

func TestControlsStrictValidation(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"unknown", func(c map[string]any) { c["extra"] = true }},
		{"blank label", func(c map[string]any) { c["settings"].([]any)[0].(map[string]any)["label"] = " \t" }},
		{"NUL label", func(c map[string]any) { c["settings"].([]any)[0].(map[string]any)["label"] = "a\x00b" }},
		{"revision overflow", func(c map[string]any) { c["revision"] = "9223372036854775808" }},
		{"revision zero", func(c map[string]any) { c["revision"] = "0" }},
		{"duplicate setting", func(c map[string]any) { c["settings"] = append(c["settings"].([]any), c["settings"].([]any)[0]) }},
		{"duplicate command", func(c map[string]any) { c["commands"] = append(c["commands"].([]any), c["commands"].([]any)[0]) }},
		{"duplicate option", func(c map[string]any) {
			s := c["settings"].([]any)[0].(map[string]any)
			s["options"] = append(s["options"].([]any), s["options"].([]any)[0])
		}},
		{"category", func(c map[string]any) { c["settings"].([]any)[0].(map[string]any)["category"] = "other" }},
		{"scope", func(c map[string]any) { c["settings"].([]any)[0].(map[string]any)["scope"] = "global" }},
		{"invalid mutable", func(c map[string]any) { c["settings"].([]any)[0].(map[string]any)["mutable"] = "true" }},
		{"missing error", func(c map[string]any) { delete(c, "settingsError") }},
		{"long id", func(c map[string]any) { c["settings"].([]any)[0].(map[string]any)["id"] = strings.Repeat("a", 257) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := controlsFixture()
			tc.mutate(c)
			s := relayObject(t, commandFixture(t, "snapshot"))
			s["controls"] = c
			if _, err := DecodeSnapshot(relayJSON(t, s)); err == nil {
				t.Fatal("invalid controls accepted")
			}
		})
	}
	s := relayObject(t, commandFixture(t, "snapshot"))
	s["controls"] = controlsFixture()
	raw := string(relayJSON(t, s))
	raw = strings.Replace(raw, `"revision":"9007199254740993"`, `"revision":"1","revision":"2"`, 1)
	if _, err := DecodeSnapshot([]byte(raw)); err == nil {
		t.Fatal("duplicate control field accepted")
	}
	for _, v := range []any{nil, "yesterday", 123, "2026-10-28T05:00:00Z", "2026-10-28T05:00:00.123456Z", "2026-10-28T05:00:00.000+00:00", "2026-02-30T05:00:00.000Z"} {
		s["turnStartedAt"] = v
		_, err := DecodeSnapshot(relayJSON(t, s))
		if v == nil && err != nil {
			t.Fatal(err)
		}
		if v != nil && err == nil {
			t.Fatal("invalid time accepted")
		}
	}
}
