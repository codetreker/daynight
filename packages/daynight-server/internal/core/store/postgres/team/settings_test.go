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

func TestSettingsWriteFailureRollsBack(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	p, team := testutil.TeamFixture(t, s)
	ctx := t.Context()
	testutil.MustExec(t, s.Pool, `CREATE FUNCTION refuse_nested_setting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected settings failure'; END $$`)
	testutil.MustExec(t, s.Pool, `CREATE TRIGGER refuse_nested_setting BEFORE UPDATE OF allow_nested_subtask ON teams FOR EACH ROW EXECUTE FUNCTION refuse_nested_setting()`)
	completion, err := s.WriteTeam(ctx, team.ID, func(scope store.TeamWriteScope) error {
		_, err := scope.TeamDAO().SetNestedSubtask(ctx, p.UserID, true)
		return err
	})
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("completion=%+v err=%v", completion, err)
	}
	if err := s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		actual, err := scope.TeamDAO().Team(ctx, p.UserID, team.ID)
		if err == nil && (actual.AllowNestedSubtask || actual.Version != team.Version) {
			t.Fatalf("failed write changed Team: %+v", actual)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
