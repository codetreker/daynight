package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type goalCommitBarrier struct {
	*Store
	prepared chan struct{}
	release  chan struct{}
}

func (s *goalCommitBarrier) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error {
		if err := work(scope); err != nil {
			return err
		}
		close(s.prepared)
		select {
		case <-s.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

type goalLifecycleFixture struct {
	db                     *Store
	principal              model.Principal
	upProject, downProject model.Project
	up, down               string
}

func newGoalLifecycleFixture(t *testing.T, upStatus, downStatus model.TaskStatus) goalLifecycleFixture {
	t.Helper()
	return seedGoalLifecycleFixture(t, isolatedStore(t), upStatus, downStatus)
}

func seedGoalLifecycleFixture(t *testing.T, db *Store, upStatus, downStatus model.TaskStatus) goalLifecycleFixture {
	t.Helper()
	principal, _, upProject := testutil.ProjectMembershipFixture(t, db)
	downProject, err := testutil.CreatePrivateProject(t.Context(), db, principal, uuid.NewString(), "Downstream", "https://example.test/goal-downstream")
	if err != nil {
		t.Fatal(err)
	}
	if upProject.Ownership.TeamID != downProject.Ownership.TeamID {
		t.Fatal("projects are not on the same Team")
	}
	up, down := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status,completed_at) VALUES
 ($1,$2,'goal','upstream',$3,CASE WHEN $3='done' THEN now() END),
 ($4,$5,'goal','downstream',$6,CASE WHEN $6='done' THEN now() END)`, up, upProject.ID, string(upStatus), down, downProject.ID, string(downStatus))
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, downProject.ID, down, up, uuid.NewString())
	return goalLifecycleFixture{db: db, principal: principal, upProject: upProject, downProject: downProject, up: up, down: down}
}

func awaitGoalBarrier(t *testing.T, ctx context.Context, acquired <-chan struct{}, result <-chan error) {
	t.Helper()
	select {
	case <-acquired:
	case err := <-result:
		t.Fatalf("first operation did not reach commit barrier: %v", err)
	case <-ctx.Done():
		t.Fatal("first operation did not reach commit barrier")
	}
}

func waitGoalAdvisoryWait(t *testing.T, ctx context.Context, db *Store) {
	t.Helper()
	for {
		var waiting bool
		err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("operation did not reach Team lock: %v", err)
		}
	}
}

func assertGoalFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || len(fault.TaskIDs) != 0 {
		t.Fatalf("wanted %s without remote IDs: %v", code, err)
	}
}

func TestGoalCompletionAndReopenSerializeAcrossProjects(t *testing.T) {
	for _, downFirst := range []bool{true, false} {
		name := "upstream_reopens_first"
		if downFirst {
			name = "downstream_completes_first"
		}
		t.Run(name, func(t *testing.T) {
			f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			barrier := &goalCommitBarrier{Store: f.db, prepared: make(chan struct{}), release: make(chan struct{})}
			defer func() {
				select {
				case <-barrier.release:
				default:
					close(barrier.release)
				}
			}()
			firstService, secondService := taskservice.NewTasks(barrier), taskservice.NewTasks(f.db)
			firstProject, firstID, firstStatus := f.upProject.ID, f.up, model.TaskTodo
			secondProject, secondID, secondStatus := f.downProject.ID, f.down, model.TaskDone
			if downFirst {
				firstProject, firstID, firstStatus, secondProject, secondID, secondStatus = secondProject, secondID, secondStatus, firstProject, firstID, firstStatus
			}
			var otherProject, otherGoal string
			if downFirst {
				otherProject, otherGoal = seedIndependentTeamGoal(t, ctx, f)
			}
			firstDone := make(chan error, 1)
			go func() {
				_, err := firstService.SetStatus(ctx, f.principal, firstProject, firstID, taskcore.SetTaskStatus{Version: 1, Status: firstStatus})
				firstDone <- err
			}()
			awaitGoalBarrier(t, ctx, barrier.prepared, firstDone)
			secondDone := make(chan error, 1)
			go func() {
				_, err := secondService.SetStatus(ctx, f.principal, secondProject, secondID, taskcore.SetTaskStatus{Version: 1, Status: secondStatus})
				secondDone <- err
			}()
			waitGoalAdvisoryWait(t, ctx, f.db)
			if downFirst {
				independent, stop := context.WithTimeout(ctx, 2*time.Second)
				defer stop()
				got, err := secondService.SetStatus(independent, f.principal, otherProject, otherGoal, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
				if err != nil || got.Status != model.TaskDone {
					t.Fatalf("independent Team blocked: %+v %v", got, err)
				}
			}
			close(barrier.release)
			if err := testutil.ReceiveQueryResult(t, ctx, firstDone); err != nil {
				t.Fatalf("first operation: %v", err)
			}
			err := testutil.ReceiveQueryResult(t, ctx, secondDone)
			if downFirst {
				assertGoalFault(t, err, "goal_dependency_done_successor")
			} else {
				assertGoalFault(t, err, "goal_dependency_unsatisfied")
			}
			up := snapshotTask(t, f.db, f.upProject.ID, f.up)
			down := snapshotTask(t, f.db, f.downProject.ID, f.down)
			if downFirst {
				if up.Status != model.TaskDone || up.Version != 1 || down.Status != model.TaskDone || down.Version != 2 {
					t.Fatalf("completion-first readback: up=%+v down=%+v", up, down)
				}
			} else if up.Status != model.TaskTodo || up.Version != 2 || down.Status != model.TaskTodo || down.Version != 1 {
				t.Fatalf("reopen-first readback: up=%+v down=%+v", up, down)
			}
		})
	}
}

func seedIndependentTeamGoal(t *testing.T, ctx context.Context, f goalLifecycleFixture) (string, string) {
	t.Helper()
	team, err := testutil.CreateTeam(ctx, f.db, f.principal.UserID, uuid.NewString(), "Independent Team")
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := testutil.CreateProjectInTeam(ctx, f.db, f.principal, uuid.NewString(), "Independent", "https://example.test/other-team", &team.ID)
	if err != nil {
		t.Fatal(err)
	}
	otherGoal := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','independent','todo')`, otherGoal, other.ID)
	return other.ID, otherGoal
}

