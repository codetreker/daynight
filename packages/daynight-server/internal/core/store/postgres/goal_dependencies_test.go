package postgres

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestGoalDependencyDAOReadsAndRemoval(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	a, b := queryProject(t, db, 1), queryProject(t, db, 2)
	team := testutil.OrdinaryProjectTeam(t, db.Pool, a.ID)
	mustQueryExec(t, db, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, b.ID, team)
	source, prerequisite, successor, unrelated := queryID(11), queryID(12), queryID(13), queryID(14)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$5,'goal','source','todo'),($2,$6,'goal','prerequisite','todo'),($3,$6,'goal','successor','done'),($4,$5,'task','unrelated','done')`, source, prerequisite, successor, unrelated, a.ID, b.ID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$3,$4,'goal',$6),($2,$5,$3,'goal',$7),($1,$3,$5,'task',NULL)`, a.ID, b.ID, source, prerequisite, successor, queryID(21), queryID(22))
	if err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		graph := scope.GoalDependencyDAO()
		if err := graph.LockTeam(ctx); err != nil {
			return err
		}
		unmet, err := graph.UnsatisfiedPrerequisites(ctx, source)
		if err != nil {
			return err
		}
		if !unmet {
			t.Error("pending cross-project predecessor was accepted")
		}
		done, err := graph.DoneSuccessors(ctx, source)
		if err != nil {
			return err
		}
		if !done {
			t.Error("completed cross-project successor missed")
		}
		incoming, err := graph.HasIncoming(ctx, source)
		if err != nil {
			return err
		}
		if !incoming {
			t.Error("cross-project incoming edge missed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, successor)
	if err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		d := scope.GoalDependencyDAO()
		if err := d.LockTeam(ctx); err != nil {
			return err
		}
		incoming, err := d.HasIncoming(ctx, source)
		if err != nil {
			return err
		}
		if incoming {
			t.Error("deleted successor still counted as an effective incoming edge")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=NULL WHERE id=$1`, successor)
	mustQueryExec(t, db, `UPDATE tasks SET status='done' WHERE id=$1`, prerequisite)
	if err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		d := scope.GoalDependencyDAO()
		if err := d.LockTeam(ctx); err != nil {
			return err
		}
		unmet, err := d.UnsatisfiedPrerequisites(ctx, source)
		if err != nil {
			return err
		}
		if unmet {
			t.Error("completed predecessor rejected")
		}
		return d.RemoveOutgoing(ctx, source)
	}); err != nil {
		t.Fatal(err)
	}
	var revision int64
	var ordinary, outgoing, incoming int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1), (SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='task'), (SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='goal'), (SELECT count(*) FROM task_dependencies WHERE depends_on_task_id=$1 AND dependency_type='goal')`, source).Scan(&revision, &ordinary, &outgoing, &incoming); err != nil || revision != 2 || ordinary != 1 || outgoing != 0 || incoming != 1 {
		t.Fatalf("removal revision=%d task=%d outgoing=%d incoming=%d err=%v", revision, ordinary, outgoing, incoming, err)
	}
	if err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		d := scope.GoalDependencyDAO()
		if err := d.LockTeam(ctx); err != nil {
			return err
		}
		return d.RemoveOutgoing(ctx, source)
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1`, source).Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("empty removal changed revision %d: %v", revision, err)
	}
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, a.ID, source, prerequisite, queryID(23))
	if err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		d := scope.GoalDependencyDAO()
		if err := d.LockTeam(ctx); err != nil {
			return err
		}
		return d.RemoveOutgoing(ctx, source)
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1`, source).Scan(&revision); err != nil || revision != 3 {
		t.Fatalf("existing revision did not advance: %d %v", revision, err)
	}
	mustQueryExec(t, db, `UPDATE goal_dependency_revisions SET revision=$2 WHERE goal_id=$1`, source, int64(math.MaxInt64))
	if err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		d := scope.GoalDependencyDAO()
		if err := d.LockTeam(ctx); err != nil {
			return err
		}
		return d.RemoveOutgoing(ctx, source)
	}); err != nil {
		t.Fatalf("empty removal at exhausted revision: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1`, source).Scan(&revision); err != nil || revision != math.MaxInt64 {
		t.Fatalf("empty removal changed exhausted revision %d: %v", revision, err)
	}
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, a.ID, source, prerequisite, queryID(23))
	err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		d := scope.GoalDependencyDAO()
		if err := d.LockTeam(ctx); err != nil {
			return err
		}
		return d.RemoveOutgoing(ctx, source)
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_exhausted" {
		t.Fatalf("revision exhaustion: %v", err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1), (SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='goal')`, source).Scan(&revision, &outgoing); err != nil || revision != math.MaxInt64 || outgoing != 1 {
		t.Fatalf("exhaustion failed rollback: revision=%d edges=%d err=%v", revision, outgoing, err)
	}
	if err := writeProjectForTest(db, ctx, a.ID, func(scope store.ProjectWriteScope) error {
		d := scope.GoalDependencyDAO()
		if err := d.LockTeam(ctx); err != nil {
			return err
		}
		if err := d.RemoveOutgoing(ctx, source); !errors.As(err, &fault) || fault.Code != "version_exhausted" {
			return errors.New("expected revision exhaustion")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1), (SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='goal')`, source).Scan(&revision, &outgoing); err != nil || revision != math.MaxInt64 || outgoing != 1 {
		t.Fatalf("ignored exhaustion changed data: revision=%d edges=%d err=%v", revision, outgoing, err)
	}
}

