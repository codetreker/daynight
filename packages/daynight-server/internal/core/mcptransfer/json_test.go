package mcptransfer

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestJSONNumericAndStructureEquality(t *testing.T) {
	for _, tc := range []struct {
		a, b  any
		equal bool
	}{
		{json.Number("0"), json.Number("-0.00e100"), true},
		{json.Number("-1.20"), json.Number("-12e-1"), true},
		{json.Number("1"), json.Number("2"), false},
		{json.Number("1e999999999999999999999"), json.Number("1"), false},
		{json.Number("1"), json.Number("1e999999999999999999999"), false},
		{json.Number("1.2e-9223372036854775808"), json.Number("1"), false},
		{json.Number("10e9223372036854775807"), json.Number("1"), false},
		{json.Number("1e9223372036854775808"), json.Number("1"), false},
		{json.Number("1.1e-9223372036854775808"), json.Number("1"), false},
		{json.Number("1"), "1", false},
		{[]any{true, "x"}, []any{true, "x"}, true},
		{[]any{true}, []any{false}, false},
		{[]any{true}, []any{}, false},
		{[]any{true}, "x", false},
		{map[string]any{"a": true}, map[string]any{"a": true}, true},
		{map[string]any{"a": true}, map[string]any{"b": true}, false},
		{map[string]any{"a": true}, map[string]any{"a": false}, false},
		{map[string]any{"a": true}, map[string]any{}, false},
		{map[string]any{"a": true}, "x", false},
	} {
		if got := EqualJSON(tc.a, tc.b); got != tc.equal {
			t.Errorf("%v vs %v: %v", tc.a, tc.b, got)
		}
	}
}

func TestEqualJSONExtremeExponentsBounded(t *testing.T) {
	if os.Getenv("DAYNIGHT_TEST_DECIMAL_CHILD") == "1" {
		for _, tc := range []struct {
			a, b  string
			equal bool
		}{
			{"1000", "1e3", true},
			{"9007199254740993", "9007199254740992", false},
			{"1", "1e1000000", false},
			{"1", "1e-1000000", false},
			{"1", "1e1000000000", false},
			{"1", "1e-1000000000", false},
			{"0", "0e1000000000", true},
			{"0", "-0.000e-1000000000", true},
		} {
			if got := EqualJSON(json.Number(tc.a), json.Number(tc.b)); got != tc.equal {
				t.Errorf("compare %s and %s: got %v, want %v", tc.a, tc.b, got, tc.equal)
			}
		}
		return
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestEqualJSONExtremeExponentsBounded$")
	cmd.Env = append(os.Environ(), "DAYNIGHT_TEST_DECIMAL_CHILD=1")
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("extreme exponent comparison exceeded time bound: %v", ctx.Err())
	}
	if err != nil {
		t.Fatalf("extreme exponent comparison: %v\n%s", err, output)
	}
}

func TestEqualJSONStructuredBindings(t *testing.T) {
	parse := func(value string) any {
		t.Helper()
		var result any
		decoder := json.NewDecoder(strings.NewReader(value))
		decoder.UseNumber()
		if err := decoder.Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, tc := range []struct {
		a, b  string
		equal bool
	}{
		{`[1,{"v":3}]`, `[1.0,{"v":3e0}]`, true},
		{`[1,2]`, `[1]`, false},
		{`[1]`, `[2]`, false},
		{`[1]`, `{"v":1}`, false},
		{`{"a":1}`, `{"b":1}`, false},
		{`{"a":1}`, `{"a":1,"b":2}`, false},
		{`1`, `"1"`, false},
		{`null`, `null`, true},
	} {
		if got := EqualJSON(parse(tc.a), parse(tc.b)); got != tc.equal {
			t.Errorf("%s versus %s: %v", tc.a, tc.b, got)
		}
	}
}

func TestBindingJSONNumbersAreExactAndEquivalent(t *testing.T) {
	const user = "5dc7097e-78ce-4a46-8246-5e79e5a9140d"
	const credential = "3d29c454-ad6b-47d7-b476-a31295bc9d0c"
	actor := Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: credential}, AuthorityKind: "pat", AuthorityID: credential}
	binding := Binding{ID: user, ProjectID: user, TaskID: credential, Direction: "upload", Path: "file", ContentType: "text/plain", Parameters: json.RawMessage(`{"amount":1000,"large":9007199254740993}`)}
	record, err := NewRecord(actor, binding, time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	same := binding
	same.Parameters = json.RawMessage(`{"large":9007199254740993,"amount":1e3}`)
	if !SameBinding(record, actor, same, same.Parameters) {
		t.Fatal("equivalent JSON binding rejected")
	}
	different := binding
	different.Parameters = json.RawMessage(`{"amount":1e3,"large":9007199254740992}`)
	if SameBinding(record, actor, different, different.Parameters) {
		t.Fatal("distinct large integer accepted")
	}
}
