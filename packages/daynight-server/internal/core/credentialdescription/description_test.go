package credentialdescription

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	for _, tc := range []struct {
		input   string
		want    *string
		invalid bool
	}{
		{"\u2003hello\u00a0", ptr("hello"), false},
		{"\t\u2003", nil, false},
		{strings.Repeat("界", 100), ptr(strings.Repeat("界", 100)), false},
		{strings.Repeat("界", 101), nil, true},
		{"\xff", nil, true}, {"a\x00b", nil, true},
		{"\na", nil, true}, {"\ra", nil, true}, {"\va", nil, true},
		{"\fa", nil, true}, {"\u0085a", nil, true}, {"\u2028a", nil, true}, {"\u2029a", nil, true},
	} {
		got, err := Normalize(&tc.input)
		if tc.invalid {
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("%q: %v", tc.input, err)
			}
			continue
		}
		if err != nil || (got == nil) != (tc.want == nil) || got != nil && *got != *tc.want {
			t.Fatalf("%q: %v, %v", tc.input, got, err)
		}
	}
	if got, err := Normalize(nil); got != nil || err != nil {
		t.Fatal(got, err)
	}
}
func TestExpectedMustAlreadyBeCanonical(t *testing.T) {
	for _, tc := range []struct {
		value *string
		valid bool
	}{{nil, true}, {ptr("abc"), true}, {ptr(""), false}, {ptr(" abc"), false}, {ptr("a\nb"), false}} {
		if (ValidateExpected(tc.value) == nil) != tc.valid {
			t.Fatalf("%v", tc.value)
		}
	}
}
func ptr(s string) *string { return &s }