func TestGoalDeleteProtectsIncomingAndRetainsRevision(t *testing.T) {
	f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
	ctx := t.Context()
	tasks := taskservice.NewTasks(f.db)
	before := snapshotTask(t, f.db, f.upProject.ID, f.up)
	err := tasks.Delete(ctx, f.principal, f.upProject.ID, f.up, taskcore.DeleteTask{Version: before.Version})
	assertGoalFault(t, err, "goal_dependency_referenced")
	if got := snapshotTask(t, f.db, f.upProject.ID, f.up); got.Version != before.Version || got.Status != before.Status {
		t.Fatalf("rejected deletion changed Goal: %+v", got)
	}
	mustQueryExec(t, f.db, `DELETE FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND depends_on_task_id=$3 AND dependency_type='goal'`, f.downProject.ID, f.down, f.up)
	mustQueryExec(t, f.db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, f.upProject.ID, f.up, f.down, uuid.NewString())
	mustQueryExec(t, f.db, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,7)`, f.up)
	if err := tasks.Delete(ctx, f.principal, f.upProject.ID, f.up, taskcore.DeleteTask{Version: before.Version}); err != nil {
		t.Fatal(err)
	}
	var deleted bool
	var outgoing int
	var revision int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT deleted_at IS NOT NULL FROM tasks WHERE id=$1), (SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND dependency_type='goal'), (SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1)`, f.up).Scan(&deleted, &outgoing, &revision); err != nil || !deleted || outgoing != 0 || revision != 8 {
		t.Fatalf("delete readback deleted=%v outgoing=%d revision=%d error=%v", deleted, outgoing, revision, err)
	}
}

