package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type attachmentWitness struct {
	database                  *Store
	project, task, user, team string
}

func attachmentWitnessFixture(t *testing.T) attachmentWitness {
	t.Helper()
	f := attachmentWitness{database: isolatedStore(t), project: uuid.NewString(), task: uuid.NewString(), user: uuid.NewString(), team: uuid.NewString()}
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, []any{f.user, f.user}},
		{`INSERT INTO teams(id,name) VALUES($1,'attachment witness')`, []any{f.team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{f.team, f.user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'attachment witness','example')`, []any{f.project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{f.project, f.team}},
		{`INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'attachment witness')`, []any{f.task, f.project}},
	} {
		mustQueryExec(t, f.database, query.sql, query.args...)
	}
	return f
}

func (f attachmentWitness) metadata(content string) model.Attachment {
	return model.Attachment{ProjectID: f.project, TaskID: f.task, Path: "file", ContentType: "text/plain; charset=utf-8", SizeBytes: int64(len(content))}
}

func attachmentWitnessAsync(t *testing.T, ctx context.Context, operation func() error) <-chan error {
	t.Helper()
	result, done := make(chan error, 1), make(chan struct{})
	go func() { defer close(done); result <- operation() }()
	t.Cleanup(func() {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("attachment witness operation did not drain")
		}
	})
	return result
}

func attachmentWitnessResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return ctx.Err()
	}
}

func attachmentWitnessPause(t *testing.T) (<-chan struct{}, func()) {
	t.Helper()
	release := make(chan struct{})
	var once sync.Once
	return release, func() { once.Do(func() { close(release) }) }
}

func attachmentWitnessWait(t *testing.T, ctx context.Context, reached <-chan struct{}) {
	t.Helper()
	select {
	case <-reached:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func attachmentWitnessPID(t *testing.T, ctx context.Context, database *Store) int32 {
	t.Helper()
	var pid int32
	err := database.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%FOR SHARE%' LIMIT 1),0)`).Scan(&pid)
	if err != nil || pid == 0 {
		t.Fatalf("attachment lifecycle transaction not found: %d %v", pid, err)
	}
	return pid
}

func attachmentWitnessBlocked(t *testing.T, ctx context.Context, database *Store, blocker int32) {
	t.Helper()
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		err := database.Pool.QueryRow(bounded, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&waiting)
		if err != nil {
			t.Fatalf("observe attachment lifecycle lock: %v", err)
		}
		if waiting {
			return
		}
		select {
		case <-ticker.C:
		case <-bounded.Done():
			t.Fatalf("no waiter blocked by attachment lifecycle transaction %d: %v", blocker, bounded.Err())
		}
	}
}

func attachmentWitnessDelete(ctx context.Context, f attachmentWitness, project bool, paused func() error) error {
	var completion store.Completion
	var err error
	if project {
		completion, err = f.database.WriteProjectDeletion(ctx, f.project, func(scope store.ProjectDeletionScope) error {
			changed, err := scope.ProjectDAO().MarkDeleted(ctx)
			if err != nil {
				return err
			}
			if !changed {
				return errors.New("project was not marked deleted")
			}
			return paused()
		})
	} else {
		completion, err = f.database.WriteProject(ctx, f.project, func(scope store.ProjectWriteScope) error {
			if _, err := scope.TaskDAO().DeleteTask(ctx, f.task, false); err != nil {
				return err
			}
			return paused()
		})
	}
	if err == nil && completion.Outcome != store.TransactionCommitted {
		return fmt.Errorf("deletion completion: %s", completion.Outcome)
	}
	return err
}

