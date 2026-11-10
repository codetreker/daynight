package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

type teamQueryState struct {
	team    model.Team
	members []model.TeamMemberProfile
}

func readTeamQueryState(t *testing.T, ctx context.Context, database *Store, actor, teamID string) teamQueryState {
	t.Helper()
	var state teamQueryState
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		dao := snapshot.TeamDAO()
		var err error
		state.team, err = dao.Team(ctx, actor, teamID)
		if err != nil {
			return err
		}
		state.members, err = dao.TeamMembers(ctx, teamID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestTeamRenameAndDeleteSQLFailuresRollbackCompleteLifecycle(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, team := storeTeamFixture(t)
	baseline := readTeamQueryState(t, t.Context(), s, actor.UserID, team.ID)
	if !reflect.DeepEqual(baseline.team, team) {
		t.Fatalf("initial Team differs from its fixture: got %#v want %#v", baseline.team, team)
	}
	for _, operation := range []string{"rename", "delete members", "delete Team"} {
		if !t.Run(operation, func(t *testing.T) {
			ctx := t.Context()
			if before := readTeamQueryState(t, ctx, s, actor.UserID, team.ID); !reflect.DeepEqual(before, baseline) {
				t.Fatalf("lifecycle failure case inherited changed state: before %#v want %#v", before, baseline)
			}
			triggerTable, event := "teams", "UPDATE"
			if operation == "delete members" {
				triggerTable, event = "team_members", "DELETE"
			}
			if operation == "delete Team" {
				event = "DELETE"
			}
			const fault = "refuse_team_lifecycle"
			t.Cleanup(func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if _, err := s.Pool.Exec(cleanup, "DROP TRIGGER IF EXISTS "+pgx.Identifier{fault}.Sanitize()+" ON "+pgx.Identifier{triggerTable}.Sanitize()); err != nil {
					t.Errorf("remove lifecycle fault trigger: %v", err)
				}
				if _, err := s.Pool.Exec(cleanup, "DROP FUNCTION IF EXISTS "+pgx.Identifier{fault}.Sanitize()+"()"); err != nil {
					t.Errorf("remove lifecycle fault function: %v", err)
				}
				if err := checkFaultTriggerRemoved(cleanup, s, fault, triggerTable); err != nil {
					t.Error(err)
				}
			})
			mustQueryExec(t, s, `CREATE FUNCTION refuse_team_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lifecycle failure'; END $$;
    CREATE TRIGGER refuse_team_lifecycle BEFORE `+event+` ON `+triggerTable+` FOR EACH ROW EXECUTE FUNCTION refuse_team_lifecycle()`)
			err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
				if operation == "rename" {
					_, err := tx.Rename(ctx, actor.UserID, "Uncommitted")
					return err
				}
				return tx.Delete(ctx)
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
			if after := readTeamQueryState(t, ctx, s, actor.UserID, team.ID); !reflect.DeepEqual(after, baseline) {
				t.Fatalf("SQL failure changed complete Team/member state: before %#v after %#v", baseline, after)
			}
		}) {
			t.FailNow()
		}
	}
}

func TestTeamMemberQueryCancellationPreservesFailure(t *testing.T) {
	s := isolatedStore(t)
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, s)
	_, other, _ := testAuthRecords(t, s)
	team, err := testCreateTeam(s, ctx, actor.UserID, uuid.NewString(), "cancel")
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, other.UserID)
	baseline := readTeamQueryState(t, ctx, s, actor.UserID, team.ID)
	if len(baseline.members) != 2 {
		t.Fatalf("initial memberships: %#v", baseline.members)
	}
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
		if !t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			before := readTeamQueryState(t, ctx, s, actor.UserID, team.ID)
			if !reflect.DeepEqual(before, baseline) {
				t.Fatalf("query cancellation case inherited changed state: before %#v want %#v", before, baseline)
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
			var err error
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
			after := readTeamQueryState(t, ctx, s, actor.UserID, team.ID)
			if !reflect.DeepEqual(after.members, before.members) {
				t.Fatalf("query-start cancellation changed memberships: before %#v after %#v", before.members, after.members)
			}
			if !reflect.DeepEqual(after, baseline) {
				t.Fatalf("query-start cancellation changed complete Team/member state: before %#v after %#v", baseline, after)
			}
			assertMigrationPoolReusable(t, traced.Pool)
		}) {
			t.FailNow()
		}
	}
}
