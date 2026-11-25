package team_test

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestSettingsPersistWithTeamVersion(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	p, team := testutil.TeamFixture(t, s)
	ctx := context.Background()
	if team.AllowNestedSubtask {
		t.Fatal("new Team must default to disabled")
	}
	const version int64 = 9007199254740993
	testutil.MustExec(t, s.Pool, `UPDATE teams SET version=$2 WHERE id=$1`, team.ID, version)
	var written model.Team
	completion, err := s.WriteTeam(ctx, team.ID, func(scope store.TeamWriteScope) error {
		var err error
		written, err = scope.TeamDAO().SetNestedSubtask(ctx, p.UserID, true)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || !written.AllowNestedSubtask || written.Version != version+1 {
		t.Fatalf("write=%+v completion=%+v err=%v", written, completion, err)
	}
	err = s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		actual, err := scope.TeamDAO().Team(ctx, p.UserID, team.ID)
		if err == nil && (!actual.AllowNestedSubtask || actual.Version != version+1) {
			t.Fatalf("read=%+v", actual)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
