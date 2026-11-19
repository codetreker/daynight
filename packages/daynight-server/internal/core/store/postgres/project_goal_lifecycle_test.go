package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
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
				remove := func(dao store.ProjectGoalDependencyDAO) error { return dao.RemoveProjectEdges(t.Context()) }
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
					completion, err = db.WriteProject(t.Context(), project.ID, func(scope store.ProjectWriteScope) error {
						dao := scope.ProjectGoalDependencyDAO()
						if err := dao.LockTeam(t.Context()); err != nil {
							return err
						}
						if err := remove(dao); err != nil {
							return err
						}
						_, err := scope.ProjectDAO().MoveOwnership(t.Context(), project.Ownership.TeamID)
						return finish(err)
					})
				case "App transfer":
					completion, err = db.WriteGitHubProjectTransfer(t.Context(), project.ID, func(scope store.GitHubProjectTransferScope) error {
						if err := remove(scope.ProjectGoalDependencyDAO()); err != nil {
							return err
						}
						_, err := scope.ProjectDAO().MoveOwnership(t.Context(), project.Ownership.TeamID)
						return finish(err)
					})
				case "delete":
					completion, err = db.WriteProjectDeletion(t.Context(), project.ID, func(scope store.ProjectDeletionScope) error {
						if err := remove(scope.ProjectGoalDependencyDAO()); err != nil {
							return err
						}
						_, err := scope.ProjectDAO().MarkDeleted(t.Context())
						return finish(err)
					})
				case "App delete":
					completion, err = db.WriteGitHubProjectDeletion(t.Context(), project.ID, func(scope store.GitHubProjectDeletionScope) error {
						if err := remove(scope.ProjectGoalDependencyDAO()); err != nil {
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
	for _, app := range []bool{false, true} {
		for _, deleting := range []bool{false, true} {
			t.Run(map[bool]string{true: "App", false: "base"}[app]+map[bool]string{true: " delete", false: " transfer"}[deleting], func(t *testing.T) {
				f := newGoalLifecycleFixture(t, model.TaskTodo, model.TaskTodo)
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
				probe, err = f.db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = probe.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE NOWAIT`, f.downProject.ID); err != nil {
					probe.Rollback(ctx)
					t.Fatalf("Project retained after cancellation: %v", err)
				}
				if err = probe.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if count := f.db.Pool.Stat().AcquiredConns(); count != 1 {
					t.Fatalf("connections retained %d want holder only", count)
				}
				close(release)
				if err = testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
					t.Fatal(err)
				}
				testutil.AssertPoolReusable(t, f.db.Pool)
			})
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
