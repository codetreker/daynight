package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgbot "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	pgtask "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func sessionArchiveLockFixture(t *testing.T) (*postgres.Store, model.Task, string) {
	t.Helper()
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskDone)
	id, claim := uuid.NewString(), uuid.NewString()
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return dao.InsertTaskSession(t.Context(), store.SessionRegistration{
			Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID},
			ClaimID:  claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`),
			Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "archived"},
		})
	})
	return database, task, id
}

func awaitSessionStoreBlock(ctx context.Context, database *postgres.Store, blocker, waiter uint32, finished <-chan struct{}) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := database.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2))`, blocker, waiter).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return nil
		}
		select {
		case <-finished:
			return fmt.Errorf("backend %d completed without waiting on backend %d", waiter, blocker)
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func assertSessionArchiveAfterDeletion(t *testing.T, database *postgres.Store, task model.Task, id, digest, path string) {
	t.Helper()
	var deleted bool
	var version int64
	if err := database.Pool.QueryRow(t.Context(), `SELECT deleted_at IS NOT NULL,version FROM tasks WHERE id=$1`, task.ID).Scan(&deleted, &version); err != nil || !deleted || version != task.Version+1 {
		t.Fatalf("committed deletion: deleted=%v version=%d error=%v", deleted, version, err)
	}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		status, object, err := dao.SessionArchive(t.Context(), id)
		if err != nil || status.State != "ready" || status.SHA256 == nil || *status.SHA256 != digest || status.ByteLength == nil || *status.ByteLength != "7" || object != path {
			t.Fatalf("archive receipt after deletion: %+v %q %v", status, object, err)
		}
		return nil
	})
}

