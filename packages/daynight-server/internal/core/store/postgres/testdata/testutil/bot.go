package testutil

import (
	"context"
	"crypto/sha256"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func BotPreferenceText(value string) *string { return &value }

func WriteBot(database store.BotWriter, ctx context.Context, operation func(store.BotWriteDAO) error) error {
	_, err := database.WriteBot(ctx, func(scope store.BotScope) error { return operation(scope.BotDAO()) })
	return err
}

func StoredBotCandidate(t *testing.T, database interface {
	store.IdentityWriter
	store.WorkerWriter
}) (model.Bot, model.Principal) {
	t.Helper()
	_, principal, _ := AuthRecords(t, database)
	workerID := uuid.NewString()
	PutWorkerSnapshot(t, database, WorkerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
	return model.Bot{ID: uuid.NewString(), OwnerUserID: principal.UserID, WorkerID: workerID, Name: "Stored Bot",
		RequestFingerprint: strings.Repeat("a", 64), ResolvedConfiguration: model.BotConfiguration{WorkerID: workerID, Cwd: "/ordinary", Provider: "codex", Args: []string{}}}, principal
}

func RuntimeStoredBot(t *testing.T, database interface {
	store.IdentityWriter
	store.WorkerWriter
	store.BotWriter
}) model.Bot {
	t.Helper()
	candidate, _ := StoredBotCandidate(t, database)
	if err := WriteBot(database, context.Background(), func(dao store.BotWriteDAO) error {
		return dao.InsertBot(context.Background(), candidate)
	}); err != nil {
		t.Fatal(err)
	}
	return candidate
}

func InsertBotSession(ctx context.Context, tx pgx.Tx, candidate model.Bot, sessionID, executionID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,bot_id)
 VALUES($1,'test',$2,$3,$4,'{}','{}',$5)`, sessionID, executionID, candidate.OwnerUserID, uuid.NewString(), candidate.ID)
	return err
}

func RuntimeBotState(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var state string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object('bot',to_jsonb(b),
 'sessions',(SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM task_sessions s WHERE s.bot_id=b.id),
 'workerPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM bot_worker_preferences p WHERE p.user_id=b.owner_user_id),
 'configurationPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.worker_id),'[]'::jsonb) FROM bot_configuration_preferences p WHERE p.user_id=b.owner_user_id))::text FROM bots b WHERE b.id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func RuntimeBotPAT(t *testing.T, database store.IdentityWriter, candidate model.Bot) model.Principal {
	t.Helper()
	digest := sha256.Sum256([]byte(uuid.NewString()))
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: candidate.OwnerUserID, TokenHash: digest[:], Name: "Runtime boundary", CreatedAt: time.Now().UTC()}
	completion, err := database.WriteIdentity(context.Background(), func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(t.Context(), pat) })
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("identity transaction: %#v %v", completion, err)
	}
	return model.Principal{Kind: model.PATCredential, UserID: candidate.OwnerUserID, CredentialID: pat.ID}
}

func ReadBotDefaults(t *testing.T, database store.SnapshotReader, ownerID string) model.BotDefaultsInput {
	t.Helper()
	var result model.BotDefaultsInput
	if err := database.ReadSnapshot(context.Background(), func(snapshot store.SnapshotScope) error {
		var err error
		result, err = snapshot.BotDAO().BotDefaults(context.Background(), ownerID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return result
}

func InsertPreferenceBot(t *testing.T, database store.BotWriter, candidate model.Bot, overrides model.BotOverrides) model.Bot {
	t.Helper()
	candidate.ID = uuid.NewString()
	candidate.RequestedOverrides = overrides
	if overrides.Cwd != nil {
		candidate.ResolvedConfiguration.Cwd = *overrides.Cwd
	}
	if overrides.Provider != nil {
		candidate.ResolvedConfiguration.Provider = *overrides.Provider
	}
	if err := WriteBot(database, context.Background(), func(dao store.BotWriteDAO) error { return dao.InsertBot(context.Background(), candidate) }); err != nil {
		t.Fatal(err)
	}
	return candidate
}

func MarkPreferenceBotReady(t *testing.T, pool *pgxpool.Pool, botID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE bots SET session_id=$2,startup_result='{"state":"ready","code":null}' WHERE id=$1`, botID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
}

func CommitPreferenceBot(t *testing.T, database store.BotWriter, botID string) {
	t.Helper()
	if err := WriteBot(database, context.Background(), func(dao store.BotWriteDAO) error { return dao.CommitBotPreferences(context.Background(), botID) }); err != nil {
		t.Fatal(err)
	}
}

func RuntimeBotWriteAfterLock(t *testing.T, pool *pgxpool.Pool, candidate model.Bot, principal model.Principal,
	write func(context.Context, func(store.BotWriteDAO, pgx.Tx) error) error,
	credential func(context.Context, store.BotWriteDAO, pgx.Tx, model.Principal) error,
	expired bool, operation func(context.Context, store.BotWriteDAO, pgx.Tx) error,
) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	table := "personal_access_tokens"
	if principal.Kind == model.SessionCredential {
		table = "sessions"
	}
	var expiry time.Time
	duration := "1 day"
	if expired {
		duration = "1 second"
	}
	if err := pool.QueryRow(ctx, `UPDATE `+table+` SET expires_at=clock_timestamp()+$2::interval WHERE id=$1 RETURNING expires_at`, principal.CredentialID, duration).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(ctx, `SELECT id FROM bots WHERE id=$1 FOR UPDATE`, candidate.ID); err != nil {
		t.Fatal(err)
	}
	before := RuntimeBotState(t, pool, candidate.ID)
	done, finished := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(finished)
		done <- write(ctx, func(dao store.BotWriteDAO, raw pgx.Tx) error {
			if err := credential(ctx, dao, raw, principal); err != nil {
				return err
			}
			if _, err := dao.Bot(ctx, candidate.ID); err != nil {
				return err
			}
			if err := operation(ctx, dao, raw); err != nil {
				return err
			}
			return credential(ctx, dao, raw, principal)
		})
	}()
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("runtime mutation did not drain after cancellation")
		}
	}()
	WaitTransferTeamLock(t, ctx, pool, "SELECT id::text FROM bots WHERE id=", holder.Conn().PgConn().PID())
	if expired {
		for {
			var reached bool
			if err := pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expiry).Scan(&reached); err != nil {
				t.Fatal(err)
			}
			if reached {
				break
			}
			if err := WaitThreadClock(ctx); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if expired && RuntimeBotState(t, pool, candidate.ID) != before {
		t.Fatal("expired credential committed Bot, Session or preference changes")
	}
	return err
}
