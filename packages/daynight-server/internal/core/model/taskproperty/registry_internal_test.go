package taskproperty

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestStrictValue(t *testing.T) {
	for _, raw := range []string{`{"n":9223372036854775807,"nested":[null,true,false,17.5,"text",{}]}`, `-17`, `[]`, `{}`} {
		if err := strictValue([]byte(raw)); err != nil {
			t.Fatalf("valid JSON value rejected: %s (%v)", raw, err)
		}
	}
	for _, raw := range []string{"", `}`, `]`, `{`, `[`, `{1:2}`, `{"x":}`, `{"x":1`, `{"x":1]`, `[1}`, `[1,]`, `{"x":{"y":1,"y":2}}`, `1 2`} {
		if err := strictValue([]byte(raw)); err == nil {
			t.Fatalf("invalid JSON value accepted: %s", raw)
		}
	}
}

func TestStringDefinitionsAcceptRawTextAndJSONStringWithoutNewProductProperty(t *testing.T) {
	valueDefinition := Definition{Name: "testText", kind: "string", Normalize: func(raw json.RawMessage) (json.RawMessage, error) {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		return json.Marshal(value)
	}}
	for _, test := range []struct{ input, want string }{
		{"", ""}, {"abc", "abc"}, {"123", "123"}, {"true", "true"}, {"null", "null"}, {`[1]`, `[1]`},
		{`"123"`, "123"}, {`"line\n中文"`, "line\n中文"}, {`"unterminated`, `"unterminated`},
	} {
		actual, err := parseDefinitionInput(valueDefinition, test.input)
		var got string
		if err != nil || json.Unmarshal(actual, &got) != nil || got != test.want {
			t.Fatalf("string input %q: got %q (%v), want %q", test.input, actual, err, test.want)
		}
	}
	if !reflect.DeepEqual(propertyNames(), []string{"paused", "pullRequests", "sessionStartup", "worker"}) {
		t.Fatal("string shorthand test registered a product property")
	}
}

func TestInvalidValueSchemaFailsBeforeDefinitionsCanBePublished(t *testing.T) {
	malformedDefinition := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"worker": json.RawMessage(`{"type":`),
		},
	}
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		schemaJSON(malformedDefinition)
	}()
	failure, ok := recovered.(error)
	var marshalFailure *json.MarshalerError
	if !ok || !errors.As(failure, &marshalFailure) || !strings.Contains(failure.Error(), "encode property definition") {
		t.Fatalf("malformed definition did not fail with its JSON encoding cause: %#v", recovered)
	}
	for name, definition := range Definitions() {
		if !json.Valid(definition.Schema) {
			t.Fatalf("failed definition construction corrupted catalog entry %s", name)
		}
	}
}

func TestIndependentValueBudgetsForFutureDefinitions(t *testing.T) {
	// The current catalog has only one property whose schema can reach 8 KiB.
	// Two temporary definitions exercise the per-value rule without publishing
	// additional product properties.
	for _, name := range []string{"testFirst", "testSecond"} {
		definitions[name] = Definition{Name: name, kind: "string", Normalize: func(raw json.RawMessage) (json.RawMessage, error) {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				return nil, err
			}
			return json.Marshal(value)
		}}
		t.Cleanup(func() { delete(definitions, name) })
	}
	value, err := json.Marshal(strings.Repeat("x", MaxValueBytes-2))
	if err != nil {
		t.Fatal(err)
	}
	values, err := Normalize(map[string]json.RawMessage{"testFirst": value, "testSecond": value})
	if err != nil {
		t.Fatal(err)
	}
	if err := Admit(values); err != nil {
		t.Fatalf("independent maximum values: %v", err)
	}
	values["testSecond"], err = json.Marshal(strings.Repeat("x", MaxValueBytes-1))
	if err != nil {
		t.Fatal(err)
	}
	if err := Admit(values); err == nil {
		t.Fatal("oversized second value accepted")
	}
}
