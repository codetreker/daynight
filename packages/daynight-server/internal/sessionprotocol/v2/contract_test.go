package v2

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const registrationJSON = `{"protocol":"daynight.session.v2","schemaVersion":2,"projectionVersion":1,"type":"registration","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","agentControlMode":"herdr","contentKind":"terminal_recording","payload":{"registrationId":"33333333-3333-4333-8333-333333333333","mode":"register","owner":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"11111111-1111-4111-8111-111111111111","workerId":"11111111-1111-4111-8111-111111111111","worktreeId":"11111111-1111-4111-8111-111111111111","ownerUserId":"11111111-1111-4111-8111-111111111111","serverOrigin":"https://daynight.cc","provider":"codex"},"binding":{"instanceId":"private-1","sessionId":"worker-session","workspaceId":"workspace_1","paneId":1,"terminalId":"term_18a03f12","nativeSessionId":null},"connectionEpoch":null,"capabilities":{"observe":true,"control":true,"archive":true}}}`

func TestRegistrationIdentityAndStrictEncoding(t *testing.T) {
	message, err := DecodeMessage([]byte(registrationJSON))
	if err != nil {
		t.Fatal(err)
	}
	payload, ok := message.Payload.(Registration)
	if !ok || payload.Binding.NativeSessionID != nil || payload.Binding.TerminalID != "term_18a03f12" {
		t.Fatalf("lost native identity: %#v", message.Payload)
	}
	for name, raw := range map[string]string{
		"duplicate":        strings.Replace(registrationJSON, `"mode":"register"`, `"mode":"register","mode":"register"`, 1),
		"unknown":          strings.Replace(registrationJSON, `"mode":"register"`, `"mode":"register","extra":true`, 1),
		"missing nullable": strings.Replace(registrationJSON, `,"nativeSessionId":null`, "", 1),
		"invalid unicode":  strings.Replace(registrationJSON, `term_18a03f12`, `\ud800`, 1),
		"numeric overflow": strings.Replace(registrationJSON, `"paneId":1`, `"paneId":4294967296`, 1),
		"v1":               strings.Replace(registrationJSON, `daynight.session.v2`, `daynight.session.v1`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeMessage([]byte(raw)); err == nil {
				t.Fatal("invalid registration accepted")
			}
		})
	}
}

func TestCanonicalJSONAndVersionSelection(t *testing.T) {
	encoded, err := CanonicalJSON(map[string]any{"z": float64(1), "a": "<>&\u2028\u2029"})
	if err != nil || string(encoded) != "{\"a\":\"<>&\u2028\u2029\",\"z\":1}" {
		t.Fatalf("canonical encoding: %s %v", encoded, err)
	}
	for _, selection := range []string{"daynight.session.v1", "daynight.session.v2"} {
		if _, err := SelectProtocol(&selection); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := SelectProtocol(pointer("daynight.session.v3")); err == nil {
		t.Fatal("unknown selection accepted")
	}
}

func TestSharedFixtures(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "daynight", "test", "session", "fixtures", "v2")
	data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Cases []struct {
			File  string
			Type  string
			Valid bool
		}
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range manifest.Cases {
		t.Run(fixture.File, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(root, fixture.File))
			if err != nil {
				t.Fatal(err)
			}
			switch fixture.Type {
			case "message":
				_, err = DecodeMessage(raw)
			case "archive":
				_, err = DecodeArchive(raw)
			default:
				t.Fatalf("unknown fixture type %s", fixture.Type)
			}
			if (err == nil) != fixture.Valid {
				t.Fatalf("valid=%v, error=%v", fixture.Valid, err)
			}
		})
	}
}

func pointer[T any](value T) *T { return &value }
