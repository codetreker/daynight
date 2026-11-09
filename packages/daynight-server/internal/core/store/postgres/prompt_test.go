package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestPromptMigrationSchema(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	rows, err := db.Pool.Query(ctx, `SELECT attname,format_type(atttypid,atttypmod),attnotnull FROM pg_attribute WHERE attrelid='worker_prompts'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`)
	if err != nil {
		t.Fatal(err)
	}
	type column struct {
		name, typ string
		notNull   bool
	}
	var got []column
	for rows.Next() {
		var c column
		if err := rows.Scan(&c.name, &c.typ, &c.notNull); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	want := []column{{"user_id", "uuid", true}, {"scope", "text", true}, {"scope_id", "uuid", true}, {"revision", "bigint", true}, {"prompt_text", "text", true}, {"updated_at", "timestamp with time zone", true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("columns: %#v", got)
	}
	var primary string
	err = db.Pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='worker_prompts'::regclass AND contype='p'`).Scan(&primary)
	if err != nil || primary != "PRIMARY KEY (user_id, scope, scope_id)" {
		t.Fatalf("primary key %q %v", primary, err)
	}
	var count int
	err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM worker_prompts`).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("new table rows %d %v", count, err)
	}
}

func TestPromptStoreWriteCompletionAndSnapshot(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	user, id := uuid.NewString(), uuid.NewString()
	completion, err := db.WritePrompt(ctx, func(tx PromptWriteScope) error {
		_, err := tx.CreatePrompt(ctx, user, model.PromptScopeProject, id, "saved")
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit: %+v %v", completion, err)
	}
	read := func(scope PromptSnapshot, revision int64, expected string) error {
		metadata, err := scope.PromptMetadata(ctx, user, model.PromptScopeProject, id)
		if err != nil {
			return err
		}
		text, err := scope.PromptText(ctx, user, model.PromptScopeProject, id)
		if err != nil {
			return err
		}
		if metadata.Revision != revision || text != expected {
			mismatch := fmt.Errorf("snapshot revision/text = %d/%q, want %d/%q", metadata.Revision, text, revision, expected)
			t.Error(mismatch)
			return mismatch
		}
		return nil
	}
	err = NewPrompt(db.Pool).ReadPromptSnapshot(ctx, func(scope PromptSnapshot) error {
		if err := read(scope, 1, "saved"); err != nil {
			return err
		}
		completion, err := db.WritePrompt(ctx, func(tx PromptWriteScope) error {
			_, err := tx.UpdatePrompt(ctx, user, model.PromptScopeProject, id, 2, 1, "new")
			return err
		})
		if err != nil {
			return err
		}
		if completion.Outcome != TransactionCommitted {
			return fmt.Errorf("interleaved update did not commit: %+v", completion)
		}
		return read(scope, 1, "saved")
	})
	if err != nil {
		t.Fatal(err)
	}
	check := func() {
		t.Helper()
		if err := db.ReadPromptSnapshot(ctx, func(scope PromptSnapshot) error { return read(scope, 2, "new") }); err != nil {
			t.Fatal(err)
		}
	}
	check()
	refusal := errors.New("cancel proposed update")
	completion, err = db.WritePrompt(ctx, func(tx PromptWriteScope) error {
		if _, err := tx.UpdatePrompt(ctx, user, model.PromptScopeProject, id, 3, 2, "rolled back"); err != nil {
			return err
		}
		return refusal
	})
	if completion.Outcome != TransactionNotCommitted || !errors.Is(err, refusal) {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	check()
	cancelled, cancelNow := context.WithCancel(ctx)
	cancelNow()
	called := false
	completion, err = db.WritePrompt(cancelled, func(PromptWriteScope) error { called = true; return nil })
	if completion.Outcome != TransactionNotCommitted || !errors.Is(err, context.Canceled) || called {
		t.Fatalf("cancelled begin: %+v %v called %v", completion, err, called)
	}
}
