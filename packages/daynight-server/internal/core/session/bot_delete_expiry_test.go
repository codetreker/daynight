package session

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func deletionAdmissionState(t *testing.T, f fixture, id string) string {
	t.Helper()
	var state string
	if err := f.db.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('bot',to_jsonb(b),'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM task_sessions s WHERE s.bot_id=b.id))::text FROM bots b WHERE b.id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestBotDeleteRejectsCredentialsExpiringDuringLockWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		for _, phase := range []string{"bot", "session", "replay"} {
			t.Run(string(kind)+"/"+phase, func(t *testing.T) {
				f, out, _, _ := connectBot(t)
				ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
				defer cancel()
				principal := f.p
				table := "personal_access_tokens"
				if kind == model.SessionCredential {
					principal = listCredential(t, f, f.p.UserID, kind)
					table = "sessions"
				}
				request := store.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
				if phase == "replay" {
					if _, err := botservice.NewDeletions(f.db, f.s.files, f.s.Engine).DeleteBot(ctx, principal, out.Bot.ID, request); err != nil {
						t.Fatal(err)
					}
				}
				before := deletionAdmissionState(t, f, out.Bot.ID)
				lock, err := f.db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.Rollback(context.Background())
				relation, id := "bots", out.Bot.ID
				if phase == "session" {
					relation, id = "task_sessions", out.Session.SessionID
				}
				if _, err = lock.Exec(ctx, "SELECT id FROM "+relation+" WHERE id=$1 FOR UPDATE", id); err != nil {
					t.Fatal(err)
				}
				if _, err = f.db.Pool.Exec(ctx, "UPDATE "+table+" SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", principal.CredentialID); err != nil {
					t.Fatal(err)
				}
				result := make(chan error, 1)
				go func() {
					_, err := botservice.NewDeletions(f.db, f.s.files, f.s.Engine).DeleteBot(ctx, principal, out.Bot.ID, request)
					result <- err
				}()
				wait := func(query string, args ...any) {
					t.Helper()
					ticker := time.NewTicker(5 * time.Millisecond)
					defer ticker.Stop()
					for {
						var ready bool
						if err := f.db.Pool.QueryRow(ctx, query, args...).Scan(&ready); err != nil {
							t.Fatal(err)
						}
						if ready {
							return
						}
						select {
						case <-ctx.Done():
							t.Fatal(ctx.Err())
						case <-ticker.C:
						}
					}
				}
				// The blocking PID proves admission reached this fixture's actual row lock.
				wait(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)))`, int32(lock.Conn().PgConn().PID()))
				wait("SELECT expires_at<=clock_timestamp() FROM "+table+" WHERE id=$1", principal.CredentialID)
				if err = lock.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case err = <-result:
					botFault(t, err, "unauthenticated")
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if deletionAdmissionState(t, f, out.Bot.ID) != before {
					t.Fatal("expired deletion changed Bot or Session authorization")
				}
				if _, err = f.db.Pool.Exec(ctx, "UPDATE "+table+" SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1", principal.CredentialID); err != nil {
					t.Fatal(err)
				}
				deleted, err := botservice.NewDeletions(f.db, f.s.files, f.s.Engine).DeleteBot(ctx, principal, out.Bot.ID, request)
				if err != nil || deleted.Deletion == nil || deleted.Deletion.DeletionID != request.DeletionID {
					t.Fatal("valid original deletion failed", err)
				}
				if phase != "replay" && deleted.Version != out.Bot.Version+1 {
					t.Fatal("valid deletion did not advance once")
				}
				committed := deletionAdmissionState(t, f, out.Bot.ID)
				replayed, err := botservice.NewDeletions(f.db, f.s.files, f.s.Engine).DeleteBot(ctx, principal, out.Bot.ID, request)
				if err != nil || replayed.Version != deleted.Version || deletionAdmissionState(t, f, out.Bot.ID) != committed {
					t.Fatal("valid exact replay changed committed state", err)
				}
			})
		}
	}
}
