package tag_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCatalogPersistenceAndQueries(t *testing.T) {
	ctx := t.Context()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	projectID, other := uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES ($1,'P','r'),($2,'Q','r')`, projectID, other); err != nil {
		t.Fatal(err)
	}
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	observed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	completion, err := db.WriteProject(ctx, projectID, func(scope store.ProjectWriteScope) error {
		for i, name := range []string{"A_1", "a%2", "中", "z"} {
			item, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: ids[i], Name: name, NameKey: name, CreatedAt: observed})
			if err != nil {
				return err
			}
			if item.ProjectID != projectID || item.Version != 1 || !item.CreatedAt.Equal(observed) || !item.UpdatedAt.Equal(observed) {
				t.Fatalf("insert: %+v", item)
			}
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("insert completion: %+v %v", completion, err)
	}
	// The same name is independent across Projects; the name key is unique within one Project.
	completion, err = db.WriteProject(ctx, other, func(scope store.ProjectWriteScope) error {
		_, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: uuid.NewString(), Name: "A_1", NameKey: "A_1", CreatedAt: observed})
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("other project: %+v %v", completion, err)
	}
	completion, err = db.WriteProject(ctx, projectID, func(scope store.ProjectWriteScope) error {
		_, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: uuid.NewString(), Name: "duplicate", NameKey: "A_1", CreatedAt: observed})
		return err
	})
	failed, state := store.DatabaseErrorFacts(err)
	if !failed || state != "23505" || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("unique: %+v %v %q", completion, err, state)
	}

	err = db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		r := scope.TagDAO()
		page, err := r.Tags(ctx, projectID, store.TagQuery{Limit: 2})
		if err != nil {
			return err
		}
		if !page.HasMore || len(page.Items) != 2 || page.Items[0].ID != ids[0] || page.Items[1].ID != ids[1] {
			t.Fatalf("first page: %+v", page)
		}
		page, err = r.Tags(ctx, projectID, store.TagQuery{Limit: 2, After: &store.TagPosition{NameKey: page.Items[1].NameKey, ID: page.Items[1].ID}})
		if err != nil {
			return err
		}
		if page.HasMore || len(page.Items) != 2 || page.Items[0].ID != ids[3] || page.Items[1].ID != ids[2] {
			t.Fatalf("second page: %+v", page)
		}
		for _, tc := range []struct {
			query string
			id    string
		}{{"_", ids[0]}, {"%", ids[1]}, {"中", ids[2]}} {
			page, err := r.Tags(ctx, projectID, store.TagQuery{Limit: 10, NameContains: tc.query})
			if err != nil {
				return err
			}
			if len(page.Items) != 1 || page.Items[0].ID != tc.id {
				t.Fatalf("literal %q: %+v", tc.query, page)
			}
		}
		resolved, err := r.ResolveTags(ctx, projectID, []string{ids[1], ids[0], uuid.NewString(), ids[1]})
		if err != nil {
			return err
		}
		if len(resolved) != 2 || resolved[0].ID >= resolved[1].ID {
			t.Fatalf("resolve: %+v", resolved)
		}
		_, err = r.Tag(ctx, other, ids[0])
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("cross project lookup: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	completion, err = db.WriteProject(ctx, projectID, func(scope store.ProjectWriteScope) error {
		resolved, err := scope.TagDAO().ResolveTags(ctx, []string{ids[1], ids[0]})
		if err != nil {
			return err
		}
		if len(resolved) != 2 || resolved[0].ID >= resolved[1].ID {
			t.Fatalf("write-scope resolve: %+v", resolved)
		}
		usage, err := scope.TagDAO().TagUsage(ctx, ids[0])
		if err != nil {
			return err
		}
		if usage != (model.TagUsage{}) {
			t.Fatalf("write-scope usage: %+v", usage)
		}
		_, err = scope.TagDAO().UpdateTag(ctx, ids[0], 2, "bad", "bad", observed)
		if !errors.Is(err, store.ErrTagWriteConflict) {
			t.Fatalf("stale update: %v", err)
		}
		if err := scope.TagDAO().DeleteTag(ctx, ids[0], 2); !errors.Is(err, store.ErrTagWriteConflict) {
			t.Fatalf("stale delete: %v", err)
		}
		updated, err := scope.TagDAO().UpdateTag(ctx, ids[0], 1, "Renamed", "renamed", observed.Add(time.Second))
		if err != nil {
			return err
		}
		if updated.Version != 2 || updated.Name != "Renamed" || !updated.UpdatedAt.Equal(observed.Add(time.Second)) {
			t.Fatalf("updated: %+v", updated)
		}
		return scope.TagDAO().DeleteTag(ctx, ids[3], 1)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("update/delete: %+v %v", completion, err)
	}
	err = db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		item, err := scope.TagDAO().Tag(ctx, projectID, ids[0])
		if err != nil {
			return err
		}
		if item.Name != "Renamed" || item.Version != 2 {
			t.Fatalf("persisted: %+v", item)
		}
		_, err = scope.TagDAO().Tag(ctx, projectID, ids[3])
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestUsageCountsEffectiveVisibilityAndEpoch(t *testing.T) {
	ctx := t.Context()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	projectID, tagID := uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES ($1,'P','r')`, projectID); err != nil {
		t.Fatal(err)
	}
	goal, deletedGoal, done, cancelled, child, deleted := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err = db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,type,status,parent_id,deleted_at,cancelled_at) VALUES
		($2,$1,'goal','goal','todo',NULL,NULL,NULL),($3,$1,'deleted goal','goal','todo',NULL,now(),NULL),
		($4,$1,'done','task','done',NULL,NULL,NULL),($5,$1,'cancelled','task','cancelled',NULL,NULL,now()),
		($6,$1,'child','task','todo',$3,NULL,NULL),($7,$1,'deleted','task','todo',NULL,now(),NULL)`, projectID, goal, deletedGoal, done, cancelled, child, deleted)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES ($1,$2,'name','name',now(),now())`, tagID, projectID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO task_tags(project_id,task_id,tag_id) SELECT $1,id,$2 FROM tasks WHERE project_id=$1`, projectID, tagID)
	if err != nil {
		t.Fatal(err)
	}
	var before, after struct {
		Epoch, Cache string
		Version      int32
		Updated      time.Time
	}
	read := func(value *struct {
		Epoch, Cache string
		Version      int32
		Updated      time.Time
	}) {
		t.Helper()
		if err := db.Pool.QueryRow(ctx, `SELECT tag_catalog_epoch::text,task_cache_epoch::text,settings_version,updated_at FROM projects WHERE id=$1`, projectID).Scan(&value.Epoch, &value.Cache, &value.Version, &value.Updated); err != nil {
			t.Fatal(err)
		}
	}
	read(&before)
	err = db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		epoch, err := scope.TagDAO().TagCatalogEpoch(ctx, projectID)
		if err != nil {
			return err
		}
		if epoch != before.Epoch {
			t.Fatal("wrong epoch")
		}
		usage, err := scope.TagDAO().TagUsage(ctx, projectID, tagID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(usage, model.TagUsage{Tasks: 2, Goals: 1}) {
			t.Fatalf("usage: %+v", usage)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	completion, err := db.WriteProject(ctx, projectID, func(scope store.ProjectWriteScope) error {
		usage, err := scope.TagDAO().TagUsage(ctx, tagID)
		if err != nil {
			return err
		}
		if usage != (model.TagUsage{Tasks: 2, Goals: 1}) {
			t.Fatalf("write-scope usage: %+v", usage)
		}
		return scope.ProjectDAO().RotateTagCatalogEpoch(ctx)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("rotate: %+v %v", completion, err)
	}
	read(&after)
	if before.Epoch == after.Epoch || before.Cache != after.Cache || before.Version != after.Version || !before.Updated.Equal(after.Updated) {
		t.Fatalf("metadata changed: %+v %+v", before, after)
	}
}

func TestDAOErrorsRetainCauses(t *testing.T) {
	ctx := t.Context()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r, w := tag.NewReader(tx), tag.NewWriter(tx, uuid.NewString())
	if _, err = r.Tags(ctx, uuid.NewString(), store.TagQuery{}); err == nil {
		t.Fatal("invalid limit accepted")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = r.Tags(cancelled, uuid.NewString(), store.TagQuery{Limit: 1}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if err = tx.Rollback(context.Background()); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatal(err)
	}
	if _, err = r.TagCatalogEpoch(ctx, uuid.NewString()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed epoch: %v", err)
	}
	if _, err = r.Tag(ctx, uuid.NewString(), uuid.NewString()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed tag: %v", err)
	}
	if _, err = r.TagUsage(ctx, uuid.NewString(), uuid.NewString()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed usage: %v", err)
	}
	if _, err = r.ResolveTags(ctx, uuid.NewString(), nil); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed resolve: %v", err)
	}
	if _, err = w.InsertTag(ctx, model.Tag{}); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed insert: %v", err)
	}
	if _, err = w.UpdateTag(ctx, uuid.NewString(), 1, "a", "a", time.Now()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed update: %v", err)
	}
	if err = w.DeleteTag(ctx, uuid.NewString(), 1); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed delete: %v", err)
	}
}
