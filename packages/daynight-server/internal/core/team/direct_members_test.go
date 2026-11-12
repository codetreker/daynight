package team

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type directMemberDAO struct {
	store.TeamWriteDAO
	team   func(context.Context, string) (model.Team, error)
	member func(context.Context, string) (model.TeamMember, error)
	add    func(context.Context, string, model.ProjectRole) (model.TeamMember, error)
}

func (d directMemberDAO) Team(ctx context.Context, id string) (model.Team, error) {
	return d.team(ctx, id)
}
func (d directMemberDAO) Member(ctx context.Context, id string) (model.TeamMember, error) {
	return d.member(ctx, id)
}
func (d directMemberDAO) AddMember(ctx context.Context, id string, role model.ProjectRole) (model.TeamMember, error) {
	return d.add(ctx, id, role)
}

func TestValidateDirectMemberRequiresActorTeamAndExplicitRole(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	for _, role := range []model.ProjectRole{model.ProjectAdmin, model.ProjectMemberRole} {
		got, err := ValidateAddMember(p, id, p.UserID, role)
		if got != id || err != nil {
			t.Fatalf("valid role %s: %q %v", role, got, err)
		}
	}
	for _, tc := range []struct {
		name, id, expected string
		role               model.ProjectRole
		p                  model.Principal
		code               string
	}{
		{"no actor", id, p.UserID, model.ProjectAdmin, model.Principal{}, "unauthenticated"},
		{"missing fence", id, "", model.ProjectAdmin, p, "invalid_input"},
		{"zero fence", id, uuid.Nil.String(), model.ProjectAdmin, p, "invalid_input"},
		{"noncanonical fence", id, strings.ToUpper(p.UserID), model.ProjectAdmin, p, "invalid_input"},
		{"target as actor", id, uuid.NewString(), model.ProjectAdmin, p, "identity_mismatch"},
		{"bad Team", "invalid", p.UserID, model.ProjectAdmin, p, "invalid_input"},
		{"zero Team", uuid.Nil.String(), p.UserID, model.ProjectAdmin, p, "invalid_input"},
		{"missing role", id, p.UserID, "", p, "invalid_input"},
		{"unsupported role", id, p.UserID, "owner", p, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateAddMember(tc.p, tc.id, tc.expected, tc.role)
			if got != "" {
				t.Fatalf("returned ID %s", got)
			}
			faultCode(t, err, tc.code)
		})
	}
}

func TestDirectMemberAuthorizationRejectsBeforeTargetAccess(t *testing.T) {
	p := principal()
	team := namedTeam(p)
	for _, tc := range []struct {
		name   string
		mutate func(*model.Team)
		err    error
		code   string
	}{
		{name: "unseen Team", err: model.ErrNotFound, code: "not_found"},
		{name: "store failure", err: fail},
		{name: "member actor", mutate: func(t *model.Team) { t.Membership.Role = model.ProjectMemberRole }, code: "forbidden"},
		{name: "Personal Team", mutate: func(t *model.Team) { t.Kind = "personal" }, code: "personal_team_immutable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item := team
			if tc.mutate != nil {
				tc.mutate(&item)
			}
			calls := 0
			d := directMemberDAO{team: func(ctx context.Context, id string) (model.Team, error) {
				calls++
				if ctx != t.Context() || id != p.UserID {
					t.Fatal("actor/context changed")
				}
				return item, tc.err
			}}
			got, err := AddMember(t.Context(), d, p, uuid.NewString(), model.ProjectMemberRole)
			if got != (DirectMemberResult{}) || calls != 1 {
				t.Fatalf("result %#v calls %d", got, calls)
			}
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if !errors.Is(err, tc.err) {
				t.Fatalf("cause lost: %v", err)
			}
		})
	}
}

