package configvalue

import (
	"errors"
	"testing"
)

func TestFlag(t *testing.T) {
	for _, tc := range []struct {
		input   string
		want    bool
		invalid bool
	}{
		{"0", false, false}, {"1", true, false}, {"", false, true}, {"true", false, true},
	} {
		got, err := Flag(tc.input, "TEST_FLAG")
		if !tc.invalid {
			if err != nil || got != tc.want {
				t.Fatalf("Flag(%q) = %v, %v", tc.input, got, err)
			}
			continue
		}
		var failure *ConfigurationError
		if !errors.As(err, &failure) || failure.Field != "TEST_FLAG" || failure.Rule != "must be 0 or 1" {
			t.Fatalf("Flag(%q) = %v, %v", tc.input, got, err)
		}
	}
}