func TestGoalDependencyTeamLockCancellationAndIndependence(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx, stop := context.WithTimeout(t.Context(), 10*time.Second)
	defer stop()
	a, b, c := queryProject(t, db, 31), queryProject(t, db, 32), queryProject(t, db, 33)
	team := testutil.OrdinaryProjectTeam(t, db.Pool, a.ID)
	mustQueryExec(t, db, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, b.ID, team)
	results := make(chan error, 1)
	done := make(chan struct{})
	started := false
	defer func() {
		stop()
		if started {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("waiting transaction did not drain")
			}
		}
	}()
	err := writeProjectForTest(db, ctx, a.ID, func(holder store.ProjectWriteScope) error {
		if err := holder.GoalDependencyDAO().LockTeam(ctx); err != nil {
			return err
		}
		waiting, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
		defer cancel()
		started = true
		go func() {
			results <- writeProjectForTest(db, waiting, b.ID, func(scope store.ProjectWriteScope) error { return scope.GoalDependencyDAO().LockTeam(waiting) })
			close(done)
		}()
		admissionCompletionWait(t, db, ctx, holder.(*ProjectTx).tx, done)
		independent, finish := context.WithTimeout(ctx, 2*time.Second)
		defer finish()
		if err := writeProjectForTest(db, independent, c.ID, func(scope store.ProjectWriteScope) error { return scope.GoalDependencyDAO().LockTeam(independent) }); err != nil {
			return err
		}
		select {
		case result := <-results:
			if !errors.Is(result, context.DeadlineExceeded) {
				t.Errorf("same Team wait: %v", result)
			}
		case <-ctx.Done():
			return ctx.Err()
		}
		if err := writeProjectForTest(db, ctx, b.ID, func(scope store.ProjectWriteScope) error {
			_, err := scope.TaskDAO().CreateTask(ctx, queryID(34), store.TaskWrite{Title: "Ordinary task after timeout", Status: model.TaskTodo})
			return err
		}); err != nil {
			t.Errorf("Project lock retained after timeout: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	testutil.AssertPoolReusable(t, db.Pool)
}

func TestGoalDependencyRemovalDatabaseFailuresRollBack(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	for _, scenario := range []struct {
		name, triggerSQL, triggerTable, code, phase string
		revision                                    *int64
	}{
		{
			name: "edge deletion",
			triggerSQL: `CREATE FUNCTION refuse_goal_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1011', MESSAGE='edge removal failure'; END $$;
				CREATE TRIGGER refuse_goal_removal BEFORE DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION refuse_goal_removal()`,
			triggerTable: "task_dependencies", code: "P1011", phase: "remove outgoing goal dependencies",
		},
		{
			name: "first revision",
			triggerSQL: `CREATE FUNCTION refuse_goal_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=NEW.goal_id AND dependency_type='goal') THEN RAISE EXCEPTION USING ERRCODE='P1099', MESSAGE='edge not removed before revision'; END IF;
				RAISE EXCEPTION USING ERRCODE='P1012', MESSAGE='revision insert failure'; END $$;
				CREATE TRIGGER refuse_goal_removal BEFORE INSERT ON goal_dependency_revisions FOR EACH ROW EXECUTE FUNCTION refuse_goal_removal()`,
			triggerTable: "goal_dependency_revisions", code: "P1012", phase: "create goal dependency revision",
		},
		{
			name: "existing revision",
			triggerSQL: `CREATE FUNCTION refuse_goal_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF EXISTS(SELECT 1 FROM task_dependencies WHERE task_id=NEW.goal_id AND dependency_type='goal') THEN RAISE EXCEPTION USING ERRCODE='P1099', MESSAGE='edge not removed before revision'; END IF;
				RAISE EXCEPTION USING ERRCODE='P1013', MESSAGE='revision update failure'; END $$;
				CREATE TRIGGER refuse_goal_removal BEFORE UPDATE ON goal_dependency_revisions FOR EACH ROW EXECUTE FUNCTION refuse_goal_removal()`,
			triggerTable: "goal_dependency_revisions", code: "P1013", phase: "advance goal dependency revision", revision: new(int64(7)),
		},
	} {
		if !t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			source, target := uuid.NewString(), uuid.NewString()
			mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$3,'goal','source','todo'),($2,$3,'goal','target','done')`, source, target, project.ID)
			mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, project.ID, source, target, uuid.NewString())
			if scenario.revision != nil {
				mustQueryExec(t, db, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,$2)`, source, *scenario.revision)
			}
			mustQueryExec(t, db, scenario.triggerSQL)
			triggerPresent := true
			t.Cleanup(func() {
				if triggerPresent {
					mustQueryExec(t, db, "DROP TRIGGER refuse_goal_removal ON "+scenario.triggerTable+"; DROP FUNCTION refuse_goal_removal()")
				}
			})
			completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
				dao := scope.GoalDependencyDAO()
				if err := dao.LockTeam(ctx); err != nil {
					return err
				}
				if _, err := scope.(*ProjectTx).tx.Exec(ctx, `UPDATE tasks SET title='uncommitted' WHERE id=$1`, source); err != nil {
					return err
				}
				return dao.RemoveOutgoing(ctx, source)
			})
			var driver *pgconn.PgError
			var storage *store.Error
			var transaction *store.TransactionError
			failed, state := store.DatabaseErrorFacts(err)
			if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &driver) || driver.Code != scenario.code || !errors.As(err, &transaction) || !errors.As(transaction.Cause, &storage) || storage.Phase != scenario.phase || !failed || state != scenario.code {
				t.Fatalf("failure lost database cause or rollback outcome: completion=%+v err=%v", completion, err)
			}
			var title string
			var edges int
			var revision *int64
			if err := db.Pool.QueryRow(ctx, `SELECT title,(SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='goal'),(SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1) FROM tasks WHERE id=$1`, source).Scan(&title, &edges, &revision); err != nil {
				t.Fatal(err)
			}
			if title != "source" || edges != 1 || (revision == nil) != (scenario.revision == nil) || (revision != nil && *revision != *scenario.revision) {
				t.Fatalf("failure changed persistent state: title=%q edges=%d revision=%v", title, edges, revision)
			}
			if strings.Contains(err.Error(), driver.Message) {
				t.Fatal("database diagnostic was exposed by the error")
			}
			mustQueryExec(t, db, "DROP TRIGGER refuse_goal_removal ON "+scenario.triggerTable+"; DROP FUNCTION refuse_goal_removal()")
			triggerPresent = false
			assertFaultTriggerRemoved(t, db, "refuse_goal_removal", scenario.triggerTable)
			if err := writeProjectForTest(db, ctx, project.ID, func(scope store.ProjectWriteScope) error {
				dao := scope.GoalDependencyDAO()
				if err := dao.LockTeam(ctx); err != nil {
					return err
				}
				return dao.RemoveOutgoing(ctx, source)
			}); err != nil {
				t.Fatalf("removal after fault cleanup: %v", err)
			}
		}) {
			return
		}
	}
}
