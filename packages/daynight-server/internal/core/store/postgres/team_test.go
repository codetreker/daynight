package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func storeTeamFixture(t *testing.T) (*Store, model.Principal, model.Team) {
	t.Helper()
	s := isolatedStore(t)
	actor, team := testutil.TeamFixture(t, s)
	return s, actor, team
}

func readStoreTeam(t *testing.T, s *Store, userID, teamID string) model.Team {
	t.Helper()
	var team model.Team
	err := s.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
		var err error
		team, err = snapshot.TeamDAO().Team(context.Background(), userID, teamID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return team
}

func TestTeamCreationIsAtomicAndRollbackPreservesCause(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, _ := storeTeamFixture(t)
	ctx := context.Background()
	id := uuid.NewString()
	mustQueryExec(t, s, `CREATE FUNCTION reject_team_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'member failure'; END $$;
 CREATE TRIGGER reject_team_member BEFORE INSERT ON team_members FOR EACH ROW EXECUTE FUNCTION reject_team_member()`)
	_, err := testCreateTeam(s, ctx, actor.UserID, id, "Atomic")
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Outcome != TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("creation rollback %#v %v", failure, err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM teams WHERE id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial Team persisted %d %v", count, err)
	}
	_, err = testCreateTeam(s, ctx, uuid.NewString(), uuid.NewString(), "Missing creator")
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing creator cause lost %v", err)
	}
}

