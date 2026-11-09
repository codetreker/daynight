package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgbot "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func TestSessionBotArchiveAndCleanupSerializeOnBotLock(t *testing.T) {
	for _, archiveFirst := range []bool{true, false} {
		name := "cleanup first"
		if archiveFirst {
			name = "archive first"
		}
		t.Run(name, func(t *testing.T) {
			database := isolatedStore(t)
			bot := runtimeStoredBot(t, database)
			id := uuid.NewString()
			parent := uuid.NewString()
			hash := sha256.Sum256([]byte(parent))
			now := time.Now().UTC()
			mustQueryExec(t, database, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'archive witness',$4,$5)`, parent, bot.OwnerUserID, hash[:], now.Add(-time.Hour), now.Add(time.Hour))
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
				current, err := scope.BotDAO().Bot(ctx, bot.ID)
				if err != nil {
					return err
				}
				inserted, err := scope.SessionDAO().InsertBotSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: bot.OwnerUserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "archived"}, ParentCredentialID: parent, BotID: &bot.ID})
				if err != nil || !inserted {
					t.Fatalf("Bot Session insertion: %v %v", inserted, err)
				}
				_, err = scope.BotDAO().BindBotSession(ctx, bot.ID, current.Version, id, model.BotRoleConfiguration{Instructions: "Archive witness", Revision: "1", Digest: strings.Repeat("a", 64)})
				return err
			})
			holder, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			holderBots, holderSessions := pgbot.NewWriter(holder), pgsession.New(holder)
			if _, err := holderBots.Bot(ctx, bot.ID); err != nil {
				t.Fatal(err)
			}
			deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "completed"}}
			digest, path := strings.Repeat("d", 64), "archive/bot"
			if archiveFirst {
				if _, err := holderSessions.LockSession(ctx, id); err != nil {
					t.Fatal(err)
				}
				if err := holderSessions.SetSessionArchiveReady(ctx, id, digest, 7, path); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := holderSessions.LockBotSessions(ctx, bot.ID); err != nil {
					t.Fatal(err)
				}
				if err := holderSessions.DeleteBotSession(ctx, id, bot.ID); err != nil {
					t.Fatal(err)
				}
				if err := holderSessions.RedactDeletedBot(ctx, bot.ID); err != nil {
					t.Fatal(err)
				}
				if _, err := holderBots.SaveBotDeletion(ctx, bot.ID, deletion); err != nil {
					t.Fatal(err)
				}
			}
			waiter, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer waiter.Rollback(context.Background())
			waiterBots, waiterSessions := pgbot.NewWriter(waiter), pgsession.New(waiter)
			done := make(chan struct{})
			blocker, reader := holder.Conn().PgConn().PID(), waiter.Conn().PgConn().PID()
			var observed model.Bot
			var readErr error
			go func() {
				defer close(done)
				observed, readErr = waiterBots.Bot(ctx, bot.ID)
			}()
			waitErr := awaitSessionStoreBlock(ctx, database, blocker, reader, done)
			commitErr := holder.Commit(ctx)
			<-done
			if waitErr != nil || commitErr != nil || readErr != nil {
				t.Fatalf("Bot lock ordering: wait=%v commit=%v read=%v", waitErr, commitErr, readErr)
			}
			if archiveFirst {
				if observed.SessionID == nil || *observed.SessionID != id || observed.Deletion != nil {
					t.Fatalf("archive-first Bot binding changed: %+v", observed)
				}
				pending := *deletion
				pending.WorkerCleanup.State, pending.ServerCleanup.State = "pending", "pending"
				if _, err := waiterBots.SaveBotDeletion(ctx, bot.ID, &pending); err != nil {
					t.Fatal(err)
				}
				if err := waiter.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
					status, object, err := scope.SessionDAO().SessionArchive(ctx, id)
					if err != nil || status.State != "ready" || status.SHA256 == nil || *status.SHA256 != digest || object != path {
						t.Fatalf("archive commit lost at deletion intent: %+v %q %v", status, object, err)
					}
					if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
						return err
					}
					if _, err := scope.SessionDAO().LockBotSessions(ctx, bot.ID); err != nil {
						return err
					}
					if err := scope.SessionDAO().DeleteBotSession(ctx, id, bot.ID); err != nil {
						return err
					}
					if err := scope.SessionDAO().RedactDeletedBot(ctx, bot.ID); err != nil {
						return err
					}
					_, err = scope.BotDAO().SaveBotDeletion(ctx, bot.ID, deletion)
					return err
				})
			} else {
				if observed.SessionID != nil || observed.Deletion == nil || observed.Deletion.ServerCleanup.State != "completed" {
					t.Fatalf("post-lock Bot read used pre-cleanup state: %+v", observed)
				}
				if _, err := waiterSessions.LockSession(ctx, id); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("cleaned Session remained readable: %v", err)
				}
				if err := waiter.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			var sessions, archives int
			if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_sessions WHERE id=$1),(SELECT count(*) FROM session_archives WHERE session_id=$1)`, id).Scan(&sessions, &archives); err != nil || sessions != 0 || archives != 0 {
				t.Fatalf("Bot cleanup left Session/archive metadata: sessions=%d archives=%d error=%v", sessions, archives, err)
			}
		})
	}
}