func TestAttachmentLifecycleBlocksTaskAndProjectDeletion(t *testing.T) {
	for _, project := range []bool{false, true} {
		t.Run(fmt.Sprintf("project=%t", project), func(t *testing.T) {
			f := attachmentWitnessFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			reached := make(chan struct{})
			release, resume := attachmentWitnessPause(t)
			defer resume()
			mutation := attachmentWitnessAsync(t, ctx, func() error {
				_, err := f.database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
					presence, err := scope.LockTaskPresence(ctx, f.project, f.task)
					if err != nil {
						return err
					}
					if !presence.Found || presence.DeletedAt != nil {
						return fmt.Errorf("live presence: %+v", presence)
					}
					if _, _, err := scope.AttachmentDAO().PutAttachment(ctx, f.metadata("after")); err != nil {
						return err
					}
					close(reached)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				})
				return err
			})
			attachmentWitnessWait(t, ctx, reached)
			// The last statement is a metadata write, so identify the one open callback.
			var blocker int32
			if err := f.database.Pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%task_attachments%'`).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			deletion := attachmentWitnessAsync(t, ctx, func() error { return attachmentWitnessDelete(ctx, f, project, func() error { return nil }) })
			attachmentWitnessBlocked(t, ctx, f.database, blocker)
			if !project {
				otherTask, otherProject, foreignTask := uuid.NewString(), uuid.NewString(), uuid.NewString()
				mustQueryExec(t, f.database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'independent task')`, otherTask, f.project)
				mustQueryExec(t, f.database, `INSERT INTO projects(id,name,repo_url) VALUES($1,'independent project','example')`, otherProject)
				mustQueryExec(t, f.database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'independent project task')`, foreignTask, otherProject)
				for _, address := range [][2]string{{f.project, otherTask}, {otherProject, foreignTask}} {
					_, err := f.database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
						presence, err := scope.LockTaskPresence(ctx, address[0], address[1])
						if err != nil {
							return err
						}
						if !presence.Found {
							return errors.New("independent Task missing")
						}
						_, _, err = scope.AttachmentDAO().PutAttachment(ctx, model.Attachment{ProjectID: address[0], TaskID: address[1], Path: "independent", ContentType: "text/plain", SizeBytes: 2})
						return err
					})
					if err != nil {
						t.Fatalf("independent attachment scope blocked or failed: %v", err)
					}
				}
			}
			resume()
			if err := attachmentWitnessResult(t, ctx, mutation); err != nil {
				t.Fatal(err)
			}
			if err := attachmentWitnessResult(t, ctx, deletion); err != nil {
				t.Fatal(err)
			}
			var size int64
			if err := f.database.Pool.QueryRow(ctx, `SELECT size_bytes FROM task_attachments WHERE task_id=$1 AND path='file'`, f.task).Scan(&size); err != nil || size != 5 {
				t.Fatalf("attachment commit before deletion: %d %v", size, err)
			}
		})
	}
}

