package postgres

import (
	"context"
	"errors"
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

func TestProjectLifecycleGoalCleanupSharesCommitAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	project, external := queryProject(t, db, 1), queryProject(t, db, 2)
	local, remote := queryID(11), queryID(12)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$3,'goal','local','todo'),($2,$4,'goal','remote','todo')`, local, remote, project.ID, external.ID)
	for _, kind := range []string{"transfer", "App transfer", "delete", "App delete"} {
		for _, rollback := range []bool{false, true} {
			t.Run(kind+map[bool]string{true: " rollback", false: " commit"}[rollback], func(t *testing.T) {
				mustQueryExec(t, db, `UPDATE projects SET deleted_at=NULL WHERE id=$1`, project.ID)
				mustQueryExec(t, db, `DELETE FROM task_dependencies; DELETE FROM goal_dependency_revisions`)
				mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, external.ID, remote, local, queryID(21))
				var beforeVersion int64
				if err := db.Pool.QueryRow(t.Context(), `SELECT version FROM project_ownership WHERE project_id=$1`, project.ID).Scan(&beforeVersion); err != nil {
					t.Fatal(err)
				}
				cause := errors.New("refuse after Project and graph effects")
				remove := func(dao store.ProjectGoalDependencyDAO, deleting bool) error {
					return dao.RemoveProjectEdges(t.Context(), deleting)
				}
				finish := func(err error) error {
					if err != nil {
						return err
					}
					if rollback {
						return cause
					}
					return nil
				}
				var completion store.Completion
				var err error
				switch kind {
				case "transfer":
					completion, err = db.WriteProjectTransfer(t.Context(), project.ID, func(scope store.ProjectWriteScope) error {
						dao := scope.ProjectGoalDependencyDAO()
						if err := remove(dao, false); err != nil {
							return err
						}
						_, err := scope.ProjectDAO().MoveOwnership(t.Context(), project.Ownership.TeamID)
						return finish(err)
					})
				case "App transfer":
					completion, err = db.WriteGitHubProjectTransfer(t.Context(), project.ID, func(scope store.GitHubProjectTransferScope) error {
						if err := remove(scope.ProjectGoalDependencyDAO(), false); err != nil {
							return err
						}
						_, err := scope.ProjectDAO().MoveOwnership(t.Context(), project.Ownership.TeamID)
						return finish(err)
					})
				case "delete":
					completion, err = db.WriteProjectDeletion(t.Context(), project.ID, func(scope store.ProjectDeletionScope) error {
						if err := remove(scope.ProjectGoalDependencyDAO(), true); err != nil {
							return err
						}
						_, err := scope.ProjectDAO().MarkDeleted(t.Context())
						return finish(err)
					})
				case "App delete":
					completion, err = db.WriteGitHubProjectDeletion(t.Context(), project.ID, func(scope store.GitHubProjectDeletionScope) error {
						if err := remove(scope.ProjectGoalDependencyDAO(), true); err != nil {
							return err
						}
						_, err := scope.ProjectDAO().MarkDeleted(t.Context())
						return finish(err)
					})
				}
				var edges, revisions int
				var deleted bool
				var version int64
				if readErr := db.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM task_dependencies),(SELECT count(*) FROM goal_dependency_revisions),deleted_at IS NOT NULL,(SELECT version FROM project_ownership WHERE project_id=$1) FROM projects WHERE id=$1`, project.ID).Scan(&edges, &revisions, &deleted, &version); readErr != nil {
					t.Fatal(readErr)
				}
				expectedVersion := beforeVersion
				if !rollback && (kind == "transfer" || kind == "App transfer") {
					expectedVersion++
				}
				expectedDeleted := !rollback && (kind == "delete" || kind == "App delete")
				if version != expectedVersion || deleted != expectedDeleted {
					t.Fatalf("project effects version=%d want %d deleted=%v want %v", version, expectedVersion, deleted, expectedDeleted)
				}
				if rollback {
					if !errors.Is(err, cause) || completion.Outcome != store.TransactionNotCommitted || edges != 1 || revisions != 0 {
						t.Fatalf("rollback completion=%+v edges=%d revisions=%d error=%v", completion, edges, revisions, err)
					}
				} else {
					if err != nil || completion.Outcome != store.TransactionCommitted || edges != 0 || revisions != 1 {
						t.Fatalf("commit completion=%+v edges=%d revisions=%d error=%v", completion, edges, revisions, err)
					}
				}
			})
		}
	}
}