func TestTeamDeleteObservesOwnershipAfterTeamLockWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	for _, commit := range []bool{false, true} {
		if !t.Run(map[bool]string{false: "writer rollback", true: "writer commit"}[commit], func(t *testing.T) {
			actor, team := testutil.TeamFixture(t, s)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			writer, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback(context.Background())
			var id string
			if err := writer.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, team.ID).Scan(&id); err != nil {
				t.Fatal(err)
			}
			projectID := uuid.NewString()
			if _, err := writer.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Created while locked','host:repo')`, projectID); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, projectID, team.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, projectID, actor.UserID); err != nil {
				t.Fatal(err)
			}
			occupied := errors.New("Team has projects")
			done := make(chan error, 1)
			var waiter sync.WaitGroup
			waiter.Go(func() {
				done <- testWriteTeamRaw(s, ctx, team.ID, func(tx TeamWriteDAO, raw pgx.Tx) error {
					var isolation string
					if err := raw.QueryRow(ctx, "SHOW transaction_isolation").Scan(&isolation); err != nil {
						return err
					}
					if isolation != "read committed" {
						return errors.New("wrong write isolation")
					}
					found, err := tx.HasProjects(ctx)
					if err != nil {
						return err
					}
					if found {
						return occupied
					}
					return tx.Delete(ctx)
				})
			})
			defer func() {
				cancel()
				_ = writer.Rollback(context.Background())
				waiter.Wait()
			}()
			testutil.WaitTransferTeamLock(t, ctx, s.Pool, "SELECT id::text FROM teams WHERE", writer.Conn().PgConn().PID())
			if commit {
				err = writer.Commit(ctx)
			} else {
				err = writer.Rollback(ctx)
			}
			if err != nil {
				t.Fatal(err)
			}
			err = receiveQueryResult(t, ctx, done)
			if commit {
				if !errors.Is(err, occupied) {
					t.Fatalf("delete missed just-committed ownership %v", err)
				}
				_ = readStoreTeam(t, s, actor.UserID, team.ID)
				var name, repo string
				var owner string
				if err := s.Pool.QueryRow(ctx, `SELECT p.name,p.repo_url,o.team_id::text FROM projects p JOIN project_ownership o ON o.project_id=p.id WHERE p.id=$1`, projectID).Scan(&name, &repo, &owner); err != nil || name != "Created while locked" || repo != "host:repo" || owner != team.ID {
					t.Fatalf("occupied Team refusal changed Project: %q %q %q %v", name, repo, owner, err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				var count int
				if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM teams WHERE id=$1`, team.ID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("empty Team not deleted %d %v", count, err)
				}
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, s.Pool)
	}
	for _, remove := range []bool{false, true} {
		if !t.Run(map[bool]string{false: "actor demoted while locked", true: "actor removed while locked"}[remove], func(t *testing.T) {
			actor, team := testutil.TeamFixture(t, s)
			_, observer, _ := testAuthRecords(t, s)
			_, target, _ := testAuthRecords(t, s)
			mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, team.ID, observer.UserID, target.UserID)
			before := readStoreTeam(t, s, observer.UserID, team.ID)
			targetBefore := readStoreTeam(t, s, target.UserID, team.ID).Membership
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			holder, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err := holder.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			var waiter sync.WaitGroup
			waiter.Go(func() {
				_, err := s.WriteTeam(ctx, team.ID, func(scope TeamWriteScope) error {
					current, err := scope.TeamDAO().Team(ctx, actor.UserID)
					if remove {
						if !errors.Is(err, model.ErrNotFound) {
							return fmt.Errorf("removed actor still readable: %#v %v", current, err)
						}
					} else if err != nil || current.Membership.Role != model.ProjectMemberRole || current.Membership.Version <= team.Membership.Version {
						return fmt.Errorf("actor role predates Team lock release: %#v %v", current, err)
					}
					member, err := scope.TeamDAO().Member(ctx, target.UserID)
					if err != nil || !reflect.DeepEqual(member, targetBefore) {
						return fmt.Errorf("unrelated target changed: %#v %v", member, err)
					}
					return nil
				})
				done <- err
			})
			defer func() {
				cancel()
				_ = holder.Rollback(context.Background())
				waiter.Wait()
			}()
			testutil.WaitTransferTeamLock(t, ctx, s.Pool, "SELECT id::text FROM teams WHERE", holder.Conn().PgConn().PID())
			dao := teamstore.NewWriter(holder, team.ID)
			if remove {
				err = dao.RemoveMember(ctx, actor.UserID)
			} else {
				_, err = dao.SetMemberRole(ctx, actor.UserID, model.ProjectMemberRole)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := receiveQueryResult(t, ctx, done); err != nil {
				t.Fatal(err)
			}
			if after := readStoreTeam(t, s, observer.UserID, team.ID); !reflect.DeepEqual(after, before) {
				t.Fatalf("actor refresh changed Team or observer: before %#v after %#v", before, after)
			}
			if after := readStoreTeam(t, s, target.UserID, team.ID).Membership; !reflect.DeepEqual(after, targetBefore) {
				t.Fatalf("actor refresh changed target: before %#v after %#v", targetBefore, after)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, s.Pool)
	}
}

func TestTeamDeletionLockPreventsNewOrphanOwnership(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "delete commits", true: "delete rolls back"}[rollback], func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			deleted := errors.New("rollback deletion")
			done := make(chan error, 1)
			projectID := uuid.NewString()
			err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error {
				if err := tx.Delete(ctx); err != nil {
					return err
				}
				go func() {
					writer, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
					if err != nil {
						done <- err
						return
					}
					done <- transact(ctx, writer, func(tx pgx.Tx) error {
						var id string
						if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, team.ID).Scan(&id); err != nil {
							return err
						}
						if _, err := tx.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Locked creation','host:repo')`, projectID); err != nil {
							return err
						}
						_, err := tx.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, projectID, team.ID)
						return err
					})
				}()
				waitForQueryLock(t, s, "SELECT id::text FROM teams WHERE")
				if rollback {
					return deleted
				}
				return nil
			})
			if rollback && !errors.Is(err, deleted) || !rollback && err != nil {
				t.Fatalf("delete outcome %v", err)
			}
			writerErr := receiveQueryResult(t, ctx, done)
			if rollback {
				if writerErr != nil {
					t.Fatal(writerErr)
				}
				_ = readStoreTeam(t, s, actor.UserID, team.ID)
			} else if !errors.Is(writerErr, pgx.ErrNoRows) {
				t.Fatalf("writer accepted deleted Team %v", writerErr)
			}
			var count int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_ownership WHERE project_id=$1`, projectID).Scan(&count); err != nil || count != map[bool]int{false: 0, true: 1}[rollback] {
				t.Fatalf("ownership existence %d %v", count, err)
			}
		})
	}
}

func TestTeamCancellationRollsBackAndDoesNotRunLateCallback(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := testWriteTeam(s, ctx, team.ID, func(tx TeamWriteDAO) error { _, err := tx.Rename(ctx, actor.UserID, "Changed"); cancel(); return err })
	var failure *TransactionError
	if !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Outcome != TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("canceled completion %#v %v", failure, err)
	}
	if got := readStoreTeam(t, s, actor.UserID, team.ID); !reflect.DeepEqual(got, team) {
		t.Fatalf("canceled rename persisted %#v", got)
	}
	holder, err := s.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(context.Background(), `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
		t.Fatal(err)
	}
	waiting, stop := context.WithCancel(context.Background())
	defer stop()
	var called atomic.Bool
	done := make(chan error, 1)
	go func() {
		done <- testWriteTeam(s, waiting, team.ID, func(TeamWriteDAO) error { called.Store(true); return nil })
	}()
	waitForQueryLock(t, s, "SELECT id::text FROM teams WHERE")
	stop()
	bounded, finish := context.WithTimeout(context.Background(), 5*time.Second)
	defer finish()
	if err := receiveQueryResult(t, bounded, done); !errors.Is(err, context.Canceled) || called.Load() {
		t.Fatalf("late callback %v %v", called.Load(), err)
	}
}

func TestTeamCommitResponseLossRetainsCommittedResult(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("private commit reply lost")
	err = transact(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, team.ID).Scan(&id); err != nil {
			return err
		}
		_, err := teamstore.NewWriter(tx, team.ID).Rename(ctx, actor.UserID, "Committed")
		return err
	})
	var failure *TransactionError
	if !errors.Is(err, lost) || !errors.As(err, &failure) || failure.Outcome != TransactionUnknown || !failure.CommitAttempted {
		t.Fatalf("lost receipt %#v %v", failure, err)
	}
	got := readStoreTeam(t, s, actor.UserID, team.ID)
	if *got.Name != "Committed" || got.Version != 2 {
		t.Fatalf("actual commit disappeared %#v", got)
	}
}

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
	parallelRootDatabaseTest(t)
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