func TestGoalTeamLockTimeoutReleasesProjectAndConnection(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	acquired, release, stopped := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	go func() {
		completion, err := f.db.WriteProject(ctx, f.upProject.ID, func(scope store.ProjectWriteScope) error {
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
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = errors.New("holder transaction not committed")
		}
		stopped <- err
	}()
	awaitGoalBarrier(t, ctx, acquired, stopped)
	tasks := taskservice.NewTasks(f.db)
	result := make(chan error, 1)
	waiting, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	go func() {
		_, err := tasks.SetStatus(waiting, f.principal, f.downProject.ID, f.down, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
		result <- err
	}()
	waitGoalAdvisoryWait(t, waiting, f.db)
	err := testutil.ReceiveQueryResult(t, ctx, result)
	if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(waiting.Err(), context.DeadlineExceeded) || ctx.Err() != nil {
		t.Fatalf("Goal did not time out under held Team lock: wait=%v caller=%v error=%v", waiting.Err(), ctx.Err(), err)
	}
	if got := snapshotTask(t, f.db, f.downProject.ID, f.down); got.Status != model.TaskTodo || got.Version != 1 {
		t.Fatalf("timed-out Goal changed: %+v", got)
	}
	ordinary := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'task','unrelated','todo')`, ordinary, f.downProject.ID)
	changed, err := tasks.SetStatus(ctx, f.principal, f.downProject.ID, ordinary, taskcore.SetTaskStatus{Version: 1, Status: model.TaskInProgress})
	if err != nil || changed.Status != model.TaskInProgress {
		t.Fatalf("ordinary Task could not acquire released Project lock: %+v %v", changed, err)
	}
	if acquired := f.db.Pool.Stat().AcquiredConns(); acquired != 1 {
		t.Fatalf("timed-out waiter retained a connection: %d acquired, want only holder", acquired)
	}
	close(release)
	if err := testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
		t.Fatal(err)
	}
	testutil.AssertPoolReusable(t, f.db.Pool)
}

// Revoking the only access source while a Goal write waits must take effect
// before the waiting transaction evaluates or changes the Goal.
func TestGoalLifecycleRechecksAuthorizationAfterTeamLockWait(t *testing.T) {
	for _, operation := range []string{"status", "delete"} {
		t.Run(operation, func(t *testing.T) {
			db, admin, _, _ := membershipFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, member, _ := testutil.AuthRecords(t, db)
			team, err := testutil.CreateTeam(ctx, db, admin.UserID, uuid.NewString(), "Revocation Team")
			if err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, member.UserID)
			project, _, err := testutil.CreateProjectInTeam(ctx, db, admin, uuid.NewString(), "Target", "https://example.test/goal-revocation-target", &team.ID)
			if err != nil {
				t.Fatal(err)
			}
			holderProject, _, err := testutil.CreateProjectInTeam(ctx, db, admin, uuid.NewString(), "Holder", "https://example.test/goal-revocation-holder", &team.ID)
			if err != nil {
				t.Fatal(err)
			}
			goal := uuid.NewString()
			mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','protected','todo')`, goal, project.ID)
			var membershipVersion int64
			var directGrant bool
			if err := db.Pool.QueryRow(ctx, `SELECT m.version, EXISTS(SELECT 1 FROM project_grants WHERE project_id=$3 AND user_id=$2) FROM team_members m WHERE m.team_id=$1 AND m.user_id=$2`, team.ID, member.UserID, project.ID).Scan(&membershipVersion, &directGrant); err != nil || directGrant {
				t.Fatalf("member did not have Team-only access: direct=%v error=%v", directGrant, err)
			}
			before := snapshotTask(t, db, project.ID, goal)
			acquired, release, stopped := make(chan struct{}), make(chan struct{}), make(chan error, 1)
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			go func() {
				completion, err := db.WriteProject(ctx, holderProject.ID, func(scope store.ProjectWriteScope) error {
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
				if err == nil && completion.Outcome != store.TransactionCommitted {
					err = errors.New("holder transaction not committed")
				}
				stopped <- err
			}()
			awaitGoalBarrier(t, ctx, acquired, stopped)
			result := make(chan error, 1)
			go func() {
				tasks := taskservice.NewTasks(db)
				if operation == "delete" {
					result <- tasks.Delete(ctx, member, project.ID, goal, taskcore.DeleteTask{Version: before.Version})
					return
				}
				_, err := tasks.SetStatus(ctx, member, project.ID, goal, taskcore.SetTaskStatus{Version: before.Version, Status: model.TaskDone})
				result <- err
			}()
			waitGoalAdvisoryWait(t, ctx, db)
			_, err = teamservice.NewTeams(db).RemoveMember(ctx, admin, team.ID, member.UserID, teamcore.ChangeTeamMember{Version: membershipVersion, ExpectedUserID: admin.UserID})
			if err != nil {
				t.Fatalf("remove Team membership during lock wait: %v", err)
			}
			close(release)
			if err := testutil.ReceiveQueryResult(t, ctx, stopped); err != nil {
				t.Fatal(err)
			}
			assertGoalFault(t, testutil.ReceiveQueryResult(t, ctx, result), "not_found")
			after := snapshotTask(t, db, project.ID, goal)
			if after.Status != before.Status || after.Version != before.Version || !after.UpdatedAt.Equal(before.UpdatedAt) || after.CompletedAt != nil {
				t.Fatalf("revoked %s changed Goal: before=%+v after=%+v", operation, before, after)
			}
		})
	}
}

