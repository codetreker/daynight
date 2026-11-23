package postgres

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func emptyGoalRelationFixture(t *testing.T) goalLifecycleFixture {
	t.Helper()
	f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
	mustQueryExec(t, f.db, `DELETE FROM task_dependencies WHERE dependency_type='goal'`)
	return f
}

func goalRelationAdd(projectID, goalID string, revision int64) taskcore.GoalDependencyEdit {
	return taskcore.GoalDependencyEdit{IfRevision: revision, Mode: "edit", Add: []store.GoalEndpoint{{ProjectID: projectID, GoalID: goalID}}}
}

func readGoalRelations(t *testing.T, db *Store, principal model.Principal, projectID, goalID string, page model.PageRequest) taskcore.GoalDependencies {
	t.Helper()
	if page.Limit == 0 {
		page.Limit = 20
	}
	result, err := taskservice.NewTasks(db).ShowGoalDependencies(t.Context(), principal, projectID, goalID, page)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertGoalRelationState(t *testing.T, db *Store, goalID string, edges int, revision int64) {
	t.Helper()
	var gotEdges int
	var gotRevision int64
	err := db.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='goal'),
 COALESCE((SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1),1)`, goalID).Scan(&gotEdges, &gotRevision)
	if err != nil || gotEdges != edges || gotRevision != revision {
		t.Fatalf("persisted relations edges=%d want %d revision=%d want %d: %v", gotEdges, edges, gotRevision, revision, err)
	}
}

func releaseGoalBarrier(barrier *goalCommitBarrier) {
	select {
	case <-barrier.release:
	default:
		close(barrier.release)
	}
}

func TestGoalRelationsDisjointEditsCannotCloseCycle(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	barrier := &goalCommitBarrier{Store: f.db, prepared: make(chan struct{}), release: make(chan struct{})}
	defer releaseGoalBarrier(barrier)
	first, second := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := taskservice.NewTasks(barrier).EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1))
		first <- err
	}()
	awaitGoalBarrier(t, ctx, barrier.prepared, first)
	go func() {
		_, err := taskservice.NewTasks(f.db).EditGoalDependencies(ctx, f.principal, f.upProject.ID, f.up, goalRelationAdd(f.downProject.ID, f.down, 1))
		second <- err
	}()
	waitGoalAdvisoryWait(t, ctx, f.db)
	releaseGoalBarrier(barrier)
	if err := testutil.ReceiveQueryResult(t, ctx, first); err != nil {
		t.Fatal(err)
	}
	assertGoalFault(t, testutil.ReceiveQueryResult(t, ctx, second), "goal_dependency_cycle")
	assertGoalRelationState(t, f.db, f.down, 1, 2)
	assertGoalRelationState(t, f.db, f.up, 0, 1)
	for projectID, id := range map[string]string{f.downProject.ID: f.down, f.upProject.ID: f.up} {
		want := int64(1)
		if id == f.down {
			want = 2
		}
		if got := snapshotTask(t, f.db, projectID, id); got.Version != want || got.Status != model.TaskTodo {
			t.Fatalf("unexpected Goal metadata: %+v", got)
		}
	}
	testutil.AssertPoolReusable(t, f.db.Pool)
}

// Holding the write after graph mutation lets the competing operation reach the
// real Team lock before either transaction commits.
func TestGoalRelationsCompletionAndNewPrerequisiteSerialize(t *testing.T) {
	for _, editFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "edit-first", false: "completion-first"}[editFirst], func(t *testing.T) {
			f := emptyGoalRelationFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			barrier := &goalCommitBarrier{Store: f.db, prepared: make(chan struct{}), release: make(chan struct{})}
			defer releaseGoalBarrier(barrier)
			edit := func(database interface {
				store.SnapshotReader
				store.ProjectWriter
			}) error {
				_, err := taskservice.NewTasks(database).EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1))
				return err
			}
			complete := func(database interface {
				store.SnapshotReader
				store.ProjectWriter
			}) error {
				_, err := taskservice.NewTasks(database).SetStatus(ctx, f.principal, f.downProject.ID, f.down, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
				return err
			}
			first, second := make(chan error, 1), make(chan error, 1)
			go func() {
				if editFirst {
					first <- edit(barrier)
				} else {
					first <- complete(barrier)
				}
			}()
			awaitGoalBarrier(t, ctx, barrier.prepared, first)
			go func() {
				if editFirst {
					second <- complete(f.db)
				} else {
					second <- edit(f.db)
				}
			}()
			// These operations share the downstream Project. Observe its row-lock
			// waiter rather than waiting for the later Team advisory lock.
			waitGoalRelationProjectWait(t, ctx, f.db)
			releaseGoalBarrier(barrier)
			if err := testutil.ReceiveQueryResult(t, ctx, first); err != nil {
				t.Fatal(err)
			}
			secondErr := testutil.ReceiveQueryResult(t, ctx, second)
			if editFirst {
				assertGoalFault(t, secondErr, "version_conflict")
				_, err := taskservice.NewTasks(f.db).SetStatus(ctx, f.principal, f.downProject.ID, f.down, taskcore.SetTaskStatus{Version: 2, Status: model.TaskDone})
				assertGoalFault(t, err, "goal_dependency_unsatisfied")
			} else {
				assertGoalFault(t, secondErr, "goal_dependency_unsatisfied")
			}
			got := snapshotTask(t, f.db, f.downProject.ID, f.down)
			if editFirst {
				assertGoalRelationState(t, f.db, f.down, 1, 2)
				if got.Status != model.TaskTodo || got.Version != 2 {
					t.Fatalf("edit-first metadata: %+v", got)
				}
			} else {
				assertGoalRelationState(t, f.db, f.down, 0, 1)
				if got.Status != model.TaskDone || got.Version != 2 {
					t.Fatalf("completion-first metadata: %+v", got)
				}
			}
		})
	}
}

func waitGoalRelationProjectWait(t *testing.T, ctx context.Context, db *Store) {
	t.Helper()
	for {
		var waiting bool
		err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=current_schema()
 AND wait_event_type='Lock' AND query LIKE 'SELECT id::text FROM projects%FOR UPDATE%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("operation did not reach Project lock: %v", err)
		}
	}
}

func TestGoalRelationsRevisionSurvivesEmptySetAndProjectRoundTrip(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	tasks := taskservice.NewTasks(f.db)
	ctx := t.Context()
	mustQueryExec(t, f.db, `UPDATE tasks SET updated_at='2000-01-01' WHERE id=$1`, f.down)
	before := snapshotTask(t, f.db, f.downProject.ID, f.down)
	initial := readGoalRelations(t, f.db, f.principal, f.downProject.ID, f.down, model.PageRequest{})
	if initial.Revision == nil || *initial.Revision != 1 || len(initial.Prerequisites) != 0 {
		t.Fatalf("initial: %+v", initial)
	}
	add := goalRelationAdd(f.upProject.ID, f.up, 1)
	receipt, err := tasks.EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, add)
	if err != nil || !receipt.Changed || receipt.Revision != 2 {
		t.Fatalf("add: %+v %v", receipt, err)
	}
	afterAdd := snapshotTask(t, f.db, f.downProject.ID, f.down)
	if afterAdd.Version != before.Version+1 || !afterAdd.UpdatedAt.After(before.UpdatedAt) {
		t.Fatalf("add did not advance task: before=%+v after=%+v", before, afterAdd)
	}
	added := readGoalRelations(t, f.db, f.principal, f.downProject.ID, f.down, model.PageRequest{})
	edgeID := *added.Prerequisites[0].EdgeID
	add.IfRevision = 2
	receipt, err = tasks.EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, add)
	if err != nil || receipt.Changed || receipt.Revision != 2 {
		t.Fatalf("same-set add: %+v %v", receipt, err)
	}
	if got := snapshotTask(t, f.db, f.downProject.ID, f.down); !reflect.DeepEqual(got, afterAdd) {
		t.Fatalf("noop changed task: %+v", got)
	}
	retained := readGoalRelations(t, f.db, f.principal, f.downProject.ID, f.down, model.PageRequest{})
	if *retained.Prerequisites[0].EdgeID != edgeID {
		t.Fatal("same-set add changed edge identity")
	}
	clear := taskcore.GoalDependencyEdit{IfRevision: 2, Mode: "replace", Prerequisites: []taskcore.GoalDependencyReference{}}
	receipt, err = tasks.EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, clear)
	if err != nil || !receipt.Changed || receipt.Revision != 3 {
		t.Fatalf("clear: %+v %v", receipt, err)
	}
	assertGoalRelationState(t, f.db, f.down, 0, 3)
	afterClear := snapshotTask(t, f.db, f.downProject.ID, f.down)
	if afterClear.Version != afterAdd.Version+1 || afterClear.UpdatedAt.Before(afterAdd.UpdatedAt) {
		t.Fatalf("clear did not advance task: %+v", afterClear)
	}
	_, err = tasks.EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1))
	assertGoalFault(t, err, "goal_dependency_revision_conflict")
	if got := snapshotTask(t, f.db, f.downProject.ID, f.down); !reflect.DeepEqual(got, afterClear) {
		t.Fatalf("stale edit changed task: %+v", got)
	}
	add.IfRevision = 3
	if _, err = tasks.EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, add); err != nil {
		t.Fatal(err)
	}
	rebuilt := readGoalRelations(t, f.db, f.principal, f.downProject.ID, f.down, model.PageRequest{})
	if *rebuilt.Prerequisites[0].EdgeID == edgeID {
		t.Fatal("recreated edge reused its removed UUID")
	}
	team, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Round trip")
	if err != nil {
		t.Fatal(err)
	}
	projects := projectservice.NewProjects(f.db)
	for _, teamID := range []string{team.ID, f.upProject.Ownership.TeamID} {
		preview, err := projects.TransferPreview(ctx, f.principal, f.upProject.ID, teamID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = projects.Transfer(ctx, f.principal, f.upProject.ID, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: preview.TargetTeam.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true})
		if err != nil {
			t.Fatal(err)
		}
	}
	assertGoalRelationState(t, f.db, f.down, 0, 5)
	add.IfRevision = 4
	_, err = tasks.EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, add)
	assertGoalFault(t, err, "goal_dependency_revision_conflict")
	if after := snapshotTask(t, f.db, f.downProject.ID, f.down); after.Version != before.Version+3 {
		t.Fatalf("unexpected Task version: before=%+v after=%+v", before, after)
	}
}

func TestGoalRelationsHiddenEdgesAndAuthorizedSuccessorPagination(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	ctx := t.Context()
	_, viewer, _ := testutil.AuthRecords(t, f.db)
	visibleProject, err := testutil.CreatePrivateProject(ctx, f.db, f.principal, uuid.NewString(), "Visible downstream", "https://example.test/visible-successors")
	if err != nil {
		t.Fatal(err)
	}
	for _, projectID := range []string{f.downProject.ID, visibleProject.ID} {
		mustQueryExec(t, f.db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, projectID, viewer.UserID)
	}
	// Hidden successors have smaller UUIDs than visible successors. Filtering
	// after LIMIT would produce an empty first page or leak a continuation.
	hidden, visible := []string{queryID(10), queryID(11)}, []string{queryID(20), queryID(21)}
	for i, ids := range [][]string{hidden, visible} {
		projectID := f.upProject.ID
		if i == 1 {
			projectID = visibleProject.ID
		}
		for _, id := range ids {
			mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','successor','todo')`, id, projectID)
			if _, err := taskservice.NewTasks(f.db).EditGoalDependencies(ctx, f.principal, projectID, id, goalRelationAdd(f.downProject.ID, f.down, 1)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := taskservice.NewTasks(f.db).EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1)); err != nil {
		t.Fatal(err)
	}
	page := readGoalRelations(t, f.db, viewer, f.downProject.ID, f.down, model.PageRequest{Limit: 1})
	if !page.CanEdit || page.Revision == nil || *page.Revision != 2 || !page.CompletionBlocked || len(page.Prerequisites) != 1 || page.Prerequisites[0].Target != nil || page.Prerequisites[0].EdgeID == nil {
		t.Fatalf("hidden prerequisite projection: %+v", page)
	}
	if len(page.Successors) != 1 || page.Successors[0].GoalID != visible[0] || page.NextCursor == nil {
		t.Fatalf("first authorized page: %+v", page)
	}
	next := readGoalRelations(t, f.db, viewer, f.downProject.ID, f.down, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
	if len(next.Successors) != 1 || next.Successors[0].GoalID != visible[1] || next.NextCursor != nil {
		t.Fatalf("last authorized page: %+v", next)
	}
	_, err = taskservice.NewTasks(f.db).EditGoalDependencies(ctx, viewer, f.downProject.ID, f.down, taskcore.GoalDependencyEdit{IfRevision: 2, Mode: "edit", Remove: []string{*page.Prerequisites[0].EdgeID}})
	if err != nil {
		t.Fatal(err)
	}
	assertGoalRelationState(t, f.db, f.down, 0, 3)
	assertGoalRelationState(t, f.db, visible[0], 1, 2)
	// Reauthorization occurs on every page, even with a valid old cursor.
	mustQueryExec(t, f.db, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, visibleProject.ID, viewer.UserID)
	afterRevocation := readGoalRelations(t, f.db, viewer, f.downProject.ID, f.down, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
	if len(afterRevocation.Successors) != 0 || afterRevocation.NextCursor != nil {
		t.Fatalf("old cursor disclosed revoked successors: %+v", afterRevocation)
	}
}

func TestGoalRelationsFailedSaveRollsBackEdgesAndRevision(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	ctx := t.Context()
	tasks := taskservice.NewTasks(f.db)
	for _, failure := range []string{"revision overflow", "revision SQL failure"} {
		t.Run(failure, func(t *testing.T) {
			mustQueryExec(t, f.db, `DELETE FROM task_dependencies; DELETE FROM goal_dependency_revisions`)
			revision := int64(1)
			if failure == "revision overflow" {
				revision = math.MaxInt64
				mustQueryExec(t, f.db, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,$2)`, f.down, revision)
			} else {
				mustQueryExec(t, f.db, `CREATE FUNCTION refuse_goal_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'revision persistence refused'; END $$;
 CREATE TRIGGER refuse_goal_revision BEFORE INSERT OR UPDATE ON goal_dependency_revisions FOR EACH ROW EXECUTE FUNCTION refuse_goal_revision()`)
				defer mustQueryExec(t, f.db, `DROP TRIGGER refuse_goal_revision ON goal_dependency_revisions; DROP FUNCTION refuse_goal_revision()`)
			}
			receipt, err := tasks.EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, revision))
			if err == nil || receipt.GoalID != "" {
				t.Fatalf("failed save returned receipt: %+v %v", receipt, err)
			}
			if failure == "revision overflow" {
				assertGoalFault(t, err, "version_exhausted")
			}
			assertGoalRelationState(t, f.db, f.down, 0, revision)
		})
	}
}

func TestGoalRelationsTaskTouchFailureRollsBack(t *testing.T) {
	for _, failure := range []string{"version exhaustion", "touch failure"} {
		t.Run(failure, func(t *testing.T) {
			f := emptyGoalRelationFixture(t)
			if failure == "version exhaustion" {
				mustQueryExec(t, f.db, `UPDATE tasks SET version=$1 WHERE id=$2`, int64(math.MaxInt64), f.down)
			} else {
				mustQueryExec(t, f.db, `CREATE FUNCTION refuse_goal_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'task touch refused'; END $$;
      CREATE TRIGGER refuse_goal_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_goal_touch()`)
				defer mustQueryExec(t, f.db, `DROP TRIGGER refuse_goal_touch ON tasks; DROP FUNCTION refuse_goal_touch()`)
			}
			before := snapshotTask(t, f.db, f.downProject.ID, f.down)
			receipt, err := taskservice.NewTasks(f.db).EditGoalDependencies(t.Context(), f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1))
			if err == nil || receipt.GoalID != "" {
				t.Fatalf("failed touch returned receipt: %+v %v", receipt, err)
			}
			if failure == "version exhaustion" {
				assertGoalFault(t, err, "version_exhausted")
			}
			assertGoalRelationState(t, f.db, f.down, 0, 1)
			if after := snapshotTask(t, f.db, f.downProject.ID, f.down); !reflect.DeepEqual(before, after) {
				t.Fatalf("failed edit changed task: before=%+v after=%+v", before, after)
			}
		})
	}
}

func TestGoalRelationsUnknownCommitSuppressesReceiptAndDoesNotReplay(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	result, err := taskservice.NewTasks(projectGoalLostCommit{Store: f.db}).EditGoalDependencies(t.Context(), f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1))
	var unknown *taskservice.GoalWriteUnknown
	if !errors.As(err, &unknown) || result.GoalID != "" {
		t.Fatalf("unknown commit receipt=%+v error=%v", result, err)
	}
	assertGoalRelationState(t, f.db, f.down, 1, 2)
}

func TestGoalRelationsProjectCleanupIncludesNewlyCommittedEdit(t *testing.T) {
	for _, deleting := range []bool{false, true} {
		t.Run(map[bool]string{true: "delete", false: "transfer"}[deleting], func(t *testing.T) {
			f := emptyGoalRelationFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			projects := projectservice.NewProjects(f.db)
			team, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Cleanup destination")
			if err != nil {
				t.Fatal(err)
			}
			preview, err := projects.TransferPreview(ctx, f.principal, f.upProject.ID, team.ID)
			if err != nil {
				t.Fatal(err)
			}
			barrier := &goalCommitBarrier{Store: f.db, prepared: make(chan struct{}), release: make(chan struct{})}
			defer releaseGoalBarrier(barrier)
			editDone, cleanupDone := make(chan error, 1), make(chan error, 1)
			go func() {
				_, err := taskservice.NewTasks(barrier).EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1))
				editDone <- err
			}()
			awaitGoalBarrier(t, ctx, barrier.prepared, editDone)
			go func() {
				if deleting {
					_, err := projects.DeleteWithInput(ctx, f.principal, f.upProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
					cleanupDone <- err
					return
				}
				_, err := projects.Transfer(ctx, f.principal, f.upProject.ID, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: preview.TargetTeam.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true})
				cleanupDone <- err
			}()
			waitGoalAdvisoryWait(t, ctx, f.db)
			releaseGoalBarrier(barrier)
			if err := testutil.ReceiveQueryResult(t, ctx, editDone); err != nil {
				t.Fatal(err)
			}
			if err := testutil.ReceiveQueryResult(t, ctx, cleanupDone); err != nil {
				t.Fatal(err)
			}
			assertGoalRelationState(t, f.db, f.down, 0, 3)
			_, err = taskservice.NewTasks(f.db).EditGoalDependencies(ctx, f.principal, f.downProject.ID, f.down, taskcore.GoalDependencyEdit{IfRevision: 2, Mode: "replace", Prerequisites: []taskcore.GoalDependencyReference{}})
			assertGoalFault(t, err, "goal_dependency_revision_conflict")
			testutil.AssertPoolReusable(t, f.db.Pool)
		})
	}
}

func TestGoalRelationsCanceledGraphWaitReleasesProjectAndConnection(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	barrier := &goalCommitBarrier{Store: f.db, prepared: make(chan struct{}), release: make(chan struct{})}
	defer releaseGoalBarrier(barrier)
	holder := make(chan error, 1)
	go func() {
		_, err := barrier.WriteProject(ctx, f.upProject.ID, func(scope store.ProjectWriteScope) error {
			return scope.GoalDependencyDAO().LockTeam(ctx)
		})
		holder <- err
	}()
	awaitGoalBarrier(t, ctx, barrier.prepared, holder)
	request, stopRequest := context.WithCancel(ctx)
	defer stopRequest()
	result := make(chan error, 1)
	go func() {
		_, err := taskservice.NewTasks(f.db).EditGoalDependencies(request, f.principal, f.downProject.ID, f.down, goalRelationAdd(f.upProject.ID, f.up, 1))
		result <- err
	}()
	waitGoalAdvisoryWait(t, ctx, f.db)
	stopRequest()
	if err := testutil.ReceiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled edit error: %v", err)
	}
	assertGoalRelationState(t, f.db, f.down, 0, 1)
	ordinary := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'task','unrelated','todo')`, ordinary, f.downProject.ID)
	if _, err := taskservice.NewTasks(f.db).SetStatus(ctx, f.principal, f.downProject.ID, ordinary, taskcore.SetTaskStatus{Version: 1, Status: model.TaskInProgress}); err != nil {
		t.Fatalf("canceled relation edit retained the Project lock: %v", err)
	}
	if acquired := f.db.Pool.Stat().AcquiredConns(); acquired != 1 {
		t.Fatalf("canceled waiter retained connection: acquired=%d want only holder", acquired)
	}
	releaseGoalBarrier(barrier)
	if err := testutil.ReceiveQueryResult(t, ctx, holder); err != nil {
		t.Fatal(err)
	}
	testutil.AssertPoolReusable(t, f.db.Pool)
}