func TestDirectMemberReadsExistingOrInsertsExplicitRole(t *testing.T) {
	p := principal()
	team := namedTeam(p)
	target := uuid.NewString()
	for _, role := range []model.ProjectRole{model.ProjectAdmin, model.ProjectMemberRole} {
		for _, existing := range []bool{false, true} {
			t.Run(string(role)+map[bool]string{false: " insert", true: " existing"}[existing], func(t *testing.T) {
				member := team.Membership
				member.UserID = target
				member.Role = role
				calls := []string{}
				d := directMemberDAO{
					team: func(ctx context.Context, actor string) (model.Team, error) {
						calls = append(calls, "actor")
						if ctx != t.Context() || actor != p.UserID {
							t.Fatal("actor/context changed")
						}
						return team, nil
					},
					member: func(ctx context.Context, id string) (model.TeamMember, error) {
						calls = append(calls, "target")
						if ctx != t.Context() || id != target {
							t.Fatal("target/context changed")
						}
						if existing {
							return member, nil
						}
						return model.TeamMember{}, model.ErrNotFound
					},
					add: func(ctx context.Context, id string, gotRole model.ProjectRole) (model.TeamMember, error) {
						calls = append(calls, "add")
						if ctx != t.Context() || id != target || gotRole != role {
							t.Fatal("insert input changed")
						}
						return member, nil
					},
				}
				result, err := AddMember(t.Context(), d, p, target, role)
				wantCalls := []string{"actor", "target"}
				if !existing {
					wantCalls = append(wantCalls, "add")
				}
				if err != nil || result.Added == existing || result.Membership != member || !reflect.DeepEqual(calls, wantCalls) {
					t.Fatalf("result %#v calls %v error %v", result, calls, err)
				}
			})
		}
	}
}

func TestDirectMemberConflictsAndFailuresDoNotExposeMembership(t *testing.T) {
	p := principal()
	team := namedTeam(p)
	target := uuid.NewString()
	for _, tc := range []struct {
		name              string
		member            model.TeamMember
		memberErr, addErr error
		code              string
	}{
		{name: "different role", member: team.Membership, code: "resource_conflict"},
		{name: "member read failure", memberErr: fail},
		{name: "insert failure", memberErr: model.ErrNotFound, addErr: fail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			d := directMemberDAO{team: func(context.Context, string) (model.Team, error) { return team, nil }, member: func(context.Context, string) (model.TeamMember, error) { return tc.member, tc.memberErr }, add: func(context.Context, string, model.ProjectRole) (model.TeamMember, error) {
				calls++
				return team.Membership, tc.addErr
			}}
			result, err := AddMember(t.Context(), d, p, target, model.ProjectMemberRole)
			if result != (DirectMemberResult{}) || calls != map[bool]int{false: 0, true: 1}[tc.addErr != nil] {
				t.Fatalf("result %#v inserts %d", result, calls)
			}
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if !errors.Is(err, fail) {
				t.Fatalf("cause lost: %v", err)
			}
		})
	}
}

func TestTeamWriteFaultInspectsEveryJoinedCompletion(t *testing.T) {
	unknown := &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: fail}
	cleanup := &store.TransactionError{Phase: "rollback", CleanupFailed: true, Outcome: store.TransactionNotCommitted, Cause: fail}
	ordinary := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
	for _, tc := range []struct {
		name string
		err  error
		code string
	}{
		{"unknown joined cleanup", errors.Join(unknown, cleanup), "internal_error"},
		{"cleanup joined unknown", errors.Join(cleanup, unknown), "internal_error"},
		{"wrapped nested cleanup", fmt.Errorf("completion: %w", errors.Join(ordinary, fmt.Errorf("cleanup: %w", cleanup))), "internal_error"},
		{"unknown after operation", errors.Join(ordinary, unknown), "write_outcome_unknown"},
		{"domain before abnormal", errors.Join(ordinary, &store.TransactionError{Phase: "commit", Outcome: store.TransactionCommitted}), "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fault, classified := WriteFault(tc.err)
			if !classified || fault.Code != tc.code || !errors.Is(fault, fail) && tc.name != "domain before abnormal" {
				t.Fatalf("classification %#v %t", fault, classified)
			}
		})
	}
}
