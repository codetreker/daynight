package attachment_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func attachmentFixture(t *testing.T) (*postgres.Store, string, string, model.Principal) {
	t.Helper()
	db := testsupport.TestStore(t)
	ctx := t.Context()
	projectID, taskID, userID, teamID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, []any{userID, userID}},
		{`INSERT INTO teams(id,name) VALUES($1,'attachment fixture')`, []any{teamID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{teamID, userID}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'attachment fixture','example')`, []any{projectID}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{projectID, teamID}},
		{`INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'attachment fixture')`, []any{taskID, projectID}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return db, projectID, taskID, model.Principal{UserID: userID}
}

func attachmentRows(t *testing.T, db *postgres.Store, projectID, taskID string) (string, string) {
	t.Helper()
	var task, attachments string
	err := db.Pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text,
        COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.path) FROM task_attachments a
          WHERE a.project_id=t.project_id AND a.task_id=t.id),'[]'::jsonb)::text
        FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, taskID).Scan(&task, &attachments)
	if err != nil {
		t.Fatal(err)
	}
	return task, attachments
}

func TestMutationDAOLifecycleAndRollback(t *testing.T) {
	db, projectID, taskID, principal := attachmentFixture(t)
	ctx := t.Context()
	taskBefore, _ := attachmentRows(t, db, projectID, taskID)
	writer := db
	result, err := writer.WriteAttachmentMutation(ctx, func(tx store.AttachmentMutationScope) error {
		presence, err := tx.LockTaskPresence(ctx, projectID, taskID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("live task: %+v %v", presence, err)
		}
		access, err := tx.ProjectAuthorization(ctx, principal, projectID)
		if err != nil || access.UserID != principal.UserID || access.Role != model.ProjectAdmin {
			t.Fatalf("authorization: %+v %v", access, err)
		}
		dao := tx.AttachmentDAO()
		for _, path := range []string{"a", "dir/b", "dir/c"} {
			item, created, err := dao.PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: path, ContentType: "text/plain", SizeBytes: 3})
			if err != nil || !created || item.Path != path {
				t.Fatalf("insert %q: %+v %v %v", path, item, created, err)
			}
		}
		updated, created, err := dao.PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "a", ContentType: "text/markdown", SizeBytes: 7})
		if err != nil || created || updated.SizeBytes != 7 {
			t.Fatalf("overwrite: %+v %v %v", updated, created, err)
		}
		read, err := dao.Attachment(ctx, projectID, taskID, "a")
		if err != nil || !reflect.DeepEqual(read, updated) {
			t.Fatalf("read uncommitted: %+v %v", read, err)
		}
		if _, err := dao.Attachment(ctx, projectID, taskID, "missing"); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing read: %v", err)
		} else if failed, _ := store.DatabaseErrorFacts(err); failed {
			t.Fatalf("missing attachment became database failure: %v", err)
		}
		first, err := dao.Attachments(ctx, projectID, taskID, store.AttachmentQuery{Limit: 2})
		if err != nil || len(first.Items) != 2 || !first.HasMore || first.Items[0].Path != "a" || first.Items[1].Path != "dir/b" {
			t.Fatalf("first page: %+v %v", first, err)
		}
		after := first.Items[1].Path
		last, err := dao.Attachments(ctx, projectID, taskID, store.AttachmentQuery{Limit: 2, After: &after})
		if err != nil || len(last.Items) != 1 || last.HasMore || last.Items[0].Path != "dir/c" {
			t.Fatalf("last page: %+v %v", last, err)
		}
		for _, q := range []struct {
			query store.AttachmentConflictQuery
			want  bool
		}{
			{store.AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: "dir/"}, true},
			{store.AttachmentConflictQuery{Ancestors: []string{"a"}, DescendantPrefix: "a/child/"}, true},
			{store.AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: "free/"}, false},
		} {
			got, err := dao.AttachmentPathConflict(ctx, projectID, taskID, q.query)
			if err != nil || got != q.want {
				t.Fatalf("path conflict: %v %v", got, err)
			}
		}
		if err := dao.DeleteAttachment(ctx, projectID, taskID, "dir/c"); err != nil {
			return err
		}
		if err := dao.DeleteAttachment(ctx, projectID, taskID, "dir/c"); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing delete: %v", err)
		}
		var visible int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE task_id=$1`, taskID).Scan(&visible); err != nil || visible != 0 {
			t.Fatalf("uncommitted visible: %d %v", visible, err)
		}
		return nil
	})
	if err != nil || result.Outcome != store.TransactionCommitted {
		t.Fatalf("commit: %+v %v", result, err)
	}
	committedTask, committedAttachments := attachmentRows(t, db, projectID, taskID)
	if committedTask != taskBefore {
		t.Fatalf("attachment commit changed task: before=%s after=%s", taskBefore, committedTask)
	}
	cause := errors.New("reject mutation")
	result, err = writer.WriteAttachmentMutation(ctx, func(tx store.AttachmentMutationScope) error {
		if err := tx.AttachmentDAO().DeleteAttachment(ctx, projectID, taskID, "a"); err != nil {
			return err
		}
		return cause
	})
	if result.Outcome != store.TransactionNotCommitted || !errors.Is(err, cause) {
		t.Fatalf("rollback: %+v %v", result, err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE task_id=$1`, taskID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("committed metadata changed: %d %v", count, err)
	}
	if task, attachments := attachmentRows(t, db, projectID, taskID); task != taskBefore || attachments != committedAttachments {
		t.Fatalf("rollback changed task or attachment rows: task=%s attachments=%s", task, attachments)
	}
}

func TestMutationTaskLockAndFreshAuthorization(t *testing.T) {
	db, projectID, taskID, principal := attachmentFixture(t)
	ctx := t.Context()
	if _, _, err := db.PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "a", ContentType: "text/plain", SizeBytes: 1}); err != nil {
		t.Fatal(err)
	}
	other := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'other')`, other, projectID); err != nil {
		t.Fatal(err)
	}
	writer := db
	completion, err := writer.WriteAttachmentMutation(ctx, func(tx store.AttachmentMutationScope) error {
		presence, err := tx.LockTaskPresence(ctx, projectID, taskID)
		if err != nil || !presence.Found {
			t.Fatalf("lock Task: %+v %v", presence, err)
		}
		var otherID string
		if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM tasks WHERE id=$1 FOR UPDATE NOWAIT`, other).Scan(&otherID); err != nil || otherID != other {
			t.Fatalf("other Task was blocked: %q %v", otherID, err)
		}
		competitor, err := db.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer competitor.Rollback(ctx)
		var id string
		err = competitor.QueryRow(ctx, `SELECT id::text FROM tasks WHERE id=$1 FOR UPDATE NOWAIT`, taskID).Scan(&id)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
			t.Fatalf("expected conflicting lock: %v", err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("lock transaction: %+v %v", completion, err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, taskID); err != nil {
		t.Fatal(err)
	}
	deletedTask, attachmentsBefore := attachmentRows(t, db, projectID, taskID)
	completion, err = writer.WriteAttachmentMutation(ctx, func(tx store.AttachmentMutationScope) error {
		deleted, err := tx.LockTaskPresence(ctx, projectID, taskID)
		if err != nil || !deleted.Found || deleted.DeletedAt == nil {
			t.Fatalf("deleted task: %+v %v", deleted, err)
		}
		missing, err := tx.LockTaskPresence(ctx, projectID, uuid.NewString())
		if err != nil || missing.Found {
			t.Fatalf("missing task: %+v %v", missing, err)
		}
		if _, err := tx.ProjectAuthorization(ctx, principal, projectID); err != nil {
			return err
		}
		_, err = tx.ProjectAuthorization(ctx, model.Principal{UserID: uuid.NewString()}, projectID)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unauthorized project: %v", err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("presence/authorization: %+v %v", completion, err)
	}
	if task, attachments := attachmentRows(t, db, projectID, taskID); task != deletedTask || attachments != attachmentsBefore {
		t.Fatalf("presence or authorization reads changed persisted rows: task=%s attachments=%s", task, attachments)
	}
}

func TestMutationDatabaseFailures(t *testing.T) {
	db, projectID, taskID, _ := attachmentFixture(t)
	ctx := t.Context()
	writer := db
	if _, _, err := db.PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "a", ContentType: "text/plain", SizeBytes: 1}); err != nil {
		t.Fatal(err)
	}
	taskBefore, attachmentsBefore := attachmentRows(t, db, projectID, taskID)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	completion, err := writer.WriteAttachmentMutation(canceled, func(store.AttachmentMutationScope) error { t.Fatal("canceled begin reached callback"); return nil })
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, context.Canceled) {
		t.Fatalf("begin: %+v %v", completion, err)
	}
	if task, attachments := attachmentRows(t, db, projectID, taskID); task != taskBefore || attachments != attachmentsBefore {
		t.Fatalf("canceled begin changed persisted rows: task=%s attachments=%s", task, attachments)
	}
	for _, operation := range []struct {
		name string
		run  func(store.AttachmentMutationScope) error
	}{
		{"read", func(tx store.AttachmentMutationScope) error {
			_, err := tx.AttachmentDAO().Attachment(ctx, projectID, taskID, "a")
			return err
		}},
		{"list", func(tx store.AttachmentMutationScope) error {
			_, err := tx.AttachmentDAO().Attachments(ctx, projectID, taskID, store.AttachmentQuery{Limit: 10})
			return err
		}},
		{"conflict", func(tx store.AttachmentMutationScope) error {
			_, err := tx.AttachmentDAO().AttachmentPathConflict(ctx, projectID, taskID, store.AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: "a/"})
			return err
		}},
		{"put", func(tx store.AttachmentMutationScope) error {
			_, _, err := tx.AttachmentDAO().PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "a", ContentType: "text/plain", SizeBytes: 1})
			return err
		}},
		{"delete", func(tx store.AttachmentMutationScope) error {
			return tx.AttachmentDAO().DeleteAttachment(ctx, projectID, taskID, "a")
		}},
		{"task", func(tx store.AttachmentMutationScope) error {
			_, err := tx.LockTaskPresence(ctx, "invalid", taskID)
			return err
		}},
	} {
		t.Run(operation.name, func(t *testing.T) {
			if operation.name != "task" {
				if _, err := db.Pool.Exec(ctx, `ALTER TABLE task_attachments RENAME TO inaccessible_attachments`); err != nil {
					t.Fatal(err)
				}
				defer func() {
					if _, err := db.Pool.Exec(ctx, `ALTER TABLE inaccessible_attachments RENAME TO task_attachments`); err != nil {
						t.Error(err)
						return
					}
					if task, attachments := attachmentRows(t, db, projectID, taskID); task != taskBefore || attachments != attachmentsBefore {
						t.Errorf("failed mutation changed persisted rows: task=%s attachments=%s", task, attachments)
					}
				}()
			}
			completion, err := writer.WriteAttachmentMutation(ctx, operation.run)
			var dbErr *store.Error
			var pgErr *pgconn.PgError
			failed, _ := store.DatabaseErrorFacts(err)
			if completion.Outcome != store.TransactionNotCommitted || !failed || !errors.As(err, &dbErr) || !errors.As(err, &pgErr) {
				t.Fatalf("failure chain: %+v %v", completion, err)
			}
			if operation.name == "task" {
				if task, attachments := attachmentRows(t, db, projectID, taskID); task != taskBefore || attachments != attachmentsBefore {
					t.Fatalf("failed presence read changed persisted rows: task=%s attachments=%s", task, attachments)
				}
			}
		})
	}
}
