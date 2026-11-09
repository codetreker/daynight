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
}