type goalProjectLifecycle interface {
	TransferPreview(context.Context, model.Principal, string, string) (coreproject.TransferPreview, error)
	Transfer(context.Context, model.Principal, string, coreproject.TransferInput) (coreproject.TransferReceipt, error)
	DeleteWithInput(context.Context, model.Principal, string, coreproject.DeletionInput) (projectservice.DeletionReceipt, error)
}

func TestProjectLifecycleGraphWaitPrecedesTaskLocksAndReleasesResources(t *testing.T) {
	db := isolatedStore(t)
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			if !t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := seedGoalLifecycleFixture(t, db, model.TaskTodo, model.TaskTodo)
				ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
				defer cancel()
				var service goalProjectLifecycle = projectservice.NewProjects(f.db)
				if app {
					service = projectservice.NewAppProjects(f.db)
				}
				input := coreproject.TransferInput{}
				if !deleting {
					preview, err := service.TransferPreview(ctx, f.principal, f.downProject.ID, f.downProject.Ownership.TeamID)
					if err != nil {
						t.Fatal(err)
					}
					input = coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: preview.TargetTeam.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID}
				}
				acquired, release, stopped := make(chan struct{}), make(chan struct{}), make(chan error, 1)
				defer func() {
					select {
					case <-release:
					default:
						close(release)
					}
				}()
				go func() {
					_, err := f.db.WriteProject(ctx, f.upProject.ID, func(scope store.ProjectWriteScope) error {
						if err := scope.GoalDependencyDAO().LockTeam(ctx); err != nil {
							return err
						}
						close(acquired)
						select {
						case <-release:
							return nil
						case <-ctx.Done():
							return ctx.Err()
						}
					})
					stopped <- err
				}()
				awaitGoalBarrier(t, ctx, acquired, stopped)
				waiting, stopWaiting := context.WithCancel(ctx)
				defer stopWaiting()
				result := make(chan error, 1)
				go func() {
					var err error
					if deleting {
						_, err = service.DeleteWithInput(waiting, f.principal, f.downProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
					} else {
						_, err = service.Transfer(waiting, f.principal, f.downProject.ID, input)
					}
					result <- err
				}()
				waitGoalAdvisoryWait(t, ctx, f.db)
				var waitingPID int32
				if err := f.db.Pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`).Scan(&waitingPID); err != nil {
					t.Fatal(err)
				}
				probe, err := f.db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = probe.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE NOWAIT`, f.down); err != nil {
					probe.Rollback(ctx)
					t.Fatalf("Task locked before graph lock: %v", err)
				}
				if err = probe.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				stopWaiting()
				if err = testutil.ReceiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation lost: %v", err)
				}
				// Canceled pgx calls return before their closed socket finishes cleanup.
				// https://github.com/jackc/pgx/blob/5e583fa7aabfa88b796292f849fc9d7d75ac159d/pgconn/pgconn.go#L804-L813
				cleanup, stopCleanup := context.WithTimeout(ctx, cleanupTimeout)
				defer stopCleanup()
				for {
					var stopped bool
					if err := f.db.Pool.QueryRow(cleanup, `SELECT NOT EXISTS(SELECT FROM pg_stat_activity WHERE pid=$1)`, waitingPID).Scan(&stopped); err != nil {
						t.Fatalf("canceled backend did not finish cleanup: %v", err)
					}
					if stopped {
						break
					}
					if err := testutil.WaitThreadClock(cleanup); err != nil {
						t.Fatalf("canceled backend retained resources: %v", err)
					}
				}
				probe, err = f.db.Pool.Begin(cleanup)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = probe.Exec(cleanup, `SELECT id FROM projects WHERE id=$1 FOR UPDATE NOWAIT`, f.downProject.ID); err != nil {
					probe.Rollback(cleanup)
					t.Fatalf("Project retained after cancellation: %v", err)
				}
				if err = probe.Rollback(cleanup); err != nil {
					t.Fatal(err)
				}
				// Pool destruction releases its slot after driver cleanup, asynchronously.
				// https://github.com/jackc/pgx/blob/5e583fa7aabfa88b796292f849fc9d7d75ac159d/pgxpool/pool.go#L309-L325
				for {
					count := f.db.Pool.Stat().AcquiredConns()
					if count == 1 {
						break
					}
					if err := testutil.WaitThreadClock(cleanup); err != nil {
						t.Fatalf("connections retained %d want holder only: %v", count, err)
					}
				}
				close(release)
				if err = testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
					t.Fatal(err)
				}
				testutil.AssertPoolReusable(t, f.db.Pool)
			}) {
				return
			}
		}
	}
}

