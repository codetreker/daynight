package identity

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestProfileAdmission(t *testing.T) {
	for _, tc := range []struct {
		field string
		max   int
		set   func(*model.User, string)
	}{
		{"identityId", MaxProfileFieldBytes, func(p *model.User, s string) { p.UniAuthID = s }},
		{"name", MaxProfileFieldBytes, func(p *model.User, s string) { p.Name = &s }},
		{"email", MaxProfileFieldBytes, func(p *model.User, s string) { p.Email = &s }},
		{"avatarUrl", MaxAvatarURLBytes, func(p *model.User, s string) { p.AvatarURL = &s }},
	} {
		t.Run(tc.field, func(t *testing.T) {
			var p model.User
			tc.set(&p, strings.Repeat("é", tc.max/2))
			if err := AdmitProfileFields(p); err != nil {
				t.Fatal(err)
			}
			tc.set(&p, strings.Repeat("a", tc.max+1))
			var v *limit.Violation
			if err := AdmitProfileFields(p); !errors.As(err, &v) || v.Field != tc.field || v.Actual != int64(tc.max+1) {
				t.Fatalf("unexpected result: %v", err)
			}
		})
	}
	if err := AdmitReturnPath(strings.Repeat("a", MaxReturnPathBytes)); err != nil {
		t.Fatal(err)
	}
	if err := AdmitReturnPath(strings.Repeat("a", MaxReturnPathBytes+1)); err == nil {
		t.Fatal("accepted oversized return path")
	}
}