func TestAttachmentLifecycleObservesDeletionCommitAndRollback(t *testing.T) {
	for _, test := range []struct {
		name                          string
		project, commits, taskDeleted bool
	}{
		{"task commit", false, true, false}, {"task rollback", false, false, false}, {"project commit", true, true, false}, {"project with deleted Task", true, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := attachmentWitnessFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			before, _, err := f.database.PutAttachment(ctx, f.metadata("before"))
			if err != nil {
				t.Fatal(err)
			}
			if test.taskDeleted {
				mustQueryExec(t, f.database, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, f.task)
			}
			reached := make(chan struct{})
			release, resume := attachmentWitnessPause(t)
			defer resume()
			rollback := errors.New("injected delete rollback")
			deletion := attachmentWitnessAsync(t, ctx, func() error {
				return attachmentWitnessDelete(ctx, f, test.project, func() error {
					close(reached)
					select {
					case <-release:
						if !test.commits {
							return rollback
						}
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				})
			})
			attachmentWitnessWait(t, ctx, reached)
			var deletingPID int32
			if err := f.database.Pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND (query LIKE 'UPDATE tasks%' OR query LIKE 'UPDATE projects%')`).Scan(&deletingPID); err != nil {
				t.Fatal(err)
			}
			mutation := attachmentWitnessAsync(t, ctx, func() error {
				_, err := f.database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
					presence, err := scope.LockTaskPresence(ctx, f.project, f.task)
					if err != nil {
						return err
					}
					wantDeleted := test.taskDeleted || !test.project && test.commits
					if !presence.Found || (presence.DeletedAt != nil) != wantDeleted {
						return fmt.Errorf("presence after deletion: %+v", presence)
					}
					err = scope.ProjectLive(ctx, f.project)
					if test.project && test.commits {
						if !errors.Is(err, model.ErrNotFound) {
							return fmt.Errorf("deleted Project remained live: %v", err)
						}
						return nil
					}
					return err
				})
				return err
			})
			attachmentWitnessBlocked(t, ctx, f.database, deletingPID)
			resume()
			deleteErr := attachmentWitnessResult(t, ctx, deletion)
			if test.commits && deleteErr != nil || !test.commits && !errors.Is(deleteErr, rollback) {
				t.Fatalf("deletion completion: %v", deleteErr)
			}
			if err := attachmentWitnessResult(t, ctx, mutation); err != nil {
				t.Fatal(err)
			}
			err = f.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
				after, err := snapshot.AttachmentDAO().Attachment(ctx, f.project, f.task, "file")
				if err != nil {
					return err
				}
				if after != before {
					return fmt.Errorf("deletion changed attachment metadata: before=%+v after=%+v", before, after)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAttachmentAdmissionDoesNotLockGrantAcrossMutation(t *testing.T) {
	f := attachmentWitnessFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	member := uuid.NewString()
	mustQueryExec(t, f.database, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, member, member)
	mustQueryExec(t, f.database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.project, member)
	principal := model.Principal{UserID: member}
	completion, err := f.database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		if _, err := scope.LockTaskPresence(ctx, f.project, f.task); err != nil {
			return err
		}
		access, err := scope.ProjectAuthorization(ctx, principal, f.project)
		if err != nil {
			return err
		}
		if access.TeamRole != nil {
			return errors.New("fixture has Team authorization")
		}
		if err := scope.ProjectLive(ctx, f.project); err != nil {
			return err
		}
		revokeCtx, stop := context.WithTimeout(ctx, 2*time.Second)
		defer stop()
		revocation, err := f.database.WriteProject(revokeCtx, f.project, func(grants store.ProjectWriteScope) error {
			return grants.ProjectDAO().RemoveMember(revokeCtx, member)
		})
		if err != nil {
			return fmt.Errorf("grant revocation waited for admitted scope: %w", err)
		}
		if revocation.Outcome != store.TransactionCommitted {
			return fmt.Errorf("grant revocation completion: %s", revocation.Outcome)
		}
		if _, _, err := scope.AttachmentDAO().PutAttachment(ctx, f.metadata("before revocation\x00after revocation\xff\n")); err != nil {
			return err
		}
		_, err = scope.ProjectAuthorization(ctx, principal, f.project)
		if !errors.Is(err, model.ErrNotFound) {
			return fmt.Errorf("revoked grant remains authorized: %v", err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("admitted mutation: %+v %v", completion, err)
	}
	var count int
	if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE task_id=$1`, f.task).Scan(&count); err != nil || count != 1 {
		t.Fatalf("admitted mutation did not persist: %d %v", count, err)
	}
}

func TestAttachmentRollbackRetainsExternalFileEffects(t *testing.T) {
	f := attachmentWitnessFixture(t)
	before, _, err := f.database.PutAttachment(t.Context(), f.metadata("before"))
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"put failure", "put canceled", "delete failure", "suppressed delete"} {
		if !t.Run(operation, func(t *testing.T) {
			ctx := t.Context()
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			const bucket, path = "task-attachments", "fixture/file"
			if _, err := files.Put(ctx, bucket, path, strings.NewReader("before")); err != nil {
				t.Fatal(err)
			}
			if operation != "put canceled" {
				action, event := `RAISE EXCEPTION USING ERRCODE='P1001', MESSAGE='attachment metadata failure'`, "INSERT OR UPDATE"
				if operation != "put failure" {
					event = "DELETE"
				}
				if operation == "suppressed delete" {
					action = "RETURN NULL"
				}
				mustQueryExec(t, f.database, `CREATE FUNCTION refuse_attachment_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN `+action+`; END $$; CREATE TRIGGER refuse_attachment_metadata BEFORE `+event+` ON task_attachments FOR EACH ROW EXECUTE FUNCTION refuse_attachment_metadata()`)
			}
			mutationCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			completion, err := f.database.WriteAttachmentMutation(mutationCtx, func(scope store.AttachmentMutationScope) error {
				if _, err := scope.LockTaskPresence(mutationCtx, f.project, f.task); err != nil {
					return err
				}
				if strings.HasPrefix(operation, "put") {
					if _, err := files.Put(mutationCtx, bucket, path, strings.NewReader("after")); err != nil {
						return err
					}
					if operation == "put canceled" {
						cancel()
					}
					_, _, err := scope.AttachmentDAO().PutAttachment(mutationCtx, f.metadata("after"))
					return err
				}
				if err := files.Delete(mutationCtx, bucket, path); err != nil {
					return err
				}
				return scope.AttachmentDAO().DeleteAttachment(mutationCtx, f.project, f.task, "file")
			})
			var transaction *store.TransactionError
			if err == nil || !errors.As(err, &transaction) || completion.Outcome != store.TransactionNotCommitted || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted {
				t.Fatalf("rollback completion: %+v %#v %v", completion, transaction, err)
			}
			if operation == "put canceled" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancel cause lost: %v", err)
				}
			} else if operation == "suppressed delete" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("suppressed delete: %v", err)
				}
			} else {
				var driver *pgconn.PgError
				var databaseError *store.Error
				if !errors.As(err, &driver) || driver.Code != "P1001" || !errors.As(err, &databaseError) {
					t.Fatalf("metadata cause lost: %v", err)
				}
			}
			err = f.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
				after, err := snapshot.AttachmentDAO().Attachment(ctx, f.project, f.task, "file")
				if err != nil {
					return err
				}
				if after != before {
					return fmt.Errorf("rolled back metadata changed: before=%+v after=%+v", before, after)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			object, err := files.Open(ctx, bucket, path)
			if strings.HasPrefix(operation, "put") {
				if err != nil {
					t.Fatal(err)
				}
				content, readErr := io.ReadAll(object.Body)
				if err := errors.Join(readErr, object.Body.Close()); err != nil || string(content) != "after" {
					t.Fatalf("external write was lost: %q %v", content, err)
				}
			} else if !errors.Is(err, fs.ErrNotExist) {
				if err == nil {
					object.Body.Close()
				}
				t.Fatalf("external deletion was lost: %v", err)
			}
			if operation != "put canceled" {
				mustQueryExec(t, f.database, `DROP TRIGGER refuse_attachment_metadata ON task_attachments; DROP FUNCTION refuse_attachment_metadata()`)
				assertFaultTriggerRemoved(t, f.database, "refuse_attachment_metadata", "task_attachments")
			}
		}) {
			return
		}
	}
}

