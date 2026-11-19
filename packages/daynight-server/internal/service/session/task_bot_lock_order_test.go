package session

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

// heldBotBarrier pauses a declared-Bot Task write after it acquires the Bot
// deletion barrier and before it locks its Task.
type heldBotBarrier struct {
	*postgres.Store
	entered, release chan struct{}
}

type heldBotBarrierScope struct {
	store.ProjectWriteScope
	held *heldBotBarrier
}

type heldBotBarrierDAO struct {
	store.BotBarrierDAO
	held *heldBotBarrier
}

func (s *heldBotBarrier) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error {
		return work(heldBotBarrierScope{ProjectWriteScope: scope, held: s})
	})
}

func (s heldBotBarrierScope) BotBarrierDAO() store.BotBarrierDAO {
	return heldBotBarrierDAO{BotBarrierDAO: s.ProjectWriteScope.BotBarrierDAO(), held: s.held}
}

func (d heldBotBarrierDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	bot, err := d.BotBarrierDAO.Bot(ctx, id)
	if err != nil {
		return bot, err
	}
	close(d.held.entered)
	select {
	case <-d.held.release:
		return bot, nil
	case <-ctx.Done():
		return bot, ctx.Err()
	}
}

func botLockWaiters(ctx context.Context, db *postgres.Store) (int, error) {
	var count int
	err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM bots%FOR UPDATE%'`).Scan(&count)
	return count, err
}

// A Task-scoped Session request that names a Bot-bound Test Session must not
// wait for that Bot while it holds the Task: a declared-Bot Task write holds
// the Bot barrier before it locks the same Task.
func TestTaskSessionRouteRejectsBotSessionBeforeDeclaredBotTaskWrite(t *testing.T) {
	for _, tc := range []struct {
		name    string
		purpose sessioncore.BrowserPurpose
		code    string
	}{
		{name: "browser", purpose: sessioncore.BrowserAccess, code: "session_conflict"},
		{name: "task message", purpose: sessioncore.TaskMessageAccess, code: "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			f := newServiceFixture(t)
			botID, sessionID, worker := uuid.NewString(), uuid.NewString(), uuid.NewString()
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, []any{f.owner.UserID, worker}},
				{`INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result,session_id) VALUES($1,$2,$3,'Lock order Bot',$4,'{"args":[]}','{"provider":"codex"}','{}',$5)`, []any{botID, f.owner.UserID, worker, strings.Repeat("a", 64), sessionID}},
				{`INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,bot_id) VALUES($1,'test',$2,$3,$4,'{}',$5,$6,$7)`, []any{sessionID, uuid.NewString(), f.owner.UserID, uuid.NewString(), `{"sessionId":"` + sessionID + `","lifecycle":"active"}`, f.owner.CredentialID, botID}},
			} {
				if _, err := f.db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
					t.Fatal(err)
				}
			}
			var version int64
			if err := f.db.Pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1`, f.task).Scan(&version); err != nil {
				t.Fatal(err)
			}
			held := &heldBotBarrier{Store: f.db, entered: make(chan struct{}), release: make(chan struct{})}
			var once sync.Once
			release := func() { once.Do(func() { close(held.release) }) }
			t.Cleanup(release)
			title := "Declared Bot update"
			update := make(chan error, 1)
			go func() {
				_, err := taskservice.NewTasks(held).Update(taskservice.WithDeclaredBot(ctx, botID), f.owner, f.project, f.task, taskcore.UpdateTask{Version: version, Title: &title})
				update <- err
			}()
			select {
			case <-held.entered:
			case err := <-update:
				t.Fatalf("Task update finished before holding the Bot barrier: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			route := make(chan error, 1)
			go func() {
				route <- f.service.browserFor(ctx, f.owner, f.project, f.task, sessionID, tc.purpose, func(*sessioncore.Access) error {
					t.Error("Task route admitted a Bot-bound Session")
					return nil
				})
			}()
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
		wait:
			for {
				select {
				case err := <-route:
					requireServiceError(t, err, tc.code)
					break wait
				case <-ticker.C:
					waiting, err := botLockWaiters(ctx, f.db)
					if err != nil {
						t.Fatal(err)
					}
					if waiting != 0 {
						release()
						t.Fatalf("Task route waited for the Bot held by a declared-Bot Task write; route result: %v", <-route)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			release()
			if err := <-update; err != nil {
				t.Fatalf("declared-Bot Task update: %v", err)
			}
			var stored string
			if err := f.db.Pool.QueryRow(ctx, `SELECT title FROM tasks WHERE id=$1`, f.task).Scan(&stored); err != nil || stored != title {
				t.Fatalf("Task title = %q, %v", stored, err)
			}
		})
	}
}
