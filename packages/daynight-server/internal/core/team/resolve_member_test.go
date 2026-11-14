package team

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

type resolveDAO struct {
	directMemberDAO
	lookup func(context.Context, string) (model.TeamMember, error)
}

func (d resolveDAO) MemberByExternalID(ctx context.Context, id string) (model.TeamMember, error) {
	return d.lookup(ctx, id)
}

func TestValidateResolveMember(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	input := ResolveTeamMember{ExpectedUserID: p.UserID, ExternalUserID: "microsoft:tenant:object"}
	gotID, key, err := ValidateResolveMember(p, id, input)
	if err != nil || gotID != id || key != "msft:object@tenant" {
		t.Fatalf("validation: %q %q %v", gotID, key, err)
	}
	for _, tc := range []struct {
		name, team, actor, external, code string
	}{
		{"wrong actor", id, uuid.NewString(), "target", "identity_mismatch"},
		{"zero actor", id, uuid.Nil.String(), "target", "invalid_input"},
		{"zero Team", uuid.Nil.String(), p.UserID, "target", "invalid_input"},
		{"empty external", id, p.UserID, "", "invalid_input"},
		{"control external", id, p.UserID, "x\x00y", "invalid_input"},
		{"malformed microsoft", id, p.UserID, "msft:broken", "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := ValidateResolveMember(p, tc.team, ResolveTeamMember{ExpectedUserID: tc.actor, ExternalUserID: tc.external})
			faultCode(t, err, tc.code)
		})
	}
}

func TestResolveMemberAuthorizationAndLookup(t *testing.T) {
	p := principal()
	team := namedTeam(p)
	cause := errors.New("lookup failed")
	for _, tc := range []struct {
		name               string
		team               model.Team
		teamErr, lookupErr error
		code               string
		lookup             bool
	}{
		{"existing", team, nil, nil, "", true},
		{"absent", team, nil, model.ErrNotFound, "", true},
		{"lookup error", team, nil, cause, "", true},
		{"unavailable Team", team, model.ErrNotFound, nil, "not_found", false},
		{"member actor", func() model.Team { v := team; v.Membership.Role = model.ProjectMemberRole; return v }(), nil, nil, "forbidden", false},
		{"personal Team", func() model.Team { v := team; v.Kind = "personal"; return v }(), nil, nil, "personal_team_immutable", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			dao := resolveDAO{directMemberDAO: directMemberDAO{team: func(ctx context.Context, actor string) (model.Team, error) {
				if ctx != t.Context() || actor != p.UserID {
					t.Fatal("actor or context changed")
				}
				return tc.team, tc.teamErr
			}}, lookup: func(ctx context.Context, key string) (model.TeamMember, error) {
				called = true
				if ctx != t.Context() || key != "external" {
					t.Fatal("lookup input changed")
				}
				return team.Membership, tc.lookupErr
			}}
			got, err := ResolveMember(t.Context(), dao, p, "external")
			if called != tc.lookup {
				t.Fatalf("lookup called: %v", called)
			}
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if tc.lookupErr == cause && !errors.Is(err, cause) {
				t.Fatalf("lost error: %v", err)
			} else if tc.lookupErr != cause && err != nil {
				t.Fatal(err)
			}
			if tc.name == "existing" {
				if got == nil || *got != team.Membership {
					t.Fatalf("member: %+v", got)
				}
			} else if got != nil {
				t.Fatalf("unexpected member: %+v", got)
			}
		})
	}
}