func TestProjectLifecycleRealScopesRequireConfirmationAndRollbackExhaustion(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				ctx := t.Context()
				var service goalProjectLifecycle = projectservice.NewProjects(f.db)
				if app {
					service = projectservice.NewAppProjects(f.db)
				}
				target, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, queryID(90), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				preview, err := service.TransferPreview(ctx, f.principal, f.downProject.ID, target.ID)
				if err != nil {
					t.Fatal(err)
				}
				input := coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID}
				invoke := func(confirmed bool) error {
					if deleting {
						_, err := service.DeleteWithInput(ctx, f.principal, f.downProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: confirmed})
						return err
					}
					input.ConfirmGoalDependencyRemoval = confirmed
					_, err := service.Transfer(ctx, f.principal, f.downProject.ID, input)
					return err
				}
				assertGoalFault(t, invoke(false), "invalid_input")
				mustQueryExec(t, f.db, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,9223372036854775807)`, f.down)
				assertGoalFault(t, invoke(true), "version_exhausted")
				var edges int
				var deleted bool
				var owner string
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_dependencies WHERE dependency_type='goal'),deleted_at IS NOT NULL,(SELECT team_id::text FROM project_ownership WHERE project_id=$1) FROM projects WHERE id=$1`, f.downProject.ID).Scan(&edges, &deleted, &owner); err != nil || edges != 1 || deleted || owner != f.downProject.Ownership.TeamID {
					t.Fatalf("refusal changed state edges=%d deleted=%v owner=%s error=%v", edges, deleted, owner, err)
				}
				mustQueryExec(t, f.db, `UPDATE goal_dependency_revisions SET revision=7 WHERE goal_id=$1`, f.down)
				if err = invoke(true); err != nil {
					t.Fatal(err)
				}
				var revision int64
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_dependencies WHERE dependency_type='goal'),(SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1)`, f.down).Scan(&edges, &revision); err != nil || edges != 0 || revision != 8 {
					t.Fatalf("cleanup edges=%d revision=%d error=%v", edges, revision, err)
				}
			})
		}
	}
}

func TestProjectLifecycleRechecksAuthorizationAfterGraphLock(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
				defer cancel()
				team, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, queryID(90), "Source")
				if err != nil {
					t.Fatal(err)
				}
				mustQueryExec(t, f.db, `UPDATE project_ownership SET team_id=$1 WHERE project_id IN($2,$3)`, team.ID, f.upProject.ID, f.downProject.ID)
				var service goalProjectLifecycle = projectservice.NewProjects(f.db)
				if app {
					service = projectservice.NewAppProjects(f.db)
				}
				preview, err := service.TransferPreview(ctx, f.principal, f.downProject.ID, f.downProject.Ownership.TeamID)
				if err != nil {
					t.Fatal(err)
				}
				input := coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: preview.TargetTeam.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true}
				acquired, release, stopped := make(chan struct{}), make(chan struct{}), make(chan error, 1)
				defer func() {
					select {
					case <-release:
					default:
						close(release)
					}
				}()
				go func() {
					_, err := f.db.WriteProject(ctx, f.upProject.ID, func(scope store.ProjectWriteScope) error {
						if err := scope.GoalDependencyDAO().LockTeam(ctx); err != nil {
							return err
						}
						close(acquired)
						select {
						case <-release:
							return nil
						case <-ctx.Done():
							return ctx.Err()
						}
					})
					stopped <- err
				}()
				awaitGoalBarrier(t, ctx, acquired, stopped)
				result := make(chan error, 1)
				go func() {
					var err error
					if deleting {
						_, err = service.DeleteWithInput(ctx, f.principal, f.downProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
					} else {
						_, err = service.Transfer(ctx, f.principal, f.downProject.ID, input)
					}
					result <- err
				}()
				waitGoalAdvisoryWait(t, ctx, f.db)
				mustQueryExec(t, f.db, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, f.principal.UserID)
				close(release)
				if err = testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
					t.Fatal(err)
				}
				assertGoalFault(t, testutil.ReceiveQueryResult(t, ctx, result), "forbidden")
				var edges int
				var deleted bool
				var owner string
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_dependencies WHERE dependency_type='goal'),deleted_at IS NOT NULL,(SELECT team_id::text FROM project_ownership WHERE project_id=$1) FROM projects WHERE id=$1`, f.downProject.ID).Scan(&edges, &deleted, &owner); err != nil || edges != 1 || deleted || owner != team.ID {
					t.Fatalf("revocation state edges=%d deleted=%v owner=%s error=%v", edges, deleted, owner, err)
				}
			})
		}
	}
}