// Hold the only connection after the real type snapshot has ended, before the
// service can begin its write. The snapshot itself keeps the caller's context.
type goalPoolAdmissionBarrier struct {
	*Store
	t            *testing.T
	caller       context.Context
	held         *pgxpool.Conn
	preflightEnd time.Time
}

func (s *goalPoolAdmissionBarrier) ReadSnapshot(ctx context.Context, work func(store.SnapshotScope) error) error {
	if ctx != s.caller {
		s.t.Fatal("type preflight did not retain caller context")
	}
	if err := s.Store.ReadSnapshot(ctx, work); err != nil {
		return err
	}
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	s.held = conn
	s.preflightEnd = time.Now()
	return nil
}

func (s *goalPoolAdmissionBarrier) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	deadline, ok := ctx.Deadline()
	const goalBudget = 5 * time.Second
	if s.held == nil || !ok || deadline.Before(s.preflightEnd.Add(goalBudget)) || deadline.After(time.Now().Add(goalBudget)) {
		s.t.Fatalf("Goal write did not get its branch deadline after type preflight: deadline=%v, preflight ended=%v", deadline, s.preflightEnd)
	}
	// Verify the service's actual deadline above and let pgx wait on a shorter
	// child deadline so this test does not spend the full production budget.
	waiting, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	return s.Store.WriteProject(waiting, id, work)
}

func TestGoalWritePoolWaitHasBranchDeadline(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newGoalLifecycleFixture(t, model.TaskDone, model.TaskTodo)
	for _, operation := range []string{"status", "delete"} {
		if !t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			config := f.db.Pool.Config()
			config.MaxConns, config.MinConns = 1, 0
			pool, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			barrier := &goalPoolAdmissionBarrier{Store: &Store{Pool: pool}, t: t, caller: ctx}
			t.Cleanup(func() {
				if barrier.held != nil {
					barrier.held.Release()
				}
			})
			beforeCanceled := pool.Stat().CanceledAcquireCount()
			tasks := taskservice.NewTasks(barrier)
			if operation == "delete" {
				err = tasks.Delete(ctx, f.principal, f.downProject.ID, f.down, taskcore.DeleteTask{Version: 1})
			} else {
				_, err = tasks.SetStatus(ctx, f.principal, f.downProject.ID, f.down, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
			}
			if !errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
				t.Fatalf("write did not time out while waiting for pool: caller=%v error=%v", ctx.Err(), err)
			}
			if stat := pool.Stat(); stat.CanceledAcquireCount() != beforeCanceled+1 || stat.AcquiredConns() != 1 {
				t.Fatalf("pool did not cancel its blocked write acquisition: canceled=%d acquired=%d", stat.CanceledAcquireCount(), stat.AcquiredConns())
			}
			goal := snapshotTask(t, f.db, f.downProject.ID, f.down)
			if goal.Status != model.TaskTodo || goal.Version != 1 {
				t.Fatalf("pool timeout changed Goal: %+v", goal)
			}
			barrier.held.Release()
			barrier.held = nil
			testutil.AssertPoolReusable(t, pool)
		}) {
			return
		}
	}
}

