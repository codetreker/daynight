package team

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

type existingMemberDAO struct {
	directMemberDAO
	candidate func(context.Context, string) (model.TeamMemberCandidate, error)
}

func (d existingMemberDAO) MemberCandidate(ctx context.Context, id string) (model.TeamMemberCandidate, error) {
	return d.candidate(ctx, id)
}

func TestValidateAddExistingMember(t *testing.T) {
	p, teamID, target := principal(), uuid.NewString(), uuid.NewString()
	if got, err := ValidateAddExistingMember(p, teamID, p.UserID, target); err != nil || got != teamID {
		t.Fatalf("valid: %q %v", got, err)
	}
	for _, bad := range []string{"", uuid.Nil.String(), strings.ToUpper(target), "bad"} {
		_, err := ValidateAddExistingMember(p, teamID, p.UserID, bad)
		faultCode(t, err, "invalid_input")
	}
	_, err := ValidateAddExistingMember(p, teamID, uuid.NewString(), target)
	faultCode(t, err, "identity_mismatch")
}

func TestAddExistingMemberPreservesMembershipAndReadsCurrentProfile(t *testing.T) {
	p, target := principal(), uuid.NewString()
	team := namedTeam(p)
	name := "Current name"
	candidate := model.TeamMemberCandidate{UserID: target, Profile: model.ProjectParticipantProfile{Name: &name}}
	for _, role := range []model.ProjectRole{model.ProjectAdmin, model.ProjectMemberRole} {
		for _, existing := range []bool{false, true} {
			t.Run(string(role)+map[bool]string{true: " existing", false: " new"}[existing], func(t *testing.T) {
				calls := []string{}
				member := model.TeamMember{TeamID: team.ID, UserID: target, Role: role, Version: 37}
				if !existing {
					member.Role = model.ProjectMemberRole
				}
				d := existingMemberDAO{directMemberDAO: directMemberDAO{
					team: func(ctx context.Context, id string) (model.Team, error) {
						calls = append(calls, "authorize")
						if ctx != t.Context() || id != p.UserID {
							t.Fatal("actor")
						}
						return team, nil
					},
					member: func(ctx context.Context, id string) (model.TeamMember, error) {
						calls = append(calls, "member")
						if ctx != t.Context() || id != target {
							t.Fatal("member input")
						}
						if !existing {
							return model.TeamMember{}, model.ErrNotFound
						}
						return member, nil
					},
					add: func(ctx context.Context, id string, role model.ProjectRole) (model.TeamMember, error) {
						calls = append(calls, "insert")
						if ctx != t.Context() || id != target || role != model.ProjectMemberRole {
							t.Fatal("insert input")
						}
						return member, nil
					},
				}, candidate: func(ctx context.Context, id string) (model.TeamMemberCandidate, error) {
					calls = append(calls, "profile")
					if ctx != t.Context() || id != target {
						t.Fatal("profile input")
					}
					return candidate, nil
				}}
				got, err := AddExistingMember(t.Context(), d, p, target)
				expected := []string{"authorize", "profile", "member"}
				if !existing {
					expected = append(expected, "insert")
				}
				if err != nil || got.Added == existing || got.Membership.Membership != member || got.Membership.Profile.Name != candidate.Profile.Name || !reflect.DeepEqual(calls, expected) {
					t.Fatalf("got %+v calls %v err %v", got, calls, err)
				}
			})
		}
	}
}

func TestAddExistingMemberRejectsBeforeFurtherAccess(t *testing.T) {
	p, target := principal(), uuid.NewString()
	team := namedTeam(p)
	for _, tc := range []struct {
		name                                     string
		teamErr, candidateErr, memberErr, addErr error
		role                                     model.ProjectRole
		code                                     string
		calls                                    []string
	}{
		{name: "unavailable team", teamErr: model.ErrNotFound, code: "not_found", calls: []string{"authorize"}},
		{name: "member actor", role: model.ProjectMemberRole, code: "forbidden", calls: []string{"authorize"}},
		{name: "missing user", candidateErr: model.ErrNotFound, code: "user_not_found", calls: []string{"authorize", "profile"}},
		{name: "profile failure", candidateErr: fail, calls: []string{"authorize", "profile"}},
		{name: "membership failure", memberErr: fail, calls: []string{"authorize", "profile", "member"}},
		{name: "insert failure", memberErr: model.ErrNotFound, addErr: fail, calls: []string{"authorize", "profile", "member", "insert"}},
		{name: "disappeared user", memberErr: model.ErrNotFound, addErr: model.ErrNotFound, code: "user_not_found", calls: []string{"authorize", "profile", "member", "insert"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{}
			current := team
			if tc.role != "" {
				current.Membership.Role = tc.role
			}
			d := existingMemberDAO{directMemberDAO: directMemberDAO{
				team: func(context.Context, string) (model.Team, error) {
					calls = append(calls, "authorize")
					return current, tc.teamErr
				},
				member: func(context.Context, string) (model.TeamMember, error) {
					calls = append(calls, "member")
					return model.TeamMember{}, tc.memberErr
				},
				add: func(context.Context, string, model.ProjectRole) (model.TeamMember, error) {
					calls = append(calls, "insert")
					return model.TeamMember{}, tc.addErr
				},
			}, candidate: func(context.Context, string) (model.TeamMemberCandidate, error) {
				calls = append(calls, "profile")
				return model.TeamMemberCandidate{}, tc.candidateErr
			}}
			result, err := AddExistingMember(t.Context(), d, p, target)
			if result != (ExistingMemberResult{}) || !reflect.DeepEqual(calls, tc.calls) {
				t.Fatalf("result %+v calls %v", result, calls)
			}
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if !errors.Is(err, fail) {
				t.Fatalf("failure lost: %v", err)
			}
		})
	}
}