type projectGoalLostCommit struct{ *Store }

func projectGoalUnknown(c store.Completion, err error) (store.Completion, error) {
	if err != nil || c.Outcome != store.TransactionCommitted {
		return c, err
	}
	return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("commit acknowledgement lost")}
}
func (s projectGoalLostCommit) WriteProject(ctx context.Context, id string, op func(store.ProjectWriteScope) error) (store.Completion, error) {
	return projectGoalUnknown(s.Store.WriteProject(ctx, id, op))
}
func (s projectGoalLostCommit) WriteProjectTransfer(ctx context.Context, id string, op func(store.ProjectWriteScope) error) (store.Completion, error) {
	return projectGoalUnknown(s.Store.WriteProjectTransfer(ctx, id, op))
}
func (s projectGoalLostCommit) WriteProjectDeletion(ctx context.Context, id string, op func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return projectGoalUnknown(s.Store.WriteProjectDeletion(ctx, id, op))
}
func (s projectGoalLostCommit) WriteGitHubProjectTransfer(ctx context.Context, id string, op func(store.GitHubProjectTransferScope) error) (store.Completion, error) {
	return projectGoalUnknown(s.Store.WriteGitHubProjectTransfer(ctx, id, op))
}
func (s projectGoalLostCommit) WriteGitHubProjectDeletion(ctx context.Context, id string, op func(store.GitHubProjectDeletionScope) error) (store.Completion, error) {
	return projectGoalUnknown(s.Store.WriteGitHubProjectDeletion(ctx, id, op))
}

