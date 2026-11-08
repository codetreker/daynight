package team

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestAdmitNameLimits(t *testing.T) {
	for _, tc := range []struct {
		value string
		ok    bool
		unit  string
	}{
		{strings.Repeat("a", 256), true, ""}, {strings.Repeat("a", 257), false, "code points"},
		{strings.Repeat("😀", 256), true, ""}, {strings.Repeat("😀", 257), false, "code points"},
	} {
		err := AdmitName(tc.value)
		var v *limit.Violation
		if tc.ok && err != nil || !tc.ok && (!errors.As(err, &v) || v.Unit != tc.unit) {
			t.Fatalf("unexpected result: %v", err)
		}
	}
}
