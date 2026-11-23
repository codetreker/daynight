package postgres

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

type cleanupGoalState struct {
	version int64
	updated time.Time
}

func readCleanupGoal(t *testing.T, db *Store, goal string) cleanupGoalState {
	t.Helper()
	var s cleanupGoalState
	if err := db.Pool.QueryRow(t.Context(), `SELECT version,updated_at FROM tasks WHERE id=$1`, goal).Scan(&s.version, &s.updated); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestProjectCleanupUpdatesOnlySurvivingGoalWatermarks(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				ctx := t.Context()
				other, err := testutil.CreatePrivateProject(ctx, f.db, f.principal, uuid.NewString(), "Deleted downstream", "https://example.test/deleted-downstream")
				if err != nil {
					t.Fatal(err)
				}
				source, local, removed, deletedProjectGoal, untouched := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
				mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status,version,deleted_at,updated_at) VALUES
    ($1,$6,'goal','source','todo',1,NULL,'2000-01-01'),($2,$6,'goal','local','todo',1,NULL,'2000-01-01'),
    ($3,$7,'goal','removed','todo',$9,statement_timestamp(),'2000-01-01'),($4,$8,'goal','deleted project','todo',$9,NULL,'2000-01-01'),
    ($5,$7,'goal','untouched','todo',1,NULL,'2000-01-01')`, source, local, removed, deletedProjectGoal, untouched, f.upProject.ID, f.downProject.ID, other.ID, int64(math.MaxInt64))
				mustQueryExec(t, f.db, `UPDATE tasks SET updated_at='2000-01-01' WHERE id=$1`, f.down)
				mustQueryExec(t, f.db, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, other.ID)
				mustQueryExec(t, f.db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES
    ($1,$2,$3,'goal',$9),($4,$5,$6,'goal',$10),($1,$7,$6,'goal',$11),($8,$12,$6,'goal',$13)`, f.downProject.ID, f.down, source, f.upProject.ID, local, f.up, removed, other.ID, uuid.NewString(), uuid.NewString(), uuid.NewString(), deletedProjectGoal, uuid.NewString())
				beforeRemote, beforeLocal, beforeRemoved, beforeDeleted, beforeUntouched := readCleanupGoal(t, f.db, f.down), readCleanupGoal(t, f.db, local), readCleanupGoal(t, f.db, removed), readCleanupGoal(t, f.db, deletedProjectGoal), readCleanupGoal(t, f.db, untouched)
				var sourceEpoch, remoteEpoch string
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT task_cache_epoch::text FROM projects WHERE id=$1),(SELECT task_cache_epoch::text FROM projects WHERE id=$2)`, f.upProject.ID, f.downProject.ID).Scan(&sourceEpoch, &remoteEpoch); err != nil {
					t.Fatal(err)
				}
				target, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				var svc goalProjectLifecycle = projectservice.NewProjects(f.db)
				if app {
					svc = projectservice.NewAppProjects(f.db)
				}
				if deleting {
					_, err = svc.DeleteWithInput(ctx, f.principal, f.upProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
				} else {
					preview, e := svc.TransferPreview(ctx, f.principal, f.upProject.ID, target.ID)
					if e != nil {
						t.Fatal(e)
					}
					_, err = svc.Transfer(ctx, f.principal, f.upProject.ID, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true})
				}
				if err != nil {
					t.Fatal(err)
				}
				remote, localAfter := readCleanupGoal(t, f.db, f.down), readCleanupGoal(t, f.db, local)
				if remote.version != beforeRemote.version+1 || !remote.updated.After(beforeRemote.updated) {
					t.Fatalf("remote watermark: before=%+v after=%+v", beforeRemote, remote)
				}
				if deleting {
					if localAfter != beforeLocal {
						t.Fatalf("deleted source Goal touched: %+v", localAfter)
					}
				} else if localAfter.version != beforeLocal.version+1 || !localAfter.updated.After(beforeLocal.updated) {
					t.Fatalf("transferred source Goal not touched: %+v", localAfter)
				}
				if readCleanupGoal(t, f.db, removed) != beforeRemoved || readCleanupGoal(t, f.db, deletedProjectGoal) != beforeDeleted || readCleanupGoal(t, f.db, untouched) != beforeUntouched {
					t.Fatal("invisible or unrelated Goal changed")
				}
				for _, id := range []string{f.down, local, removed, deletedProjectGoal} {
					assertGoalRelationState(t, f.db, id, 0, 2)
				}
				var newSourceEpoch, newRemoteEpoch string
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT task_cache_epoch::text FROM projects WHERE id=$1),(SELECT task_cache_epoch::text FROM projects WHERE id=$2)`, f.upProject.ID, f.downProject.ID).Scan(&newSourceEpoch, &newRemoteEpoch); err != nil {
					t.Fatal(err)
				}
				if (newSourceEpoch != sourceEpoch) != deleting || newRemoteEpoch != remoteEpoch {
					t.Fatalf("wrong cache epoch source=%s/%s remote=%s/%s", sourceEpoch, newSourceEpoch, remoteEpoch, newRemoteEpoch)
				}
			})
		}
	}
}

