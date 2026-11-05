package store

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func storeTeamFixture(t *testing.T) (*Store, model.Principal, model.Team) {
	t.Helper()
	s := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, s)
	team, err := s.CreateTeam(context.Background(), actor.UserID, uuid.NewString(), "Ordinary")
	if err != nil {
		t.Fatal(err)
	}
	return s, actor, team
}

func readStoreTeam(t *testing.T, s *Store, userID, teamID string) model.Team {
	t.Helper()
	var team model.Team
	err := s.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
		var err error
		team, err = snapshot.Team(context.Background(), userID, teamID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return team
}

func TestTeamCreationIsAtomicAndRollbackPreservesCause(t *testing.T) {
	s, actor, _ := storeTeamFixture(t)
	ctx := context.Background()
	id := uuid.NewString()
	mustQueryExec(t, s, `CREATE FUNCTION reject_team_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'member failure'; END $$;
 CREATE TRIGGER reject_team_member BEFORE INSERT ON team_members FOR EACH ROW EXECUTE FUNCTION reject_team_member()`)
	_, err := s.CreateTeam(ctx, actor.UserID, id, "Atomic")
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Outcome != TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("creation rollback %#v %v", failure, err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM teams WHERE id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial Team persisted %d %v", count, err)
	}
	_, err = s.CreateTeam(ctx, uuid.NewString(), uuid.NewString(), "Missing creator")
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing creator cause lost %v", err)
	}
}

func TestTeamDeleteObservesOwnershipAfterTeamLockWait(t *testing.T) {
	for _, commit := range []bool{false, true} {
		t.Run(map[bool]string{false: "writer rollback", true: "writer commit"}[commit], func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
			go func() {
				done <- s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
					var isolation string
					if err := tx.tx.QueryRow(ctx, "SHOW transaction_isolation").Scan(&isolation); err != nil {
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
			}()
			waitForQueryLock(t, s, "SELECT id::text FROM teams WHERE")
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
			} else {
				if err != nil {
					t.Fatal(err)
				}
				var count int
				if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM teams WHERE id=$1`, team.ID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("empty Team not deleted %d %v", count, err)
				}
			}
		})
	}
}

func TestTeamDeletionLockPreventsNewOrphanOwnership(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "delete commits", true: "delete rolls back"}[rollback], func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			deleted := errors.New("rollback deletion")
			done := make(chan error, 1)
			projectID := uuid.NewString()
			err := s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
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

func TestTeamOwnershipCheckDoesNotLockProject(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	project, err := s.CreatePrivateProject(ctx, actor, uuid.NewString(), "Existing", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, s, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, team.ID)
	holder, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	bounded, finish := context.WithTimeout(ctx, time.Second)
	defer finish()
	err = s.WriteTeam(bounded, team.ID, func(tx *TeamTx) error {
		found, err := tx.HasProjects(bounded)
		if err == nil && !found {
			return errors.New("ownership disappeared")
		}
		return err
	})
	if err != nil {
		t.Fatalf("Team-only check waited for existing Project lock %v", err)
	}
}

func TestTeamCancellationRollsBackAndDoesNotRunLateCallback(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error { _, err := tx.Rename(ctx, actor.UserID, "Changed"); cancel(); return err })
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
	go func() { done <- s.WriteTeam(waiting, team.ID, func(*TeamTx) error { called.Store(true); return nil }) }()
	waitForQueryLock(t, s, "SELECT id::text FROM teams WHERE")
	stop()
	bounded, finish := context.WithTimeout(context.Background(), 5*time.Second)
	defer finish()
	if err := receiveQueryResult(t, bounded, done); !errors.Is(err, context.Canceled) || called.Load() {
		t.Fatalf("late callback %v %v", called.Load(), err)
	}
}

func TestTeamCommitResponseLossRetainsCommittedResult(t *testing.T) {
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
		_, err := (&TeamTx{tx: tx, teamID: team.ID}).Rename(ctx, actor.UserID, "Committed")
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