func TestGoalDeletionWaitsForResourceWrites(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	project, goal, task := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := db.CreateProject(ctx, project, "Goal resources", "https://example.test/goal"); err != nil {
		t.Fatal(err)
	}
	var user string
	if err := db.Pool.QueryRow(ctx, `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1`, project).Scan(&user); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, db.Pool, `INSERT INTO tasks(id,project_id,type,title,parent_id) VALUES($1,$3,'goal','Goal',NULL),($2,$3,'task','Child',$1)`, goal, task, project)
	pat := uuid.NewString()
	testutil.MustExec(t, db.Pool, `INSERT INTO personal_access_tokens(business_scopes,scope_version,id,user_id,token_hash,name,created_at) VALUES(ARRAY['attachment:delete','attachment:read','attachment:upload','session:control','session:produce','session:read','session:send','task:read','thread:post','thread:read','usage:read'],1,$1,$2,$3,'resource test',now())`, pat, user, make([]byte, 32))
	principal := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: pat}

	for _, kind := range []string{"thread", "attachment", "transfer", "transfer_lifecycle", "session", "session_registration", "steps"} {
		t.Run(kind, func(t *testing.T) {
			testutil.MustExec(t, db.Pool, `UPDATE tasks SET deleted_at=NULL,ancestor_deleted_at=NULL WHERE project_id=$1`, project)
			acquired, release := make(chan struct{}), make(chan struct{})
			run := func(wait bool) error {
				admit := func(p store.TaskPresence, e error) error {
					if e != nil {
						return e
					}
					if !p.Found || p.DeletedAt != nil {
						return model.ErrNotFound
					}
					if wait {
						close(acquired)
						select {
						case <-release:
						case <-ctx.Done():
							return ctx.Err()
						}
					}
					return nil
				}
				switch kind {
				case "session", "session_registration":
					_, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
						var e error
						if kind == "session_registration" {
							_, e = scope.SessionDAO().LockTaskRegistration(ctx, project, task)
						} else {
							_, e = scope.SessionDAO().LockTask(ctx, project, task)
						}
						return admit(store.TaskPresence{Found: e == nil}, e)
					})
					return err
				case "steps":
					_, err := db.WriteProject(ctx, project, func(scope store.ProjectWriteScope) error {
						header, e := scope.TaskDAO().TaskHeader(ctx, task)
						return admit(store.TaskPresence{Found: e == nil, DeletedAt: header.DeletedAt}, e)
					})
					return err
				case "thread":
					_, err := db.WriteThread(ctx, func(scope store.ThreadScope) error {
						p, e := scope.TaskDAO().LockTaskPresence(ctx, project, task)
						if e = admit(p, e); e != nil {
							return e
						}
						if _, e = scope.CredentialDAO().Credential(ctx, principal); e != nil {
							return e
						}
						if _, e = scope.ProjectDAO().LockProjectAuthorization(ctx, principal, project); e != nil {
							return e
						}
						head, e := scope.ThreadDAO().LockHead(ctx, task)
						if e != nil {
							return e
						}
						message, e := scope.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: task, Author: model.ThreadAuthor{UserID: user}, Body: "resource write"})
						if e != nil {
							return e
						}
						if e = scope.ThreadDAO().PrepareTimestamp(ctx, &message, head); e != nil {
							return e
						}
						return scope.ThreadDAO().AdvanceHead(ctx, task, message.Position())
					})
					return err
				case "attachment":
					_, err := db.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
						p, e := scope.LockTaskPresence(ctx, project, task)
						if e = admit(p, e); e != nil {
							return e
						}
						if _, e = scope.ProjectAuthorization(ctx, principal, project); e != nil {
							return e
						}
						_, _, e = scope.AttachmentDAO().PutAttachment(ctx, model.Attachment{ProjectID: project, TaskID: task, Path: "resource.txt", ContentType: "text/plain", SizeBytes: 1})
						return e
					})
					return err
				default:
					_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
						var e error
						if kind == "transfer" {
							e = d.Authorize(ctx, principal, "pat", pat, project, task)
						} else {
							e = d.LockProjectLifecycle(ctx, project, task)
						}
						if e != nil {
							return e
						}
						if wait {
							close(acquired)
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
						}
						return nil
					})
					return err
				}
			}
			result := make(chan error, 1)
			go func() { result <- run(true) }()
			select {
			case <-acquired:
			case err := <-result:
				t.Fatalf("resource admission: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			deleted := make(chan error, 1)
			go func() {
				_, err := db.Pool.Exec(ctx, `WITH stamp AS (UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1 RETURNING deleted_at) UPDATE tasks SET ancestor_deleted_at=stamp.deleted_at FROM stamp WHERE id=$2`, goal, task)
				deleted <- err
			}()
			testutil.WaitForQueryLock(t, db.Pool, `WITH stamp AS (UPDATE tasks SET deleted_at=statement_timestamp()`)
			close(release)
			if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
				t.Fatalf("resource commit: %v", err)
			}
			if err := testutil.ReceiveQueryResult(t, ctx, deleted); err != nil {
				t.Fatalf("goal deletion: %v", err)
			}
			if err := run(false); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("deleted parent admission: %v", err)
			}
			var count int
			switch kind {
			case "thread":
				if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, task).Scan(&count); err != nil || count != 1 {
					t.Fatal(fmt.Errorf("thread count=%d: %w", count, err))
				}
			case "attachment":
				if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE task_id=$1 AND path='resource.txt'`, task).Scan(&count); err != nil || count != 1 {
					t.Fatal(fmt.Errorf("attachment count=%d: %w", count, err))
				}
			}
		})
	}
}

func TestInheritedHiddenTaskRetainsArchiveFinalizationGate(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	project, task := uuid.NewString(), uuid.NewString()
	if _, err := db.CreateProject(t.Context(), project, "Archive finalization", "https://example.test/archive"); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, db.Pool, `INSERT INTO tasks(id,project_id,type,title,status,ancestor_deleted_at) VALUES($1,$2,'task','Hidden','done',statement_timestamp())`, task, project)
	completion, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		state, deleted, e := scope.SessionDAO().LockArchiveTask(t.Context(), project, task)
		if e != nil {
			return e
		}
		if !deleted || !state.Deleted || state.Type != model.TaskTypeTask || state.Status != string(model.TaskDone) {
			return fmt.Errorf("archive finalization facts: %+v deleted=%v", state, deleted)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("archive finalization gate: %+v %v", completion, err)
	}
}

func TestProjectDeletionWaitsForGoalChildAttachment(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	project, goal, task := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := db.CreateProject(ctx, project, "Goal attachment", "https://example.test/goal"); err != nil {
		t.Fatal(err)
	}
	var user string
	if err := db.Pool.QueryRow(ctx, `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1`, project).Scan(&user); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, db.Pool, `INSERT INTO tasks(id,project_id,type,title,parent_id) VALUES($1,$3,'goal','Goal',NULL),($2,$3,'task','Child',$1)`, goal, task, project)
	principal := model.Principal{UserID: user}
	acquired, release := make(chan struct{}), make(chan struct{})
	write := func(wait bool, path string) error {
		_, err := db.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
			p, e := scope.LockTaskPresence(ctx, project, task)
			if e != nil {
				return e
			}
			if !p.Found || p.DeletedAt != nil {
				return model.ErrNotFound
			}
			if _, e = scope.ProjectAuthorization(ctx, principal, project); e != nil {
				return e
			}
			if wait {
				close(acquired)
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			_, _, e = scope.AttachmentDAO().PutAttachment(ctx, model.Attachment{ProjectID: project, TaskID: task, Path: path, ContentType: "text/plain", SizeBytes: 1})
			return e
		})
		return err
	}
	written := make(chan error, 1)
	go func() { written <- write(true, "before.txt") }()
	select {
	case <-acquired:
	case err := <-written:
		t.Fatalf("resource admission: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	deleted := make(chan error, 1)
	go func() {
		_, err := db.WriteProjectDeletion(ctx, project, func(scope store.ProjectDeletionScope) error {
			marked, e := scope.ProjectDAO().MarkDeleted(ctx)
			if e == nil && !marked {
				return errors.New("project was not marked deleted")
			}
			return e
		})
		deleted <- err
	}()
	testutil.WaitForQueryLock(t, db.Pool, `WITH goals AS (SELECT id FROM tasks WHERE project_id=`)
	close(release)
	if err := testutil.ReceiveQueryResult(t, ctx, written); err != nil {
		t.Fatalf("attachment commit: %v", err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, deleted); err != nil {
		t.Fatalf("project deletion: %v", err)
	}
	if err := write(false, "after.txt"); err == nil {
		t.Fatal("deleted project accepted attachment")
	}
	var before, after int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE path='before.txt'),count(*) FILTER (WHERE path='after.txt') FROM task_attachments WHERE task_id=$1`, task).Scan(&before, &after); err != nil || before != 1 || after != 0 {
		t.Fatalf("attachment counts before=%d after=%d err=%v", before, after, err)
	}
}

