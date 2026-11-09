package prompt_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/prompt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func rollbackPromptTest(t *testing.T, tx pgx.Tx) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback prompt test transaction: %v", err)
		}
	})
}

func TestDAORejectsStoredNonpositiveRevision(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user, id := uuid.NewString(), uuid.NewString()
	for _, revision := range []int64{0, -1} {
		_, err = db.Pool.Exec(ctx, `INSERT INTO worker_prompts(user_id,scope,scope_id,revision,prompt_text,updated_at) VALUES($1,'project',$2,$3,'hidden',now()) ON CONFLICT (user_id,scope,scope_id) DO UPDATE SET revision=EXCLUDED.revision`, user, id, revision)
		if err != nil {
			t.Fatal(err)
		}
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		rollbackPromptTest(t, tx)
		dao := prompt.NewDAO(tx)
		_, err = dao.PromptMetadata(ctx, user, model.PromptScopeProject, id)
		var failure *store.Error
		if !errors.As(err, &failure) || !failure.DatabaseFailure {
			t.Fatalf("metadata revision %d: %v", revision, err)
		}
		_, err = dao.PromptResource(ctx, user, model.PromptScopeProject, id)
		if !errors.As(err, &failure) || !failure.DatabaseFailure {
			t.Fatalf("resource revision %d: %v", revision, err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDAOPromptKeysAndConditionalWrites(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user, id, other := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackPromptTest(t, tx)
	dao := prompt.NewDAO(tx)
	empty, err := dao.PromptMetadata(ctx, user, model.PromptScopeProject, id)
	if err != nil || empty.Revision != 0 {
		t.Fatalf("missing: %+v %v", empty, err)
	}
	created, err := dao.CreatePrompt(ctx, user, model.PromptScopeProject, id, "first")
	if err != nil || created.Revision != "1" {
		t.Fatalf("create: %+v %v", created, err)
	}
	metadata, err := dao.PromptMetadata(ctx, user, model.PromptScopeProject, id)
	if err != nil || metadata.Revision != 1 || metadata.UpdatedAt == nil || metadata.UpdatedAt.Location() != time.UTC || !metadata.UpdatedAt.Equal(*created.UpdatedAt) {
		t.Fatalf("metadata time: %+v %v", metadata, err)
	}
	text, err := dao.PromptText(ctx, user, model.PromptScopeProject, id)
	if err != nil || text != "first" {
		t.Fatalf("text: %q %v", text, err)
	}
	if _, err = dao.PromptText(ctx, other, model.PromptScopeProject, id); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing text: %v", err)
	}
	virtual, err := dao.PromptResource(ctx, other, model.PromptScopeProject, id)
	if err != nil || virtual.Revision != "0" || virtual.Text != "" || virtual.UpdatedAt != nil {
		t.Fatalf("virtual: %+v %v", virtual, err)
	}
	_, err = dao.CreatePrompt(ctx, user, model.PromptScopeProject, id, "duplicate")
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("duplicate: %v", err)
	}
	_, err = dao.UpdatePrompt(ctx, user, model.PromptScopeProject, id, 2, 7, "stale")
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale: %v", err)
	}
	updated, err := dao.UpdatePrompt(ctx, user, model.PromptScopeProject, id, 2, 1, "")
	if err != nil || updated.Revision != "2" || updated.Text != "" {
		t.Fatalf("clear: %+v %v", updated, err)
	}
	isolated, err := dao.PromptMetadata(ctx, other, model.PromptScopeProject, id)
	if err != nil || isolated.Revision != 0 {
		t.Fatalf("owner isolation: %+v %v", isolated, err)
	}
	resource, err := dao.PromptResource(ctx, user, model.PromptScopeProject, id)
	if err != nil || !reflect.DeepEqual(resource, updated) {
		t.Fatalf("read: %+v %v", resource, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for name, operation := range map[string]func() error{
		"metadata": func() error { _, err := dao.PromptMetadata(ctx, user, model.PromptScopeProject, id); return err },
		"text":     func() error { _, err := dao.PromptText(ctx, user, model.PromptScopeProject, id); return err },
		"resource": func() error { _, err := dao.PromptResource(ctx, user, model.PromptScopeProject, id); return err },
		"create":   func() error { _, err := dao.CreatePrompt(ctx, user, model.PromptScopeProject, id, "x"); return err },
		"update": func() error {
			_, err := dao.UpdatePrompt(ctx, user, model.PromptScopeProject, id, 2, 1, "x")
			return err
		},
	} {
		if err := operation(); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Errorf("%s on closed transaction: %v", name, err)
		}
	}
}

func TestDAOWorkerExistenceUsesOwnerAndNotRecency(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner, other, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err = db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now()-interval '1 year',now()-interval '1 year','{}','{}')`, owner, id)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackPromptTest(t, tx)
	dao := prompt.NewDAO(tx)
	if err = dao.PromptWorkerExists(ctx, owner, id); err != nil {
		t.Fatalf("own offline worker: %v", err)
	}
	for _, key := range [][2]string{{other, id}, {owner, uuid.NewString()}} {
		if err = dao.PromptWorkerExists(ctx, key[0], key[1]); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing worker %v: %v", key, err)
		}
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = dao.PromptWorkerExists(ctx, owner, id); err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("closed transaction mistaken for absent worker: %v", err)
	}
}