func TestProjectCleanupTaskWatermarkFailureRollsBack(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			for _, failure := range []string{"version exhaustion", "touch failure"} {
				t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete/", false: " transfer/"}[deleting]+failure, func(t *testing.T) {
					f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
					ctx := t.Context()
					if failure == "version exhaustion" {
						mustQueryExec(t, f.db, `UPDATE tasks SET version=$1 WHERE id=$2`, int64(math.MaxInt64), f.down)
					} else {
						mustQueryExec(t, f.db, `CREATE FUNCTION refuse_cleanup_goal_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup touch refused'; END $$;
      CREATE TRIGGER refuse_cleanup_goal_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_cleanup_goal_touch()`)
						defer mustQueryExec(t, f.db, `DROP TRIGGER refuse_cleanup_goal_touch ON tasks; DROP FUNCTION refuse_cleanup_goal_touch()`)
					}
					before := readCleanupGoal(t, f.db, f.down)
					var epoch string
					if err := f.db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, f.upProject.ID).Scan(&epoch); err != nil {
						t.Fatal(err)
					}
					target, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Destination")
					if err != nil {
						t.Fatal(err)
					}
					var svc goalProjectLifecycle = projectservice.NewProjects(f.db)
					if app {
						svc = projectservice.NewAppProjects(f.db)
					}
					if deleting {
						_, err = svc.DeleteWithInput(ctx, f.principal, f.upProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
					} else {
						preview, e := svc.TransferPreview(ctx, f.principal, f.upProject.ID, target.ID)
						if e != nil {
							t.Fatal(e)
						}
						_, err = svc.Transfer(ctx, f.principal, f.upProject.ID, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true})
					}
					if err == nil {
						t.Fatal("failed touch returned success")
					}
					if failure == "version exhaustion" {
						assertGoalFault(t, err, "version_exhausted")
					}
					assertGoalRelationState(t, f.db, f.down, 1, 1)
					if readCleanupGoal(t, f.db, f.down) != before {
						t.Fatal("failed cleanup changed Goal")
					}
					var actualEpoch, owner string
					var deleted bool
					if e := f.db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text,deleted_at IS NOT NULL,(SELECT team_id::text FROM project_ownership WHERE project_id=$1) FROM projects WHERE id=$1`, f.upProject.ID).Scan(&actualEpoch, &deleted, &owner); e != nil || deleted || actualEpoch != epoch || owner != f.upProject.Ownership.TeamID {
						t.Fatalf("project effects persisted: epoch=%s deleted=%v owner=%s error=%v", actualEpoch, deleted, owner, e)
					}
				})
			}
		}
	}
}

func TestProjectCleanupCannotBeOvertakenByRemoteTaskWatermark(t *testing.T) {
	f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	item := queryTask(t, f.db, f.downProject.ID, 999, model.TaskTodo)
	mustQueryExec(t, f.db, `UPDATE tasks SET updated_at='2000-01-01' WHERE id=ANY($1::uuid[])`, []string{f.down, item.ID})
	ready, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	cleanup, ordinary := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := f.db.WriteProjectTransfer(ctx, f.upProject.ID, func(scope store.ProjectWriteScope) error {
			if err := scope.ProjectGoalDependencyDAO().RemoveProjectEdges(ctx, false); err != nil {
				return err
			}
			close(ready)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		cleanup <- err
	}()
	awaitGoalBarrier(t, ctx, ready, cleanup)
	go func() {
		_, err := f.db.WriteProject(ctx, f.downProject.ID, func(scope store.ProjectWriteScope) error {
			_, err := scope.TaskDAO().UpdateTask(ctx, item.ID, store.TaskWrite{Title: "ordinary update", Status: model.TaskTodo})
			return err
		})
		ordinary <- err
	}()
	waitForQueryLock(t, f.db, "SELECT id::text FROM projects WHERE")
	var oldRows []model.TaskViewRecord
	if err := f.db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		oldRows, err = snapshot.TaskDAO().TaskSyncTasks(ctx, f.downProject.ID, nil, 160)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var watermark time.Time
	for _, row := range oldRows {
		if row.UpdatedAt.After(watermark) {
			watermark = row.UpdatedAt
		}
		if (row.ID == f.down || row.ID == item.ID) && row.Version != 1 {
			t.Fatalf("uncommitted write visible: %+v", row)
		}
	}
	select {
	case err := <-ordinary:
		t.Fatalf("ordinary writer overtook cleanup: %v", err)
	default:
	}
	close(release)
	if err := testutil.ReceiveQueryResult(t, ctx, cleanup); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, ordinary); err != nil {
		t.Fatal(err)
	}
	var rows []model.TaskViewRecord
	if err := f.db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		rows, err = snapshot.TaskDAO().TaskSyncTasks(ctx, f.downProject.ID, &watermark, 160)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	versions := map[string]model.TaskViewRecord{}
	for _, row := range rows {
		versions[row.ID] = row
	}
	goal, okGoal := versions[f.down]
	task, okTask := versions[item.ID]
	if !okGoal || !okTask || goal.Version != 2 || task.Version != 2 || !goal.UpdatedAt.After(watermark) || task.UpdatedAt.Before(goal.UpdatedAt) {
		t.Fatalf("delta missed ordered writes: watermark=%v rows=%+v", watermark, rows)
	}
	testutil.AssertPoolReusable(t, f.db.Pool)
}
