package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamSnapshotRetainsMetadataAndMembershipUntilNextRead(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	var changed model.Team
	err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		before, err := snapshot.TeamDAO().Teams(ctx, actor.UserID, Page{Limit: 100})
		if err != nil {
			return err
		}
		if len(before.Items) != 2 {
			t.Fatalf("initial joined list %#v", before)
		}
		err = testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
			var err error
			changed, err = tx.Rename(ctx, actor.UserID, "Changed after snapshot")
			return err
		})
		if err != nil {
			return err
		}
		observed, err := snapshot.TeamDAO().Team(ctx, actor.UserID, team.ID)
		if err == nil && !reflect.DeepEqual(observed, team) {
			t.Fatalf("repeatable snapshot mixed metadata %#v", observed)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	fresh := readStoreTeam(t, s, actor.UserID, team.ID)
	if !reflect.DeepEqual(fresh, changed) || fresh.Version != team.Version+1 || *fresh.Name != "Changed after snapshot" {
		t.Fatalf("fresh snapshot missed committed rename %#v", fresh)
	}
}

func TestTeamRenameAndDeleteSQLFailuresRollbackCompleteLifecycle(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, operation := range []string{"rename", "delete members", "delete Team"} {
		t.Run(operation, func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			triggerTable, event := "teams", "UPDATE"
			if operation == "delete members" {
				triggerTable, event = "team_members", "DELETE"
			}
			if operation == "delete Team" {
				event = "DELETE"
			}
			mustQueryExec(t, s, `CREATE FUNCTION refuse_team_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lifecycle failure'; END $$;
    CREATE TRIGGER refuse_team_lifecycle BEFORE `+event+` ON `+triggerTable+` FOR EACH ROW EXECUTE FUNCTION refuse_team_lifecycle()`)
			err := testWriteTeam(s, context.Background(), team.ID, func(tx TeamWriteDAO) error {
				if operation == "rename" {
					_, err := tx.Rename(context.Background(), actor.UserID, "Uncommitted")
					return err
				}
				return tx.Delete(context.Background())
			})
			var transaction *TransactionError
			var database *pgconn.PgError
			if !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted || transaction.CommitAttempted || !errors.As(err, &database) || database.Code != "P0001" {
				t.Fatalf("failed lifecycle completion %#v %v", transaction, err)
			}
			after := readStoreTeam(t, s, actor.UserID, team.ID)
			if !reflect.DeepEqual(after, team) {
				t.Fatalf("SQL failure partially changed Team/membership: before %#v after %#v", team, after)
			}
		})
	}
}