func TestAttachmentGateSurvivesBackendLoss(t *testing.T) {
	f := attachmentWitnessFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	other, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	const bucket, path = "task-attachments", "fixture/file"
	if _, err := files.Put(ctx, bucket, path, strings.NewReader("before")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.database.PutAttachment(ctx, f.metadata("before")); err != nil {
		t.Fatal(err)
	}
	old, err := files.Open(ctx, bucket, path)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Body.Close()
	permit, err := files.AcquireGate(ctx, filestorage.TargetGate, path)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	reached := make(chan struct{})
	release, resume := attachmentWitnessPause(t)
	defer resume()
	written := attachmentWitnessAsync(t, ctx, func() error {
		_, err := f.database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
			if _, err := scope.LockTaskPresence(ctx, f.project, f.task); err != nil {
				return err
			}
			if _, err := files.Put(ctx, bucket, path, strings.NewReader("after")); err != nil {
				return err
			}
			close(reached)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, _, err := scope.AttachmentDAO().PutAttachment(ctx, f.metadata("after"))
			return err
		})
		return err
	})
	attachmentWitnessWait(t, ctx, reached)
	pid := attachmentWitnessPID(t, ctx, f.database)
	if _, err := f.database.Pool.Exec(ctx, `SELECT pg_terminate_backend($1)`, pid); err != nil {
		t.Fatal(err)
	}
	blockedCtx, stop := context.WithTimeout(ctx, 200*time.Millisecond)
	defer stop()
	if passed, err := other.AcquireGate(blockedCtx, filestorage.TargetGate, path); !errors.Is(err, context.DeadlineExceeded) {
		if passed != nil {
			passed.Close()
		}
		t.Fatalf("gate passed live owner after backend loss: %v", err)
	}
	resume()
	if err := attachmentWitnessResult(t, ctx, written); err == nil {
		t.Fatal("metadata write succeeded after backend loss")
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := other.AcquireGate(ctx, filestorage.TargetGate, path)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	_, err = f.database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		if _, err := scope.LockTaskPresence(ctx, f.project, f.task); err != nil {
			return err
		}
		if _, err := other.Put(ctx, bucket, path, strings.NewReader("final")); err != nil {
			return err
		}
		_, _, err := scope.AttachmentDAO().PutAttachment(ctx, f.metadata("final"))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	current, err := other.Open(ctx, bucket, path)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(current.Body)
	if err := errors.Join(readErr, current.Body.Close()); err != nil || string(content) != "final" {
		t.Fatalf("current file: %q %v", content, err)
	}
	original, readErr := io.ReadAll(old.Body)
	if err := errors.Join(readErr, old.Body.Close()); err != nil || string(original) != "before" {
		t.Fatalf("old handle: %q %v", original, err)
	}
	var size int64
	if err := f.database.Pool.QueryRow(ctx, `SELECT size_bytes FROM task_attachments WHERE task_id=$1 AND path='file'`, f.task).Scan(&size); err != nil || size != 5 {
		t.Fatalf("recovered metadata: %d %v", size, err)
	}
}

func TestAttachmentCompletionRetainsCommittedRowsWhenReceiptIsLost(t *testing.T) {
	f := attachmentWitnessFixture(t)
	ctx := t.Context()
	tx, err := f.database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("attachment commit response lost")
	completion, err := transactAttachment(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, func(scope store.AttachmentMutationScope) error {
		_, _, err := scope.AttachmentDAO().PutAttachment(ctx, f.metadata("committed"))
		return err
	})
	var failure *store.TransactionError
	if completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !failure.CommitAttempted || !errors.Is(err, lost) {
		t.Fatalf("lost attachment receipt: %+v %#v %v", completion, failure, err)
	}
	var size int64
	if err := f.database.Pool.QueryRow(ctx, `SELECT size_bytes FROM task_attachments WHERE task_id=$1 AND path='file'`, f.task).Scan(&size); err != nil || size != 9 {
		t.Fatalf("actual attachment commit was lost: %d %v", size, err)
	}
}
