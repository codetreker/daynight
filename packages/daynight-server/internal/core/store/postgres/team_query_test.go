package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamSnapshotRetainsMetadataAndMembershipUntilNextRead(t *testing.T) {
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
			changed, err = tx.Rename(ctx, actor.UserID, " Renamed ")
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
	if !reflect.DeepEqual(fresh, changed) || fresh.Version != team.Version+1 || fresh.Name == nil || *fresh.Name != " Renamed " || !fresh.UpdatedAt.After(team.UpdatedAt) || !reflect.DeepEqual(fresh.Membership, team.Membership) {
		t.Fatalf("fresh snapshot missed committed rename %#v", fresh)
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

func TestTeamMemberQueryCancellationPreservesFailure(t *testing.T) {
	for _, test := range []struct {
		name, fragment string
	}{
		{"snapshot team", "FROM teams t"},
		{"write actor", "FROM teams t"},
		{"target", "WHERE team_id=$1 AND user_id=$2 FOR UPDATE"},
		{"count admins", "SELECT count(*) FROM team_members"},
		{"remove", "DELETE FROM team_members"},
		{"change role", "UPDATE team_members SET role"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := t.Context()
			_, actor, _ := testAuthRecords(t, s)
			_, other, _ := testAuthRecords(t, s)
			team, err := testCreateTeam(s, ctx, actor.UserID, uuid.NewString(), "cancel")
			if err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, other.UserID)
			var before []model.TeamMemberProfile
			if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				var err error
				before, err = snapshot.TeamDAO().TeamMembers(ctx, team.ID)
				return err
			}); err != nil || len(before) != 2 {
				t.Fatalf("initial memberships: %#v %v", before, err)
			}
			opctx, cancel := context.WithCancel(ctx)
			defer cancel()
			var hit atomic.Bool
			traced := taskMutationTracedStore(t, s, taskMutationTrace{
				match: func(sql string) bool {
					matched := strings.Contains(sql, test.fragment)
					if matched {
						hit.Store(true)
					}
					return matched
				},
				cancel: cancel,
			})
			if test.name == "snapshot team" {
				err = traced.ReadSnapshot(opctx, func(snapshot SnapshotScope) error {
					_, err := snapshot.TeamDAO().Team(opctx, actor.UserID, team.ID)
					return err
				})
			} else {
				_, err = traced.WriteTeam(opctx, team.ID, func(scope TeamWriteScope) error {
					dao := scope.TeamDAO()
					switch test.name {
					case "write actor":
						_, err := dao.Team(opctx, actor.UserID)
						return err
					case "target":
						_, err := dao.Member(opctx, other.UserID)
						return err
					case "count admins":
						_, err := dao.AdminCount(opctx)
						return err
					case "remove":
						return dao.RemoveMember(opctx, other.UserID)
					case "change role":
						_, err := dao.SetMemberRole(opctx, other.UserID, model.ProjectAdmin)
						return err
					default:
						panic("unhandled Team query cancellation target")
					}
				})
			}
			if !hit.Load() || !errors.Is(err, context.Canceled) {
				t.Fatalf("query-start cancellation lost target or cause: hit=%t %v", hit.Load(), err)
			}
			var after []model.TeamMemberProfile
			if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				var err error
				after, err = snapshot.TeamDAO().TeamMembers(ctx, team.ID)
				return err
			}); err != nil || !reflect.DeepEqual(after, before) {
				t.Fatalf("query-start cancellation changed memberships: before %#v after %#v %v", before, after, err)
			}
		})
	}
}
