package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestBotDefinitionCredentialRechecksAfterLockedRead(t *testing.T) {
	db := isolatedStore(t)
	bot, principal := storedBotCandidate(t, db)
	sessionDAOTransaction(t, db, func(s store.SessionScope) error { return s.BotDAO().InsertBot(t.Context(), bot) })
	before := runtimeBotState(t, db, bot.ID)
	for _, expired := range []bool{true, false} {
		err := runtimeBotWriteAfterLock(t, db, bot, principal, runtimeDefinitionCredential, expired, func(ctx context.Context, dao store.BotWriteDAO, _ pgx.Tx) error {
			got, err := dao.Bot(ctx, bot.ID)
			if err != nil {
				return err
			}
			if got.Version != 1 || got.Deletion != nil {
				t.Fatalf("locked read changed definition: %+v", got)
			}
			return nil
		})
		if expired && !errors.Is(err, model.ErrNotFound) || !expired && err != nil || runtimeBotState(t, db, bot.ID) != before {
			t.Fatalf("credential after lock: expired=%t err=%v", expired, err)
		}
	}
}

func TestBotDeletionKeepsIndependentTaskAndPreciseVersion(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	candidate, _ := storedBotCandidate(t, db)
	project, task := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Independent tasks','example')`, project)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'A task stays independent')`, task, project)
	state := func() string {
		t.Helper()
		var result string
		if err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'task',(SELECT to_jsonb(t) FROM tasks t WHERE id=$1),
 'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=$1),
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=$1),
 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=$1),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=$1))::text`, task).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := state()
	sessionDAOTransaction(t, db, func(s store.SessionScope) error { return s.BotDAO().InsertBot(ctx, candidate) })
	const version = int64(9007199254740993)
	mustQueryExec(t, db, `UPDATE bots SET version=$2 WHERE id=$1`, candidate.ID, version)
	deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	sessionDAOTransaction(t, db, func(s store.SessionScope) error {
		current, err := s.BotDAO().Bot(ctx, candidate.ID)
		if err != nil {
			return err
		}
		if current.Version != version {
			t.Fatalf("version rounded: %+v", current)
		}
		_, err = s.BotDAO().SaveBotDeletion(ctx, current.ID, deletion)
		return err
	})
	if err := db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		got, err := s.BotDAO().Bot(ctx, candidate.ID)
		if err != nil {
			return err
		}
		if got.Version != version+1 || !reflect.DeepEqual(got.Deletion, deletion) {
			t.Fatalf("precise deletion lost: %+v", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if state() != before {
		t.Fatal("Bot creation/deletion changed independent task state")
	}
}
