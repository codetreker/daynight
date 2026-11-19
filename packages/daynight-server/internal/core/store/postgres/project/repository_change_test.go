package project_test

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/google/uuid"
)

func TestRepositoryChangeFactsOccupancyAndVersions(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	dao := project.NewRepositoryDAO(f.tx, f.project)
	facts, err := dao.RepositoryFacts(ctx, principal(f.owner))
	if err != nil || facts.Version != 1 || facts.Project.RepoURL != "host:repo" || facts.Identity == nil || *facts.Identity != "scp://host:repo" || facts.Access.Role != model.ProjectAdmin || facts.Project.Ownership.TeamID != f.team {
		t.Fatalf("initial facts: %+v %v", facts, err)
	}
	if _, err := dao.RepositoryFacts(ctx, principal(f.guest)); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("outsider facts: %v", err)
	}
	checkOccupancy := func(team, identity string, want bool) {
		t.Helper()
		got, err := dao.RepositoryOccupiedByOther(ctx, team, identity)
		if err != nil || got != want {
			t.Fatalf("occupancy %s %s: %v %v", team, identity, got, err)
		}
	}
	checkOccupancy(f.team, "scp://host:repo", false)
	other := uuid.NewString()
	_, _, err = project.NewCreation(f.tx, f.owner).InsertProject(ctx, other, "Other", "host:other", "scp://host:other", f.team)
	if err != nil {
		t.Fatal(err)
	}
	checkOccupancy(f.team, "scp://host:other", true)
	checkOccupancy(f.personal, "scp://host:other", false)
	exec(t, f.tx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, other)
	checkOccupancy(f.team, "scp://host:other", false)
	version, ok, err := dao.SaveRepository(ctx, "host:repo", "scp://host:repo", 1)
	if err != nil || ok || version != 0 {
		t.Fatalf("unchanged save: %d %v %v", version, ok, err)
	}
	version, ok, err = dao.SaveRepository(ctx, "host:new", "scp://host:new", 1)
	if err != nil || !ok || version != 2 {
		t.Fatalf("save: %d %v %v", version, ok, err)
	}
	if _, ok, err := dao.SaveRepository(ctx, "host:repo", "scp://host:repo", 1); err != nil || ok {
		t.Fatalf("stale save: %v %v", ok, err)
	}
	version, ok, err = dao.SaveRepository(ctx, "host:repo", "scp://host:repo", 2)
	if err != nil || !ok || version != 3 {
		t.Fatalf("ABA save: %d %v %v", version, ok, err)
	}
	facts, err = dao.RepositoryFacts(ctx, principal(f.owner))
	if err != nil || facts.Version != 3 || facts.Project.RepoURL != "host:repo" || facts.Identity == nil || *facts.Identity != "scp://host:repo" {
		t.Fatalf("saved facts: %+v %v", facts, err)
	}
	exec(t, f.tx, `UPDATE projects SET repository_version=$2 WHERE id=$1`, f.project, int64(math.MaxInt64))
	if _, ok, err := dao.SaveRepository(ctx, "host:full", "scp://host:full", math.MaxInt64); err != nil || ok {
		t.Fatalf("exhausted save: %v %v", ok, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := dao.RepositoryFacts(cancelled, principal(f.owner)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled facts: %v", err)
	}
}