func TestSessionArchiveWaitsForDeletionAndReadsCommittedState(t *testing.T) {
	database, task, id := sessionArchiveLockFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deletion, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	tasks := pgtask.NewWriter(deletion, task.ProjectID)
	if _, err := tasks.Task(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.DeleteTask(ctx, task.ID, false); err != nil {
		t.Fatal(err)
	}
	archive, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Rollback(context.Background())
	digest, path := strings.Repeat("a", 64), "archive/object"
	done := make(chan struct{})
	blocker, waiter := deletion.Conn().PgConn().PID(), archive.Conn().PgConn().PID()
	var readDeleted bool
	var archiveErr error
	go func() {
		defer close(done)
		dao := pgsession.New(archive)
		var current store.SessionTask
		current, readDeleted, archiveErr = dao.LockArchiveTask(ctx, task.ProjectID, task.ID)
		if archiveErr == nil && current.Status != string(model.TaskDone) {
			archiveErr = fmt.Errorf("archive read task status %q", current.Status)
		}
		if archiveErr == nil {
			archiveErr = dao.SetSessionArchiveReady(ctx, id, digest, 7, path)
		}
		if archiveErr == nil {
			archiveErr = archive.Commit(ctx)
		}
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, waiter, done)
	commitErr := deletion.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || archiveErr != nil || !readDeleted {
		t.Fatalf("delete-first serialization: wait=%v commit=%v archive=%v deleted=%v", waitErr, commitErr, archiveErr, readDeleted)
	}
	assertSessionArchiveAfterDeletion(t, database, task, id, digest, path)
}

func TestSessionDeletionWaitsForArchiveAndRetainsReceipt(t *testing.T) {
	database, task, id := sessionArchiveLockFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	archive, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Rollback(context.Background())
	dao := pgsession.New(archive)
	if _, deleted, err := dao.LockArchiveTask(ctx, task.ProjectID, task.ID); err != nil || deleted {
		t.Fatalf("initial archive task: deleted=%v error=%v", deleted, err)
	}
	digest, path := strings.Repeat("b", 64), "archive/object"
	if err := dao.SetSessionArchiveReady(ctx, id, digest, 7, path); err != nil {
		t.Fatal(err)
	}
	deletion, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	done := make(chan struct{})
	blocker, waiter := archive.Conn().PgConn().PID(), deletion.Conn().PgConn().PID()
	var deleteErr error
	go func() {
		defer close(done)
		tasks := pgtask.NewWriter(deletion, task.ProjectID)
		_, deleteErr = tasks.Task(ctx, task.ID)
		if deleteErr == nil {
			_, deleteErr = tasks.DeleteTask(ctx, task.ID, false)
		}
		if deleteErr == nil {
			deleteErr = deletion.Commit(ctx)
		}
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, waiter, done)
	commitErr := archive.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || deleteErr != nil {
		t.Fatalf("archive-first serialization: wait=%v commit=%v delete=%v", waitErr, commitErr, deleteErr)
	}
	assertSessionArchiveAfterDeletion(t, database, task, id, digest, path)
}

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
			sessionBotDAOTransaction(t, database, func(dao store.SessionDAO, bots store.BotWriteDAO) error {
				current, err := bots.Bot(ctx, bot.ID)
				if err != nil {
					return err
				}
				inserted, err := dao.InsertBotSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: bot.OwnerUserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "archived"}, ParentCredentialID: parent, BotID: &bot.ID})
				if err != nil || !inserted {
					t.Fatalf("Bot Session insertion: %v %v", inserted, err)
				}
				_, err = bots.BindBotSession(ctx, bot.ID, current.Version, id, model.BotRoleConfiguration{Instructions: "Archive witness", Revision: "1", Digest: strings.Repeat("a", 64)})
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
				sessionBotDAOTransaction(t, database, func(dao store.SessionDAO, bots store.BotWriteDAO) error {
					status, object, err := dao.SessionArchive(ctx, id)
					if err != nil || status.State != "ready" || status.SHA256 == nil || *status.SHA256 != digest || object != path {
						t.Fatalf("archive commit lost at deletion intent: %+v %q %v", status, object, err)
					}
					if _, err := bots.Bot(ctx, bot.ID); err != nil {
						return err
					}
					if _, err := dao.LockBotSessions(ctx, bot.ID); err != nil {
						return err
					}
					if err := dao.DeleteBotSession(ctx, id, bot.ID); err != nil {
						return err
					}
					if err := dao.RedactDeletedBot(ctx, bot.ID); err != nil {
						return err
					}
					_, err = bots.SaveBotDeletion(ctx, bot.ID, deletion)
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

func TestSessionTerminalHistoryRetainsMixedBackendsAndOriginalArchive(t *testing.T) {
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskDone)
	other := queryTask(t, database, project.ID, 3, model.TaskDone)
	now := time.Now().UTC().Truncate(time.Microsecond)
	older := now.Add(-time.Hour)
	oldID, webID, currentID, otherID, newID := queryID(501), queryID(502), queryID(503), queryID(504), queryID(505)
	oldClaim, webClaim, currentClaim, newClaim := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	terminal := func(dao store.SessionDAO, id, taskID, claim string) error {
		return dao.InsertTerminal(t.Context(), store.TerminalRegistration{SessionID: id, ProjectID: project.ID, TaskID: taskID, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), State: []byte(`{"generation":"1"}`), LastSeen: now, ServerInstance: uuid.NewString()})
	}
	finalization, digest, size, completeness, path := uuid.NewString(), strings.Repeat("c", 64), "7", "complete", "archive/original"
	receipt := v2.Receipt{FinalizationID: finalization, Disposition: "ready", SHA256: &digest, ByteLength: &size, Completeness: &completeness}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		if err := terminal(dao, oldID, task.ID, oldClaim); err != nil {
			return err
		}
		if err := terminal(dao, currentID, task.ID, currentClaim); err != nil {
			return err
		}
		if err := terminal(dao, otherID, other.ID, uuid.NewString()); err != nil {
			return err
		}
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: webID, ProjectID: project.ID, TaskID: task.ID}, ClaimID: webClaim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: webID, ClaimID: webClaim, ExecutionGeneration: "1"}}, Lifecycle: "archived"}}); err != nil {
			return err
		}
		return dao.SaveTerminalReceipt(t.Context(), currentID, receipt, &path)
	})
	mustQueryExec(t, database, `UPDATE task_sessions SET created_at=$1 WHERE id IN ($2,$3)`, older, oldID, webID)
	mustQueryExec(t, database, `UPDATE task_sessions SET created_at=$1 WHERE id=$2`, now, currentID)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		rows, err := dao.TerminalHistory(t.Context(), project.ID, task.ID, nil, nil, 2)
		if err != nil || len(rows) != 2 || rows[0].ID != currentID || rows[0].Claim != currentClaim || rows[0].Backend != "herdr" || len(rows[0].Snapshot) != 0 || len(rows[0].Terminal) == 0 || rows[1].ID != webID || rows[1].Claim != webClaim || rows[1].Backend != "web" || len(rows[1].Terminal) != 0 {
			t.Fatalf("mixed backend history and nullable content: %+v %v", rows, err)
		}
		var snapshot sp.Snapshot
		if err := json.Unmarshal(rows[1].Snapshot, &snapshot); err != nil || snapshot.SessionID != webID || snapshot.ClaimID != webClaim {
			t.Fatalf("web snapshot mapping: %+v %v", snapshot, err)
		}
		rows, err = dao.TerminalHistory(t.Context(), project.ID, task.ID, &older, &webID, 2)
		if err != nil || len(rows) != 1 || rows[0].ID != oldID || rows[0].Claim != oldClaim {
			t.Fatalf("tied history cursor: %+v %v", rows, err)
		}
		for claim, id := range map[string]string{oldClaim: oldID, currentClaim: currentID} {
			actual, err := dao.CurrentTerminalSession(t.Context(), project.ID, task.ID, claim)
			if err != nil || actual != id {
				t.Fatalf("current terminal bound to claim: claim=%s id=%s error=%v", claim, actual, err)
			}
		}
		if _, err := dao.CurrentTerminalSession(t.Context(), project.ID, task.ID, webClaim); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("web backend returned as terminal: %v", err)
		}
		return nil
	})
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return terminal(dao, newID, task.ID, newClaim)
	})
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, task.ID)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		actual, err := dao.CurrentTerminalSession(t.Context(), project.ID, task.ID, newClaim)
		if err != nil || actual != newID {
			t.Fatalf("new claim did not select its terminal: %s %v", actual, err)
		}
		status, saved, object, err := dao.TerminalArchive(t.Context(), currentID)
		if err != nil || status.State != "ready" || saved == nil || saved.FinalizationID != finalization || saved.SHA256 == nil || *saved.SHA256 != digest || saved.ByteLength == nil || *saved.ByteLength != size || saved.Completeness == nil || *saved.Completeness != completeness || object != path {
			t.Fatalf("new claim or deletion replaced original archive: %+v %+v %q %v", status, saved, object, err)
		}
		return nil
	})
}

