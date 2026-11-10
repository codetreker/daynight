package prompt_test

import (
	"context"
	"errors"
	"reflect"
	"strconv"
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

	group := newPromptGroup(t)
	rollback := func(transaction pgx.Tx) error {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		err := transaction.Rollback(cleanup)
		if err == pgx.ErrTxClosed {
			return nil
		}
		return err
	}
	begin := func() pgx.Tx {
		t.Helper()
		transaction, err := db.Pool.Begin(group.ctx)
		if err != nil {
			t.Fatal(err)
		}
		group.after(func() {
			if err := rollback(transaction); err != nil {
				t.Errorf("rollback committed lifecycle transaction: %v", err)
			}
		})
		return transaction
	}
	read := func(want model.PromptResource, revision int64) {
		t.Helper()
		if want.UpdatedAt == nil || want.UpdatedAt.IsZero() || want.UpdatedAt.Location() != time.UTC {
			t.Fatalf("mutation did not return a UTC timestamp: %+v", want)
		}
		transaction := begin()
		reader := prompt.NewDAO(transaction)
		got, err := reader.PromptResource(group.ctx, user, model.PromptScopeProject, id)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("fresh resource: got=%+v want=%+v err=%v", got, want, err)
		}
		metadata, err := reader.PromptMetadata(group.ctx, user, model.PromptScopeProject, id)
		if err != nil || metadata.Revision != revision || metadata.UpdatedAt == nil || !metadata.UpdatedAt.Equal(*want.UpdatedAt) || metadata.UpdatedAt.Location() != time.UTC {
			t.Fatalf("fresh metadata: %+v err=%v", metadata, err)
		}
		text, err := reader.PromptText(group.ctx, user, model.PromptScopeProject, id)
		if err != nil || text != want.Text {
			t.Fatalf("fresh text: got=%q want=%q err=%v", text, want.Text, err)
		}
		if err := rollback(transaction); err != nil {
			t.Fatal(err)
		}
	}
	type outcome struct {
		err     error
		cleanup error
	}
	compete := func(first, second string, revision int64, operation func(*prompt.DAO, string) (model.PromptResource, error)) {
		t.Helper()
		holder := begin()
		winner, err := operation(prompt.NewDAO(holder), first)
		if err != nil {
			t.Fatal(err)
		}
		contender := begin()
		holderPID, contenderPID := holder.Conn().PgConn().PID(), contender.Conn().PgConn().PID()
		if holderPID == contenderPID {
			t.Fatal("competing prompt writes share a physical connection")
		}
		result := make(chan outcome, 1)
		group.start(func() {
			_, err := operation(prompt.NewDAO(contender), second)
			if err == nil {
				err = contender.Commit(group.ctx)
			}
			cleanupErr := rollback(contender)
			if cleanupErr != nil {
				t.Errorf("rollback competing prompt transaction: %v", cleanupErr)
			}
			result <- outcome{err: err, cleanup: cleanupErr}
		})
		testutil.WaitThreadBackendLock(t, db.Pool, contenderPID)
		holderErr := holder.Commit(group.ctx)
		var other outcome
		select {
		case other = <-result:
		case <-group.ctx.Done():
			t.Fatal("competing prompt write did not finish after holder commit")
		}
		if other.cleanup != nil {
			t.Errorf("contender cleanup failed: %v", other.cleanup)
		}
		wins, conflicts := 0, 0
		for _, err := range []error{holderErr, other.err} {
			if err == nil {
				wins++
				continue
			}
			var conflict *model.Fault
			if errors.As(err, &conflict) && conflict.Code == "version_conflict" {
				conflicts++
			} else {
				t.Errorf("competing prompt write failed unexpectedly: %v", err)
			}
		}
		if wins != 1 || conflicts != 1 {
			t.Fatalf("concurrent outcomes: successes=%d conflicts=%d", wins, conflicts)
		}
		if winner.Scope != model.PromptScopeProject || winner.ScopeID != id || winner.Revision != strconv.FormatInt(revision, 10) || winner.Text != first {
			t.Fatalf("winning mutation result: %+v", winner)
		}
		read(winner, revision)
	}
	compete("one", "two", 1, func(dao *prompt.DAO, text string) (model.PromptResource, error) {
		return dao.CreatePrompt(group.ctx, user, model.PromptScopeProject, id, text)
	})
	write := func(next, expected int64, text string) model.PromptResource {
		t.Helper()
		transaction := begin()
		got, err := prompt.NewDAO(transaction).UpdatePrompt(group.ctx, user, model.PromptScopeProject, id, next, expected, text)
		if err != nil {
			t.Fatal(err)
		}
		if got.Scope != model.PromptScopeProject || got.ScopeID != id || got.Revision != strconv.FormatInt(next, 10) || got.Text != text {
			t.Fatalf("committed mutation result: %+v", got)
		}
		if err := transaction.Commit(group.ctx); err != nil {
			t.Fatal(err)
		}
		read(got, next)
		return got
	}
	committed := write(2, 1, "new")
	stale := begin()
	_, err = prompt.NewDAO(stale).UpdatePrompt(group.ctx, user, model.PromptScopeProject, id, 2, 1, "stale")
	var conflict *model.Fault
	if !errors.As(err, &conflict) || conflict.Code != "version_conflict" {
		t.Fatalf("committed stale update: %v", err)
	}
	if err := rollback(stale); err != nil {
		t.Fatal(err)
	}
	read(committed, 2)
	write(3, 2, "")
	write(4, 3, "again")
	compete("winner-a", "winner-b", 5, func(dao *prompt.DAO, text string) (model.PromptResource, error) {
		return dao.UpdatePrompt(group.ctx, user, model.PromptScopeProject, id, 5, 4, text)
	})
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
