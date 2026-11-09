package postgres

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestPromptCASAndSnapshot(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	user, id := uuid.NewString(), uuid.NewString()
	write := func(text string, expected int64) error {
		_, err := NewPrompt(db.Pool).WritePrompt(ctx, func(tx PromptWriteScope) error {
			if expected == 0 {
				_, err := tx.CreatePrompt(ctx, user, model.PromptScopeProject, id, text)
				return err
			}
			_, err := tx.UpdatePrompt(ctx, user, model.PromptScopeProject, id, expected+1, expected, text)
			return err
		})
		return err
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, text := range []string{"one", "two"} {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- write(text, 0) }()
	}
	wg.Wait()
	close(errs)
	wins, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			wins++
			continue
		}
		var fault *model.Fault
		if errors.As(err, &fault) && fault.Code == "version_conflict" {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("create outcomes %d %d", wins, conflicts)
	}
	err := NewPrompt(db.Pool).ReadPromptSnapshot(ctx, func(s PromptSnapshot) error {
		m, err := s.PromptMetadata(ctx, user, model.PromptScopeProject, id)
		if err != nil {
			return err
		}
		if m.Revision != 1 {
			t.Fatalf("revision: %+v", m)
		}
		before, err := s.PromptText(ctx, user, model.PromptScopeProject, id)
		if err != nil {
			return err
		}
		if err := write("new", 1); err != nil {
			return err
		}
		after, err := s.PromptText(ctx, user, model.PromptScopeProject, id)
		if before != after {
			t.Fatalf("snapshot changed %q to %q", before, after)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := write("stale", 1); err == nil {
		t.Fatal("stale update succeeded")
	}
	if err := write("", 2); err != nil {
		t.Fatal(err)
	}
	if err := write("again", 3); err != nil {
		t.Fatal(err)
	}
	err = NewPrompt(db.Pool).ReadPromptSnapshot(ctx, func(s PromptSnapshot) error {
		m, e := s.PromptMetadata(ctx, user, model.PromptScopeProject, id)
		if m.Revision != 4 {
			t.Fatalf("ABA revision: %+v", m)
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	updates := make(chan error, 2)
	for _, text := range []string{"winner-a", "winner-b"} {
		wg.Add(1)
		go func() { defer wg.Done(); updates <- write(text, 4) }()
	}
	wg.Wait()
	close(updates)
	wins, conflicts = 0, 0
	for err := range updates {
		if err == nil {
			wins++
			continue
		}
		var f *model.Fault
		if errors.As(err, &f) && f.Code == "version_conflict" {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("update outcomes %d %d", wins, conflicts)
	}
}
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