func TestSessionTerminalWritersReadCommittedPredecessor(t *testing.T) {
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, instance := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return dao.InsertTerminal(t.Context(), store.TerminalRegistration{SessionID: id, ProjectID: project.ID, TaskID: task.ID, ClaimID: uuid.NewString(), OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), State: []byte(`{"revision":1}`), LastSeen: now, ServerInstance: instance})
	})
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	dao := pgsession.New(first)
	if _, err := dao.LockTerminal(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := dao.SaveTerminal(ctx, id, []byte(`{"revision":2}`), &now, instance); err != nil {
		t.Fatal(err)
	}
	second, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Rollback(context.Background())
	blocker, reader := first.Conn().PgConn().PID(), second.Conn().PgConn().PID()
	done := make(chan struct{})
	var raw []byte
	var readErr error
	go func() {
		defer close(done)
		raw, readErr = pgsession.New(second).LockTerminal(ctx, id)
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, reader, done)
	commitErr := first.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || readErr != nil {
		t.Fatalf("terminal write serialization: wait=%v commit=%v read=%v", waitErr, commitErr, readErr)
	}
	var state struct {
		Revision int `json:"revision"`
	}
	if err := json.Unmarshal(raw, &state); err != nil || state.Revision != 2 {
		t.Fatalf("second writer loaded obsolete terminal state: %s %v", raw, err)
	}
	if err := second.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
