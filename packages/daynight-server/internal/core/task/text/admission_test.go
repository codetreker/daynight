package text_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
)

func TestAdmit(t *testing.T) {
	for _, tc := range []struct {
		title, description, field string
		actual, max               int64
	}{
		{strings.Repeat("é", 512), strings.Repeat("界", 21845) + "a", "", 0, 0},
		{strings.Repeat("é", 512) + "x", "", "title", 1025, 1024},
		{"x", strings.Repeat("界", 21845) + "ab", "description", 65537, 65536},
		{"x", strings.Repeat("界", 21845) + "abc", "description", 65538, 65536},
	} {
		err := text.Admit(tc.title, tc.description)
		if tc.field == "" {
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		var v *limit.Violation
		if !errors.As(err, &v) || v.Field != tc.field || v.Actual != tc.actual || v.Max != tc.max {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
	for _, v := range [][2]string{{"", ""}, {" \t", ""}, {"\x00", ""}, {"x", "\x00"}, {string([]byte{0xff}), ""}, {"x", string([]byte{0xff})}} {
		if err := text.Admit(v[0], v[1]); err == nil {
			t.Fatalf("invalid text accepted: %q", v)
		}
	}
}