func TestWorkerClaimWithGoalAndTaskEdges(t *testing.T) {
	db, principal, _, project := membershipFixture(t)
	ctx := t.Context()
	goal, prerequisite := uuid.NewString(), uuid.NewString()
	child, blocked, taskPrerequisite := uuid.NewString(), uuid.NewString(), uuid.NewString()
	edgeID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES
 ($1,$3,'goal','Owner goal','todo'),($2,$3,'goal','Pending prerequisite','todo')`, goal, prerequisite, project.ID)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status,parent_id,assigned_to,allow_agents) VALUES
 ($1,$4,'task','Ready child','todo',$5,$6,true),
 ($2,$4,'task','Blocked child','todo',$5,$6,true),
 ($3,$4,'task','Task prerequisite','todo',$5,$6,false)`, child, blocked, taskPrerequisite, project.ID, goal, principal.UserID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES
 ($1,$2,$3,'goal',$4)`, project.ID, goal, prerequisite, edgeID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, blocked, taskPrerequisite)
	workerID := uuid.NewString()
	testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
	tasks := taskservice.NewTasks(db)
	beforeGoal := snapshotTask(t, db, project.ID, goal)
	if len(beforeGoal.DependsOn) != 0 || len(beforeGoal.BlockedBy) != 0 || beforeGoal.Ready {
		t.Fatalf("ordinary Goal projection exposed its Goal edge: %+v", beforeGoal)
	}
	ready, allowed := true, true
	page, err := tasks.List(ctx, principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}, AutomaticCandidate: true, CandidateWorkerID: &workerID, Ready: &ready, AllowAgents: &allowed, AssignedTo: &principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != child || !page.Items[0].Ready {
		t.Fatalf("mixed edges changed Worker candidates: %+v", page)
	}
	candidate := page.Items[0]
	blockedView := snapshotTask(t, db, project.ID, blocked)
	if blockedView.Ready || !reflect.DeepEqual(blockedView.BlockedBy, []string{taskPrerequisite}) {
		t.Fatalf("ordinary edge did not block candidate: %+v", blockedView)
	}
	descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
	claimed, err := tasks.ClaimWorker(ctx, principal, project.ID, child, taskcore.ClaimWorker{Version: candidate.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	after := snapshotTask(t, db, project.ID, child)
	worker, err := taskproperty.Worker(after.Properties)
	if err != nil || worker == nil || worker.ClaimID != descriptor.ClaimID || worker.WorkerID != descriptor.WorkerID || worker.State != model.WorkerActive || after.Status != model.TaskInProgress || after.Version != candidate.Version+1 || !reflect.DeepEqual(after, claimed) {
		t.Fatalf("claim was not persisted: task=%+v worker=%+v error=%v", after, worker, err)
	}
	afterGoal := snapshotTask(t, db, project.ID, goal)
	if afterGoal.Status != model.TaskInProgress || afterGoal.Version != beforeGoal.Version+1 || afterGoal.StartedAt == nil || len(afterGoal.DependsOn) != 0 {
		t.Fatalf("claim did not start Goal while preserving ordinary projection: before=%+v after=%+v", beforeGoal, afterGoal)
	}
	var goalEdges, taskEdges int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE dependency_type='goal' AND task_id=$2 AND depends_on_task_id=$3 AND goal_edge_id=$6),
 count(*) FILTER(WHERE dependency_type='task' AND task_id=$4 AND depends_on_task_id=$5 AND goal_edge_id IS NULL)
 FROM task_dependencies WHERE project_id=$1`, project.ID, goal, prerequisite, blocked, taskPrerequisite, edgeID).Scan(&goalEdges, &taskEdges); err != nil || goalEdges != 1 || taskEdges != 1 {
		t.Fatalf("claim changed existing edges: goal=%d task=%d error=%v", goalEdges, taskEdges, err)
	}
}
