package sessionprotocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func commandFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "daynight", "test", "session", "fixtures", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestCommandSharedTypeScriptFixtures(t *testing.T) {
	for _, name := range []string{"send-message", "cancel", "interaction-response"} {
		t.Run(name, func(t *testing.T) {
			data := commandFixture(t, name)
			command, err := DecodeCommand(data)
			if err != nil {
				t.Fatal(err)
			}
			if command.ExecutionGeneration != "9007199254740993" {
				t.Fatal("generation lost precision above JavaScript's safe integer range")
			}
			encoded, err := json.Marshal(command)
			if err != nil {
				t.Fatal(err)
			}
			var want, got any
			if err := json.Unmarshal(data, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("Go changed the shared wire contract: %s", encoded)
			}
		})
	}
}

func TestCommandRejectsUnsafeFencesAndUnscopedActions(t *testing.T) {
	data := string(commandFixture(t, "send-message"))
	for _, test := range []struct{ name, from, to string }{
		{"protocol", `"daynight.session.v1"`, `"daynight.session.v2"`},
		{"numeric generation", `"9007199254740993"`, `9007199254740993`},
		{"zero generation", `"9007199254740993"`, `"0"`},
		{"leading zero", `"9007199254740993"`, `"01"`},
		{"overflow", `"9007199254740993"`, `"9223372036854775808"`},
		{"noncanonical identity", `"00000006-1111-4111-8111-111111111111"`, `"00000006-1111-4111-8111-11111111111A"`},
		{"blank request", `"request-1"`, `" "`},
		{"request control", `"request-1"`, `"request\\n1"`},
		{"unscoped action", `"send_message"`, `"execute_command"`},
		{"unknown field", `"protocol":`, `"other":true,"protocol":`},
		{"duplicate field", `"protocol":`, `"protocol":"daynight.session.v1","protocol":`},
		{"blank input", `"Continue the task."`, `"  "`},
		{"nul input", `"Continue the task."`, `"hello\u0000"`},
		{"lone surrogate", `"Continue the task."`, `"\ud800"`},
		{"low surrogate", `"Continue the task."`, `"\udfff"`},
		{"resource input", `"type": "text"`, `"type": "resource"`},
		{"missing turn fence", `"expectedTurnId": null`, `"unexpected": null`},
		{"UTF-8 key bound", `"expectedTurnId": null`, `"expectedTurnId": "` + strings.Repeat("中", 86) + `"`},
		{"UTF-8 text bound", `"Continue the task."`, `"` + strings.Repeat("中", 349526) + `"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			changed := strings.Replace(data, test.from, test.to, 1)
			if changed == data {
				t.Fatal("fixture mutation did not match")
			}
			if _, err := DecodeCommand([]byte(changed)); err == nil {
				t.Fatal("unsafe command accepted")
			}
		})
	}
	for _, turn := range []string{`null`, `""`, `0`} {
		data := strings.Replace(string(commandFixture(t, "cancel")), `"turn-1"`, turn, 1)
		if _, err := DecodeCommand([]byte(data)); err == nil {
			t.Fatal("cancel without an exact native turn was accepted")
		}
	}
}

func TestInteractionResponseVariantsAndUniqueIdentity(t *testing.T) {
	var command map[string]any
	if err := json.Unmarshal(commandFixture(t, "interaction-response"), &command); err != nil {
		t.Fatal(err)
	}
	payload := command["payload"].(map[string]any)
	for _, test := range []struct {
		name     string
		response any
		valid    bool
	}{
		{"dismiss", map[string]any{"kind": "dismiss"}, true},
		{"approval", map[string]any{"kind": "approval", "action": "allow_session"}, true},
		{"bad approval", map[string]any{"kind": "approval", "action": "always"}, false},
		{"question", map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "q", "optionIds": []any{"a"}, "text": nil}}}, true},
		{"empty question", map[string]any{"kind": "question", "answers": []any{}}, false},
		{"duplicate option", map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "q", "optionIds": []any{"a", "a"}, "text": ""}}}, false},
		{"form", map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "f", "value": []any{"a", "b"}}}}, true},
		{"number", map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "f", "value": 3.5}}}, true},
		{"bool", map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "f", "value": false}}}, true},
		{"text", map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "f", "value": ""}}}, true},
		{"empty form", map[string]any{"kind": "form", "values": []any{}}, true},
		{"null value", map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "f", "value": nil}}}, false},
		{"duplicate field", map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "f", "value": true}, map[string]any{"fieldId": "f", "value": false}}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload["response"] = test.response
			data, err := json.Marshal(command)
			if err != nil {
				t.Fatal(err)
			}
			_, err = DecodeCommand(data)
			if (err == nil) != test.valid {
				t.Fatalf("response validity = %v, want %v: %v", err == nil, test.valid, err)
			}
		})
	}
}

func TestCommandRejectsMalformedAndAmbiguousPayloads(t *testing.T) {
	fixture := string(commandFixture(t, "interaction-response"))
	for _, mutation := range []struct{ from, to string }{
		{`"interactionId":`, `"unexpected":`},
		{`"00000011-1111-4111-8111-111111111111"`, `false`},
		{`"interactionRevision": "2"`, `"interactionRevision": "0"`},
		{`"00000010-1111-4111-8111-111111111111"`, `"invalid"`},
	} {
		data := strings.Replace(fixture, mutation.from, mutation.to, 1)
		if data == fixture {
			t.Fatal("interaction mutation did not match")
		}
		if _, err := DecodeCommand([]byte(data)); err == nil {
			t.Fatal("unfenced interaction accepted")
		}
	}
	for _, response := range []string{
		`null`, `false`, `[]`, `{"kind":"other"}`, `{"kind":"approval"}`, `{"kind":"approval","action":"reject","extra":true}`,
		`{"kind":"question","answers":null}`, `{"kind":"question","answers":[{"questionId":"q","optionIds":null,"text":null}]}`,
		`{"kind":"question","answers":[{"questionId":"q","optionIds":[],"text":null},{"questionId":"q","optionIds":[],"text":null}]}`,
		`{"kind":"form","values":null}`, `{"kind":"form","values":[{"fieldId":"f","value":{}}]}`,
		`{"kind":"form","values":[{"fieldId":"f","value":1e999}]}`, `{"kind":"form","values":[{"fieldId":"","value":true}]}`,
		`{"kind":"dismiss","extra":true}`,
	} {
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal([]byte(fixture), &envelope); err != nil {
			t.Fatal(err)
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(envelope["payload"], &payload); err != nil {
			t.Fatal(err)
		}
		payload["response"] = json.RawMessage(response)
		envelope["payload"], _ = json.Marshal(payload)
		data, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeCommand(data); err == nil {
			t.Fatalf("ambiguous interaction accepted: %s", response)
		}
	}
	send := string(commandFixture(t, "send-message"))
	for _, payload := range []string{
		`null`, `[]`, `{}`, `{"expectedTurnId":null,"content":null}`, `{"expectedTurnId":null,"content":[]}`,
		`{"expectedTurnId":null,"content":[{"type":"text","text":null}]}`,
		`{"expectedTurnId":false,"content":[{"type":"text","text":"valid"}]}`,
		`{"expectedTurnId":null,"content":[{"type":"text","text":"valid","extra":true}]}`,
		`{"expectedTurnId":null,"content":[` + strings.Repeat(`{"type":"text","text":"valid"},`, 1000) + `{"type":"text","text":"valid"}]}`,
	} {
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal([]byte(send), &envelope); err != nil {
			t.Fatal(err)
		}
		envelope["payload"] = json.RawMessage(payload)
		data, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeCommand(data); err == nil {
			t.Fatalf("invalid send payload accepted: %.100s", payload)
		}
	}
	for _, data := range [][]byte{
		[]byte(`{`), []byte(`null`), []byte(send + ` {}`), []byte(strings.Replace(send, `"Continue the task."`, `"\uD800\u0001"`, 1)),
		[]byte(strings.Replace(send, `"Continue the task."`, `"\uD800\uZZZZ"`, 1)), []byte(strings.Replace(send, `"Continue the task."`, `"\u12"`, 1)),
		[]byte(strings.Replace(send, `"Continue the task."`, `"\uZZZZ"`, 1)), []byte(`{"text":"` + string([]byte{0xff}) + `"}`), []byte(`{"text":"\`),
	} {
		if _, err := DecodeCommand(data); err == nil {
			t.Fatal("malformed JSON or Unicode accepted")
		}
	}
}

func TestCommandPreservesUnicodeAndExactNumericLimits(t *testing.T) {
	fixture := string(commandFixture(t, "send-message"))
	for _, text := range []string{`"\uD83D\uDE00"`, `"中文😀"`, `"\uFEFF"`, `"literal \\ud800 is text"`, `"` + strings.Repeat("a", 1_048_576) + `"`} {
		data := strings.Replace(fixture, `"Continue the task."`, text, 1)
		data = strings.Replace(data, `"9007199254740993"`, `"9223372036854775807"`, 1)
		if _, err := DecodeCommand([]byte(data)); err != nil {
			t.Fatalf("supported Unicode or int64 limit rejected: %v", err)
		}
	}
}
