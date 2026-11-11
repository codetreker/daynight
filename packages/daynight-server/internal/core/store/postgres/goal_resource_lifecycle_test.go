package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestGoalDeletionWaitsForResourceWrites(t *testing.T) {
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
	testutil.MustExec(t, db.Pool, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'resource test',now())`, pat, user, make([]byte, 32))
	principal := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: pat}

	for _, kind := range []string{"thread", "attachment", "transfer", "transfer_lifecycle"} {
		t.Run(kind, func(t *testing.T) {
			testutil.MustExec(t, db.Pool, `UPDATE tasks SET deleted_at=NULL WHERE id=$1`, goal)
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
				_, err := db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, goal)
				deleted <- err
			}()
			testutil.WaitForQueryLock(t, db.Pool, `UPDATE tasks SET deleted_at=now() WHERE id=`)
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

func TestProjectDeletionWaitsForGoalChildAttachment(t *testing.T) {
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
	testutil.WaitForQueryLock(t, db.Pool, `SELECT id FROM tasks WHERE project_id=`)
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
