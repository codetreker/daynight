package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

// The gated view suspends a real ACL scan after its SQL statement has obtained
// a snapshot. Committing revocation and ownership changes during that wait
// distinguishes one-statement admission from independently timed fact reads.
func TestGoalRelationsAdmissionUsesOneAuthorizationAndOwnershipSnapshot(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	_, caller, _ := testutil.AuthRecords(t, f.db)
	sourceTeam, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Admission source")
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, f.db, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, sourceTeam.ID, f.downProject.ID)
	mustQueryExec(t, f.db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, sourceTeam.ID, caller.UserID)
	mustQueryExec(t, f.db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.upProject.ID, caller.UserID)
	const gate int64 = 918273645
	gateConnection, err := f.db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gateConnection.Release()
	if _, err := gateConnection.Exec(ctx, `SELECT pg_advisory_lock($1)`, gate); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if _, err := gateConnection.Exec(cleanup, `SELECT pg_advisory_unlock($1)`, gate); err != nil {
			t.Errorf("release admission gate: %v", err)
		}
	}()
	mustQueryExec(t, f.db, `ALTER TABLE team_members RENAME TO goal_admission_members;
 CREATE FUNCTION goal_admission_gate() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
 BEGIN PERFORM pg_advisory_xact_lock(918273645::bigint); RETURN true; END $$;
 CREATE VIEW team_members AS SELECT * FROM goal_admission_members WHERE goal_admission_gate()`)
	t.Cleanup(func() {
		mustQueryExec(t, f.db, `DROP VIEW team_members; DROP FUNCTION goal_admission_gate(); ALTER TABLE goal_admission_members RENAME TO team_members`)
	})
	type admissionResult struct {
		facts store.GoalRelationAdmission
		err   error
	}
	result := make(chan admissionResult, 1)
	go func() {
		var facts store.GoalRelationAdmission
		_, err := f.db.WriteProject(ctx, f.downProject.ID, func(scope store.ProjectWriteScope) error {
			dao := scope.GoalRelationDAO()
			if err := dao.LockTeam(ctx); err != nil {
				return err
			}
			var err error
			facts, err = dao.Admission(ctx, f.down, caller.UserID, []store.GoalEndpoint{{ProjectID: f.upProject.ID, GoalID: f.up}})
			if err != nil {
				return err
			}
			_, _, err = taskcore.PrepareGoalRelations(ctx, dao, f.down, goalRelationAdd(f.upProject.ID, f.up, 1), facts)
			return err
		})
		result <- admissionResult{facts: facts, err: err}
	}()
	for {
		var blocked bool
		if err := f.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
 WHERE a.application_name=current_schema() AND l.locktype='advisory' AND l.classid=0 AND l.objid=$1::oid AND NOT l.granted)`, gate).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case early := <-result:
			t.Fatalf("admission did not evaluate gated Team authorization: %+v %v", early.facts, early.err)
		default:
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatal(err)
		}
	}
	change, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := change.Exec(ctx, `DELETE FROM goal_admission_members WHERE team_id=$1 AND user_id=$2`, sourceTeam.ID, caller.UserID); err != nil {
		_ = change.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := change.Exec(ctx, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, sourceTeam.ID, f.upProject.ID); err != nil {
		_ = change.Rollback(ctx)
		t.Fatal(err)
	}
	if err := change.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := gateConnection.Exec(ctx, `SELECT pg_advisory_unlock($1)`, gate); err != nil {
		t.Fatal(err)
	}
	var observed admissionResult
	select {
	case observed = <-result:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	assertGoalFault(t, observed.err, "goal_dependency_team_mismatch")
	if !observed.facts.Source.CanEdit || len(observed.facts.Targets) != 1 || !observed.facts.Targets[0].Available || observed.facts.Source.TeamID == observed.facts.Targets[0].TeamID {
		t.Fatalf("pre-change SQL snapshot mixed new ownership with old permission: %+v %v", observed.facts, observed.err)
	}
	_, err = f.db.WriteProject(ctx, f.downProject.ID, func(scope store.ProjectWriteScope) error {
		dao := scope.GoalRelationDAO()
		if err := dao.LockTeam(ctx); err != nil {
			return err
		}
		facts, err := dao.Admission(ctx, f.down, caller.UserID, []store.GoalEndpoint{{ProjectID: f.upProject.ID, GoalID: f.up}})
		if err == nil && (facts.Source.CanRead || facts.Source.CanEdit || len(facts.Targets) != 1 || facts.Targets[0].TeamID != facts.Source.TeamID) {
			t.Errorf("post-change admission did not observe revocation and move together: %+v", facts)
		}
		if err != nil {
			return err
		}
		_, _, err = taskcore.PrepareGoalRelations(ctx, dao, f.down, goalRelationAdd(f.upProject.ID, f.up, 1), facts)
		return err
	})
	assertGoalFault(t, err, "not_found")
	assertGoalRelationState(t, f.db, f.down, 0, 1)
}

type goalRelationReadBarrier struct {
	*Store
	selected chan struct{}
	release  chan struct{}
}

type goalRelationReadScope struct {
	store.SnapshotScope
	barrier *goalRelationReadBarrier
}

type goalRelationSourceBarrier struct {
	store.GoalRelationReader
	barrier *goalRelationReadBarrier
}

func (b *goalRelationReadBarrier) ReadSnapshot(ctx context.Context, read func(store.SnapshotScope) error) error {
	return b.Store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		return read(goalRelationReadScope{SnapshotScope: scope, barrier: b})
	})
}

func (s goalRelationReadScope) GoalRelationDAO() store.GoalRelationReader {
	return goalRelationSourceBarrier{GoalRelationReader: s.SnapshotScope.GoalRelationDAO(), barrier: s.barrier}
}

func (d goalRelationSourceBarrier) Source(ctx context.Context, projectID, goalID, userID string) (store.GoalRelationSource, error) {
	facts, err := d.GoalRelationReader.Source(ctx, projectID, goalID, userID)
	if err != nil {
		return facts, err
	}
	close(d.barrier.selected)
	select {
	case <-d.barrier.release:
		return facts, nil
	case <-ctx.Done():
		return store.GoalRelationSource{}, ctx.Err()
	}
}

func TestGoalRelationsReadProjectionAndRevisionShareSnapshot(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	barrier := &goalRelationReadBarrier{Store: f.db, selected: make(chan struct{}), release: make(chan struct{})}
	defer func() {
		select {
		case <-barrier.release:
		default:
			close(barrier.release)
		}
	}()
	type readResult struct {
		view taskcore.GoalDependencies
		err  error
	}
	result := make(chan readResult, 1)
	go func() {
		view, err := taskservice.NewTasks(barrier).ShowGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, model.PageRequest{Limit: 20})
		result <- readResult{view: view, err: err}
	}()
	select {
	case <-barrier.selected:
	case early := <-result:
		t.Fatalf("read did not reach source snapshot: %v", early.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := taskservice.NewTasks(f.db).EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1)); err != nil {
		t.Fatal(err)
	}
	close(barrier.release)
	select {
	case observed := <-result:
		if observed.err != nil || observed.view.Revision == nil || *observed.view.Revision != 1 || len(observed.view.Prerequisites) != 0 || observed.view.CompletionBlocked {
			t.Fatalf("read mixed old revision with new graph: %+v %v", observed.view, observed.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	after := readGoalRelations(t, f.db, f.principal, f.downProject.ID, f.down, model.PageRequest{})
	if after.Revision == nil || *after.Revision != 2 || len(after.Prerequisites) != 1 || !after.CompletionBlocked {
		t.Fatalf("next snapshot did not read committed relation: %+v", after)
	}
}