func TestProjectLifecycleUnknownCompletionSuppressesReceiptWithoutReplaying(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				db := projectGoalLostCommit{f.db}
				var service goalProjectLifecycle = projectservice.NewProjects(db)
				if app {
					service = projectservice.NewAppProjects(db)
				}
				ctx := t.Context()
				var err error
				if deleting {
					var receipt projectservice.DeletionReceipt
					receipt, err = service.DeleteWithInput(ctx, f.principal, f.downProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
					if receipt.Deleted {
						t.Fatal("unknown deletion returned receipt")
					}
					var failure *projectservice.DeletionFailure
					if !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown {
						t.Fatalf("unknown deletion error %v", err)
					}
				} else {
					target, targetErr := testutil.CreateTeam(ctx, f.db, f.principal.UserID, queryID(90), "Destination")
					if targetErr != nil {
						t.Fatal(targetErr)
					}
					preview, previewErr := service.TransferPreview(ctx, f.principal, f.downProject.ID, target.ID)
					if previewErr != nil {
						t.Fatal(previewErr)
					}
					receipt, transferErr := service.Transfer(ctx, f.principal, f.downProject.ID, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true})
					err = transferErr
					if receipt.ProjectID != "" {
						t.Fatal("unknown transfer returned receipt")
					}
					var failure *store.TransactionError
					if !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown {
						t.Fatalf("unknown transfer error %v", err)
					}
				}
				if err == nil {
					t.Fatal("unknown completion accepted")
				}
				var edges int
				var revision int64
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_dependencies WHERE dependency_type='goal'),(SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1)`, f.down).Scan(&edges, &revision); err != nil || edges != 0 || revision != 2 {
					t.Fatalf("committed cleanup was replayed or lost: edges=%d revision=%d error=%v", edges, revision, err)
				}
			})
		}
	}
}

func TestProjectLifecycleCleanupIncludesEdgesCommittedDuringGraphWait(t *testing.T) {
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
				ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
				defer cancel()
				extraUp, extraDown := queryID(81), queryID(82)
				mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$3,'goal','new upstream','todo'),($2,$4,'goal','new downstream','todo')`, extraUp, extraDown, f.upProject.ID, f.downProject.ID)
				target, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, queryID(90), "Destination")
				if err != nil {
					t.Fatal(err)
				}
				var service goalProjectLifecycle = projectservice.NewProjects(f.db)
				if app {
					service = projectservice.NewAppProjects(f.db)
				}
				preview, err := service.TransferPreview(ctx, f.principal, f.downProject.ID, target.ID)
				if err != nil {
					t.Fatal(err)
				}
				input := coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: preview.TargetTeamVersion}, ExpectedUserID: f.principal.UserID, ConfirmGoalDependencyRemoval: true}
				acquired, release, stopped := make(chan struct{}), make(chan struct{}), make(chan error, 1)
				defer func() {
					select {
					case <-release:
					default:
						close(release)
					}
				}()
				go func() {
					_, err := f.db.WriteProject(ctx, f.upProject.ID, func(scope store.ProjectWriteScope) error {
						if err := scope.GoalDependencyDAO().LockTeam(ctx); err != nil {
							return err
						}
						close(acquired)
						select {
						case <-release:
						case <-ctx.Done():
							return ctx.Err()
						}
						_, err := scope.(*ProjectTx).tx.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$6),($1,$4,$5,'goal',$7)`, f.downProject.ID, f.down, extraUp, extraDown, f.up, queryID(91), queryID(92))
						return err
					})
					stopped <- err
				}()
				awaitGoalBarrier(t, ctx, acquired, stopped)
				result := make(chan error, 1)
				go func() {
					var err error
					if deleting {
						_, err = service.DeleteWithInput(ctx, f.principal, f.downProject.ID, coreproject.DeletionInput{ConfirmGoalDependencyRemoval: true})
					} else {
						_, err = service.Transfer(ctx, f.principal, f.downProject.ID, input)
					}
					result <- err
				}()
				waitGoalAdvisoryWait(t, ctx, f.db)
				close(release)
				if err = testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
					t.Fatal(err)
				}
				if err = testutil.ReceiveQueryResult(t, ctx, result); err != nil {
					t.Fatal(err)
				}
				var edges, revisions int
				var downRevision, extraRevision int64
				if err = f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_dependencies WHERE dependency_type='goal'),(SELECT count(*) FROM goal_dependency_revisions),(SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1),(SELECT revision FROM goal_dependency_revisions WHERE goal_id=$2)`, f.down, extraDown).Scan(&edges, &revisions, &downRevision, &extraRevision); err != nil || edges != 0 || revisions != 2 || downRevision != 2 || extraRevision != 2 {
					t.Fatalf("missed committed edges or advanced twice: edges=%d revisions=%d downstream=%d extra=%d error=%v", edges, revisions, downRevision, extraRevision, err)
				}
			})
		}
	}
}

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
	db := isolatedStore(t)
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			if !t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := seedGoalLifecycleFixture(t, db, model.TaskTodo, model.TaskTodo)
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
			}) {
				return
			}
			testutil.AssertPoolReusable(t, db.Pool)
		}
	}
}

func TestProjectCleanupTaskWatermarkFailureRollsBack(t *testing.T) {
	db := isolatedStore(t)
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			for _, failure := range []string{"version exhaustion", "touch failure"} {
				if !t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete/", false: " transfer/"}[deleting]+failure, func(t *testing.T) {
					f := seedGoalLifecycleFixture(t, db, model.TaskTodo, model.TaskTodo)
					ctx := t.Context()
					if failure == "version exhaustion" {
						mustQueryExec(t, f.db, `UPDATE tasks SET version=$1 WHERE id=$2`, int64(math.MaxInt64), f.down)
					} else {
						mustQueryExec(t, f.db, `CREATE FUNCTION refuse_cleanup_goal_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup touch refused'; END $$;
      CREATE TRIGGER refuse_cleanup_goal_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_cleanup_goal_touch()`)
						defer func() {
							cleanup, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
							defer cancel()
							if _, err := f.db.Pool.Exec(cleanup, `DROP TRIGGER refuse_cleanup_goal_touch ON tasks; DROP FUNCTION refuse_cleanup_goal_touch()`); err != nil {
								t.Errorf("remove touch fault: %v", err)
								return
							}
							if err := checkFaultTriggerRemoved(cleanup, f.db, "refuse_cleanup_goal_touch", "tasks"); err != nil {
								t.Errorf("verify touch fault cleanup: %v", err)
							}
						}()
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
				}) {
					return
				}
				testutil.AssertPoolReusable(t, db.Pool)
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
