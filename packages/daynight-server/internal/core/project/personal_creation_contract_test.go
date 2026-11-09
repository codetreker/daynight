package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type personalCreationPlan struct {
	store.ProjectCreationDAO
	t        *testing.T
	ctx      context.Context
	calls    []string
	position int
	target   store.ProjectCreationTeam
	facts    store.PersonalTeamFacts
}

func (p *personalCreationPlan) call(ctx context.Context, name string) {
	p.t.Helper()
	if ctx != p.ctx || p.position >= len(p.calls) || p.calls[p.position] != name {
		p.t.Fatalf("unexpected creation call %q at %d, plan=%v", name, p.position, p.calls)
	}
	p.position++
}

func (p *personalCreationPlan) CreationPersonalTeam(ctx context.Context, lock bool) (store.PersonalTeamFacts, error) {
	name := "personal checked"
	if lock {
		name = "personal locked"
	}
	p.call(ctx, name)
	return p.facts, nil
}

func (p *personalCreationPlan) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	p.call(ctx, "team locked")
	if id != p.target.ID {
		p.t.Fatalf("creation target=%s want=%s", id, p.target.ID)
	}
	return p.target, nil
}

func TestPersonalIntegrityFailuresAreNotRepairedByProjectCreation(t *testing.T) {
	for _, tc := range []struct {
		name            string
		members, admins int64
	}{{"missing-owner", 0, 0}, {"wrong-role", 1, 0}, {"additional-member", 2, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			facts := store.PersonalTeamFacts{ID: testTeam, MemberCount: tc.members, OwnerAdminCount: tc.admins}
			plan := &personalCreationPlan{t: t, ctx: ctx, calls: []string{"personal locked"}, facts: facts}
			project, access, err := Create(ctx, plan, testUser, testProject, CreateProject{Name: "Invalid", RepoURL: "host:repo"})
			if err == nil || errors.Is(err, model.ErrNotFound) || project != (model.Project{}) || access.ProjectID != "" || plan.position != len(plan.calls) || !reflect.DeepEqual(plan.facts, facts) {
				t.Fatalf("invalid Personal ownership admitted or rewritten: project=%#v access=%#v facts=%#v error=%v", project, access, plan.facts, err)
			}
		})
	}
}

func TestExplicitPersonalProjectCreationRejectsOtherOwnerAndCorruptMembership(t *testing.T) {
	for _, tc := range []struct {
		name            string
		owner           string
		members, admins int64
	}{{"other owner", "other", 1, 1}, {"missing membership", testUser, 0, 0}, {"wrong role", testUser, 1, 0}, {"extra member", testUser, 2, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			calls := []string{"team locked"}
			if tc.owner == testUser {
				calls = append(calls, "personal checked")
			}
			target := testTeam
			plan := &personalCreationPlan{t: t, ctx: ctx, calls: calls, target: store.ProjectCreationTeam{ID: target, PersonalUserID: &tc.owner}, facts: store.PersonalTeamFacts{ID: target, MemberCount: tc.members, OwnerAdminCount: tc.admins}}
			project, access, err := Create(ctx, plan, testUser, testProject, CreateProject{Name: "Rejected", RepoURL: "host:repo", TeamID: &target})
			if err == nil || project != (model.Project{}) || access.ProjectID != "" || plan.position != len(plan.calls) || errors.Is(err, model.ErrNotFound) != (tc.owner != testUser) {
				t.Fatalf("personal creation rejection: project=%#v access=%#v calls=%d error=%v", project, access, plan.position, err)
			}
			if tc.owner == testUser && err.Error() != "Personal Team owner membership is invalid" {
				t.Fatalf("Personal integrity cause lost: %v", err)
			}
		})
	}
}
