package model

import "testing"

func TestValidWorkerText(t *testing.T) {
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"machine", true}, {" 主机 ", true}, {"", false}, {" \t", false}, {"bad\x00name", false}, {string([]byte{0xff}), false},
	} {
		if got := ValidWorkerText(tc.value); got != tc.valid {
			t.Errorf("ValidWorkerText(%q) = %v, want %v", tc.value, got, tc.valid)
		}
	}
}
