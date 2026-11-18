package project_test

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"testing"
)

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
