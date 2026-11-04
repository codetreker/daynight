package store

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamSnapshotsPaginateJoinedMembershipsAndPreciseMetadata(t *testing.T) {
	s, actor, first := storeTeamFixture(t)
	ctx := context.Background()
	_, other, _ := testAuthRecords(t, s)
	if _, err := s.CreateTeam(ctx, other.UserID, uuid.NewString(), "An invisible Team between visible rows"); err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateTeam(ctx, actor.UserID, uuid.NewString(), "Same visible name")
	if err != nil {
		t.Fatal(err)
	}
	const metadataVersion int64 = 9007199254740993
	const memberVersion int64 = 9007199254740995
	mustQueryExec(t, s, `UPDATE teams SET version=$2 WHERE id=$1`, first.ID, metadataVersion)
	mustQueryExec(t, s, `UPDATE team_members SET version=$3 WHERE team_id=$1 AND user_id=$2`, first.ID, actor.UserID, memberVersion)
	var ids []string
	var page Page
	page.Limit = 1
	for {
		var result TeamPage
		if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			var err error
			result, err = snapshot.Teams(ctx, actor.UserID, page)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if result.Items == nil || len(result.Items) != 1 {
			t.Fatalf("membership-filtered page %#v", result)
		}
		team := result.Items[0]
		if team.Membership.UserID != actor.UserID || team.Membership.TeamID != team.ID {
			t.Fatalf("wrong actor membership %#v", team)
		}
		if team.ID == first.ID && (team.Version != metadataVersion || team.Membership.Version != memberVersion) {
			t.Fatalf("rounded versions %#v", team)
		}
		if len(ids) == 0 && (team.Kind != "personal" || team.Name != nil || team.Membership.Role != core.ProjectAdmin) {
			t.Fatalf("Personal projection %#v", team)
		}
		ids = append(ids, team.ID)
		page.After = &Position{CreatedAt: team.CreatedAt, ID: team.ID}
		if !result.HasMore {
			break
		}
	}
	if len(ids) != 3 || ids[1] != first.ID || ids[2] != second.ID {
		t.Fatalf("joined list pagination/order %#v", ids)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		last, err := snapshot.Teams(ctx, actor.UserID, page)
		if err == nil && (last.Items == nil || len(last.Items) != 0 || last.HasMore) {
			t.Fatalf("empty final page %#v", last)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTeamSnapshotRetainsMetadataAndMembershipUntilNextRead(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	var changed core.Team
	err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		before, err := snapshot.Teams(ctx, actor.UserID, Page{Limit: 100})
		if err != nil {
			return err
		}
		if len(before.Items) != 2 {
			t.Fatalf("initial joined list %#v", before)
		}
		err = s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
			var err error
			changed, err = tx.Rename(ctx, actor.UserID, "Changed after snapshot")
			return err
		})
		if err != nil {
			return err
		}
		observed, err := snapshot.Team(ctx, actor.UserID, team.ID)
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

func TestTeamSnapshotAbsenceCancellationAndStoredIntegrityFailures(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	_, outsider, _ := testAuthRecords(t, s)
	for _, target := range []struct{ userID, teamID string }{{outsider.UserID, team.ID}, {actor.UserID, uuid.NewString()}} {
		err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error { _, err := snapshot.Team(ctx, target.userID, target.teamID); return err })
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("missing Team membership cause %v", err)
		}
	}
	err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		_, err := snapshot.Teams(canceled, actor.UserID, Page{Limit: 1})
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled list cause was lost %v", err)
	}
	var personalID string
	if err := s.Pool.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, actor.UserID).Scan(&personalID); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, s, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, personalID, actor.UserID)
	for _, read := range []func(*Snapshot) error{
		func(snapshot *Snapshot) error { _, err := snapshot.Team(ctx, actor.UserID, personalID); return err },
		func(snapshot *Snapshot) error {
			page, err := snapshot.Teams(ctx, actor.UserID, Page{Limit: 100})
			if err != nil && page.Items != nil {
				t.Fatal("corrupt membership published a partial page")
			}
			return err
		},
	} {
		err := s.ReadSnapshot(ctx, read)
		var failure *Error
		if err == nil || errors.Is(err, core.ErrNotFound) || !errors.As(err, &failure) {
			t.Fatalf("invalid Personal owner was accepted/hidden %v", err)
		}
	}
}

func TestTeamRenameAndDeleteSQLFailuresRollbackCompleteLifecycle(t *testing.T) {
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
			err := s.WriteTeam(context.Background(), team.ID, func(tx *TeamTx) error {
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
