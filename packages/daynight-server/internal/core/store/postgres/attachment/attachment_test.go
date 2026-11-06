package attachment_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func isolatedStore(t *testing.T) *postgres.Store {
	t.Helper()
	database, err := postgres.Open(context.Background(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return database
}

func TestAttachmentStoreUpsertPaginationAndDelete(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	input := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "docs/a.md", ContentType: "text/markdown", SizeBytes: 10}
	first, created, err := database.PutAttachment(ctx, input)
	if err != nil || !created || first.CreatedAt.IsZero() || !first.CreatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("insert: %#v, %v, %v", first, created, err)
	}
	input.SizeBytes = 20
	updated, created, err := database.PutAttachment(ctx, input)
	if err != nil || created || updated.SizeBytes != 20 || !first.CreatedAt.Equal(updated.CreatedAt) || !updated.UpdatedAt.After(first.UpdatedAt) {
		t.Fatalf("update: %#v, %v, %v", updated, created, err)
	}
	input.Path = "docs/b.md"
	if _, _, err := database.PutAttachment(ctx, input); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		attachment, err := snapshot.AttachmentDAO().Attachment(ctx, projectID, taskID, "docs/a.md")
		if err != nil || !reflect.DeepEqual(attachment, updated) {
			t.Fatalf("read: %#v, %v", attachment, err)
		}
		page, err := snapshot.AttachmentDAO().Attachments(ctx, projectID, taskID, AttachmentQuery{Limit: 1})
		if err != nil || len(page.Items) != 1 || !page.HasMore || page.Items[0].Path != "docs/a.md" {
			t.Fatalf("page: %#v, %v", page, err)
		}
		page, err = snapshot.AttachmentDAO().Attachments(ctx, projectID, taskID, AttachmentQuery{Limit: 1, After: &page.Items[0].Path})
		if err != nil || len(page.Items) != 1 || page.HasMore || page.Items[0].Path != "docs/b.md" {
			t.Fatalf("final page: %#v, %v", page, err)
		}
		for _, test := range []struct {
			path      string
			ancestors []string
			conflict  bool
		}{{"docs", []string{}, true}, {"docs/a.md/child", []string{"docs", "docs/a.md"}, true}, {"docs/a.md", []string{"docs"}, false}, {"docs2", []string{}, false}} {
			got, err := snapshot.AttachmentDAO().AttachmentPathConflict(ctx, projectID, taskID, AttachmentConflictQuery{Ancestors: test.ancestors, DescendantPrefix: test.path + "/"})
			if err != nil || got != test.conflict {
				t.Fatalf("prefix %q: %v, %v", test.path, got, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteAttachment(ctx, projectID, taskID, "docs/a.md"); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteAttachment(ctx, projectID, taskID, "docs/a.md"); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing delete: %v", err)
	}
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.AttachmentDAO().Attachment(ctx, projectID, taskID, "docs/a.md")
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing read: %v", err)
	}
}

func TestAttachmentSchemaConstraintsAndStoreFailures(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	input := model.Attachment{ProjectID: uuid.NewString(), TaskID: uuid.NewString(), Path: "file", ContentType: "text/plain", SizeBytes: -1}
	_, _, err := database.PutAttachment(ctx, input)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23514" {
		t.Fatalf("negative size accepted: %v", err)
	}
	if _, err := database.Pool.Exec(ctx, `DROP TABLE task_attachments`); err != nil {
		t.Fatal(err)
	}
	input.SizeBytes = 0
	_, _, err = database.PutAttachment(ctx, input)
	assertAttachmentStoreError(t, err)
	assertAttachmentStoreError(t, database.DeleteAttachment(ctx, input.ProjectID, input.TaskID, input.Path))
	for _, operation := range []func(SnapshotScope) error{
		func(snapshot SnapshotScope) error {
			_, err := snapshot.AttachmentDAO().Attachment(ctx, input.ProjectID, input.TaskID, input.Path)
			return err
		},
		func(snapshot SnapshotScope) error {
			_, err := snapshot.AttachmentDAO().Attachments(ctx, input.ProjectID, input.TaskID, AttachmentQuery{Limit: 1})
			return err
		},
		func(snapshot SnapshotScope) error {
			_, err := snapshot.AttachmentDAO().AttachmentPathConflict(ctx, input.ProjectID, input.TaskID, AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: input.Path + "/"})
			return err
		},
	} {
		assertAttachmentStoreError(t, database.ReadSnapshot(ctx, operation))
	}
}

func assertAttachmentStoreError(t *testing.T, err error) {
	t.Helper()
	var postgresError *pgconn.PgError
	var databaseError *Error
	if !errors.As(err, &postgresError) || postgresError.Code != "42P01" || !errors.As(err, &databaseError) || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing table error lost: %v", err)
	}
}

func TestAttachmentBoundedProjectionPreservesPageBoundary(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	for _, item := range []model.Attachment{
		{ProjectID: projectID, TaskID: taskID, Path: "a", ContentType: "short"},
		{ProjectID: projectID, TaskID: taskID, Path: "b", ContentType: strings.Repeat("x", 1000000)},
		{ProjectID: projectID, TaskID: taskID, Path: "long-path", ContentType: "short"},
	} {
		if _, _, err := db.PutAttachment(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		page, err := snapshot.AttachmentDAO().Attachments(ctx, projectID, taskID, AttachmentQuery{Limit: 2, MaxFieldBytes: 5})
		if err != nil || len(page.Items) != 2 || !page.HasMore || page.Items[0].Path != "a" || page.Items[0].ContentType != "short" || page.Oversized[0] || page.Items[1].Path != "b" || page.Items[1].ContentType != "" || !page.Oversized[1] {
			t.Fatalf("bounded first page: %+v %v", page, err)
		}
		after := page.Items[1].Path
		page, err = snapshot.AttachmentDAO().Attachments(ctx, projectID, taskID, AttachmentQuery{Limit: 2, After: &after, MaxFieldBytes: 5})
		if err != nil || len(page.Items) != 1 || page.Items[0].Path != "" || !page.Oversized[0] {
			t.Fatalf("bounded long path: %+v %v", page, err)
		}
		full, err := snapshot.AttachmentDAO().Attachments(ctx, projectID, taskID, AttachmentQuery{Limit: 2})
		if err != nil || full.Items[1].ContentType != strings.Repeat("x", 1000000) || full.Oversized != nil {
			t.Fatalf("unbounded contract changed: %+v %v", full, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
