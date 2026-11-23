package project_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/google/uuid"
)

func TestFindVisibleRepositoryForCreation(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	reader := project.NewReader(f.tx)
	creator := project.NewCreation(f.tx, f.owner)
	add := func(team, identity string) string {
		t.Helper()
		id := uuid.NewString()
		if _, _, err := creator.InsertProject(ctx, id, "Candidate", "host:repo", identity, team); err != nil {
			t.Fatal(err)
		}
		return id
	}
	otherTeamProject := add(f.personal, "scp://host:repo")
	legacy := add(f.team, "legacy")
	exec(t, f.tx, `UPDATE projects SET repository_identity=NULL WHERE id=$1`, legacy)
	deleted := add(f.team, "scp://host:repo")
	exec(t, f.tx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, deleted)
	caseVariant := add(f.team, "scp://host:Repo")

	check := func(user, team, identity string, ids ...string) {
		t.Helper()
		got, err := reader.FindVisibleRepositoryForCreation(ctx, principal(user), team, identity)
		if err != nil || len(got) != len(ids) {
			t.Fatalf("find user=%s team=%s identity=%q: %#v %v, want %v", user, team, identity, got, err, ids)
		}
		for i, id := range ids {
			if got[i].ID != id || got[i].Ownership.TeamID != team {
				t.Fatalf("unexpected Project %d: %#v, want %s", i, got[i], id)
			}
		}
	}
	check(f.member, f.team, "scp://host:repo", f.project)
	check(f.member, f.personal, "scp://host:repo")
	check(f.owner, f.personal, "scp://host:repo", otherTeamProject)
	check(f.member, f.team, "legacy")
	check(f.member, f.team, "scp://host:Repo", caseVariant)
	check(f.guest, f.team, "scp://host:repo")
	if _, err := project.NewWriter(f.tx, f.project).CreateGrant(ctx, f.guest, model.ProjectMemberRole); err != nil {
		t.Fatal(err)
	}
	check(f.guest, f.team, "scp://host:repo", f.project)

	// An invalid historical duplicate remains detectable, but inaccessible
	// matches do not contribute to the ambiguity count.
	second := add(f.team, "scp://host:repo")
	third := add(f.team, "scp://host:repo")
	check(f.guest, f.team, "scp://host:repo", f.project)
	got, err := reader.FindVisibleRepositoryForCreation(ctx, principal(f.member), f.team, "scp://host:repo")
	if err != nil || len(got) != 2 {
		t.Fatalf("bounded ambiguous matches: %#v %v", got, err)
	}
	valid := map[string]bool{f.project: true, second: true, third: true}
	if !valid[got[0].ID] || !valid[got[1].ID] || got[0].ID == got[1].ID {
		t.Fatalf("unexpected ambiguous matches: %#v", got)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := reader.FindVisibleRepositoryForCreation(cancelled, principal(f.member), f.team, "scp://host:repo"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled query: %v", err)
	}
}

func TestRepositoryOccupancyAndIdentityReturnSuccessfulFacts(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	creator := project.NewCreation(f.tx, f.owner)
	writer := project.NewWriter(f.tx, f.project)
	for _, query := range []struct {
		team, identity string
		want           bool
	}{{f.team, "scp://host:repo", true}, {f.team, "other/repo", false}, {f.personal, "scp://host:repo", false}} {
		for _, dao := range []interface {
			RepositoryOccupied(context.Context, string, string) (bool, error)
		}{creator, writer} {
			got, err := dao.RepositoryOccupied(ctx, query.team, query.identity)
			if err != nil || got != query.want {
				t.Fatalf("occupancy team=%s identity=%s: %t %v", query.team, query.identity, got, err)
			}
		}
	}
	identity, err := writer.RepositoryIdentity(ctx)
	if err != nil || identity == nil || *identity != "scp://host:repo" {
		t.Fatalf("locked identity: %v %v", identity, err)
	}
	exec(t, f.tx, `UPDATE projects SET repository_identity=NULL WHERE id=$1`, f.project)
	identity, err = writer.RepositoryIdentity(ctx)
	if err != nil || identity != nil {
		t.Fatalf("legacy identity: %v %v", identity, err)
	}
	exec(t, f.tx, `UPDATE projects SET repository_identity='scp://host:repo',deleted_at=statement_timestamp() WHERE id=$1`, f.project)
	if occupied, err := creator.RepositoryOccupied(ctx, f.team, "scp://host:repo"); err != nil || occupied {
		t.Fatalf("deleted Project occupied repository: %t %v", occupied, err)
	}
}
