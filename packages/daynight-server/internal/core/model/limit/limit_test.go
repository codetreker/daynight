package limit

import (
	"strings"
	"testing"
)

func TestViolationError(t *testing.T) {
	v := Violation{Field: "name", Actual: 11, Max: 10, Unit: "bytes"}
	if s := v.Error(); !strings.Contains(s, "11 bytes") || !strings.Contains(s, "maximum 10") {
		t.Fatal(s)
	}
	v.LowerBound = true
	if s := v.Error(); !strings.Contains(s, "at least 11 bytes") {
		t.Fatal(s)
	}
	min := int64(1)
	v.Min = &min
	v.Actual = 0
	if s := v.Error(); !strings.Contains(s, "minimum 1") {
		t.Fatal(s)
	}
}
