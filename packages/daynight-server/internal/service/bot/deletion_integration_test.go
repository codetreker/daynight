package bot_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type botFixture struct {
	db     *store.Store
	p      model.Principal
	svc    *sessionservice.Service
	engine *sessioncore.Engine
	bound  sessioncore.BotRegistrationResult
}

func newBoundBot(t *testing.T) botFixture {
	t.Helper()
	ctx := context.Background()
	db, err := store.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner := testsupport.ServicePrincipal(t, db)
	pat := uuid.NewString()
	hash := sha256.Sum256([]byte(pat))
	if _, err = db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'bot test',now(),now()+interval '1 day')`, pat, owner.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	p := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: pat}
	worker := uuid.NewString()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, p.UserID, worker); err != nil {
		t.Fatal(err)
	}
	config := model.BotConfiguration{WorkerID: worker, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}
	bot, err := botservice.New(db).Create(ctx, p, botcore.CreateBot{ID: uuid.NewString(), Name: "Assistant", Overrides: model.BotOverrides{WorkerID: &worker}, ResolvedConfiguration: config})
	if err != nil {
		t.Fatal(err)
	}
	engine := sessioncore.NewEngine(nil)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	svc := sessionservice.New(db, engine)
	digest := sha256.Sum256([]byte("Use Daynight CLI."))
	input := sessioncore.BotRegistration{BotVersion: bot.Version, Configuration: config, RoleConfiguration: model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: hex.EncodeToString(digest[:])}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
	bound, err := svc.RegisterBot(ctx, p, worker, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	return botFixture{db: db, p: p, svc: svc, engine: engine, bound: bound}
}
func expectFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func receiptFor(f botFixture, id string) botservice.BotDeletionReceipt {
	v := f.bound.Session
	return botservice.BotDeletionReceipt{DeletionID: id, Result: model.BotCleanupResult{State: "completed"}, Stop: &sp.TestStop{Protocol: sp.Protocol, Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
}
func TestBoundBotDeletionFailureRetryAndReceiptReplay(t *testing.T) {
	f := newBoundBot(t)
	ctx := context.Background()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	d := botservice.NewDeletions(f.db, files, f.engine)
	request := store.DeleteBot{Version: f.bound.Bot.Version, DeletionID: uuid.NewString()}
	_, err = d.DeleteBot(ctx, f.p, "invalid", request)
	expectFault(t, err, "invalid_input")
	wrong := request
	wrong.Version++
	_, err = d.DeleteBot(ctx, f.p, f.bound.Bot.ID, wrong)
	expectFault(t, err, "version_conflict")
	other := testsupport.ServicePrincipal(t, f.db)
	_, err = d.DeleteBot(ctx, other, f.bound.Bot.ID, request)
	expectFault(t, err, "forbidden")
	_, err = d.DeleteBot(ctx, f.p, uuid.NewString(), request)
	expectFault(t, err, "not_found")
	deleted, err := d.DeleteBot(ctx, f.p, f.bound.Bot.ID, request)
	if err != nil || deleted.Deletion == nil {
		t.Fatalf("barrier: %+v %v", deleted, err)
	}
	if _, err = d.DeleteBot(ctx, f.p, f.bound.Bot.ID, request); err != nil {
		t.Fatal(err)
	}
	wrong = request
	wrong.DeletionID = uuid.NewString()
	_, err = d.DeleteBot(ctx, f.p, f.bound.Bot.ID, wrong)
	expectFault(t, err, "resource_conflict")
	if _, err = f.svc.TestSnapshot(ctx, f.p, f.bound.Session.SessionID); err == nil {
		t.Fatal("deleted session remained accessible")
	}
	receipt := receiptFor(f, request.DeletionID)
	_, err = d.CompleteBotDeletion(ctx, other, f.bound.Bot.WorkerID, f.bound.Bot.ID, receipt)
	expectFault(t, err, "forbidden")
	_, err = d.CompleteBotDeletion(ctx, f.p, uuid.NewString(), f.bound.Bot.ID, receipt)
	expectFault(t, err, "forbidden")
	invalid := receipt
	invalid.Stop = nil
	_, err = d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, invalid)
	expectFault(t, err, "session_conflict")
	invalid = receipt
	invalid.Stop = &sp.TestStop{}
	_, err = d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, invalid)
	expectFault(t, err, "invalid_input")
	failedCode := "worker_error"
	failed := botservice.BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "failed", Code: &failedCode}}
	before, err := d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, failed)
	if err != nil || before.Deletion.WorkerCleanup.State != "failed" {
		t.Fatalf("failure receipt: %+v %v", before, err)
	}
	again, err := d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, failed)
	if err != nil || again.Version != before.Version {
		t.Fatalf("failure retry: %+v %v", again, err)
	}
	noFiles := botservice.NewDeletions(f.db, nil, f.engine)
	failedCleanup, err := noFiles.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, receipt)
	if err != nil || failedCleanup.Deletion.ServerCleanup.State != "failed" {
		t.Fatalf("cleanup failure: %+v %v", failedCleanup, err)
	}
	if _, err = f.db.Pool.Exec(ctx, `CREATE FUNCTION refuse_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected delete failure'; END $$; CREATE TRIGGER refuse_cleanup BEFORE DELETE ON task_sessions FOR EACH ROW EXECUTE FUNCTION refuse_cleanup()`); err != nil {
		t.Fatal(err)
	}
	sqlFailure, err := d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, receipt)
	if err != nil || sqlFailure.Deletion.ServerCleanup.State != "failed" {
		t.Fatalf("database cleanup failure: %+v %v", sqlFailure, err)
	}
	if _, err = f.db.Pool.Exec(ctx, `DROP TRIGGER refuse_cleanup ON task_sessions; DROP FUNCTION refuse_cleanup()`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `CREATE FUNCTION refuse_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected redaction failure'; END $$; CREATE TRIGGER refuse_cleanup BEFORE UPDATE OF name ON bots FOR EACH ROW EXECUTE FUNCTION refuse_cleanup()`); err != nil {
		t.Fatal(err)
	}
	redactionFailure, err := d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, receipt)
	if err != nil || redactionFailure.Deletion.ServerCleanup.State != "failed" {
		t.Fatalf("redaction failure: %+v %v", redactionFailure, err)
	}
	var retained int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, f.bound.Bot.ID).Scan(&retained); err != nil || retained != 1 {
		t.Fatalf("redaction failure lost Session: %d %v", retained, err)
	}
	if _, err = f.db.Pool.Exec(ctx, `DROP TRIGGER refuse_cleanup ON bots; DROP FUNCTION refuse_cleanup()`); err != nil {
		t.Fatal(err)
	}
	done, err := d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, receipt)
	if err != nil || done.Deletion.ServerCleanup.State != "completed" || done.SessionID != nil {
		t.Fatalf("cleanup retry: %+v %v", done, err)
	}
	if _, err = d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, receipt); err != nil {
		t.Fatal(err)
	}
	changed := receipt
	copyStop := *receipt.Stop
	copyStop.StopProof.RecordID = uuid.NewString()
	changed.Stop = &copyStop
	_, err = d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, changed)
	expectFault(t, err, "session_conflict")
	var count int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, f.bound.Bot.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("session cleanup: %d %v", count, err)
	}
}

type failedCredentialWriter struct{ store.SessionWriter }
type failedCredentialScope struct{ store.SessionScope }
type failedCredentialDAO struct{ store.SessionDAO }

var errCredentialStore = errors.New("credential storage unavailable")

func (w failedCredentialWriter) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	return w.SessionWriter.WriteSession(ctx, func(scope store.SessionScope) error { return fn(failedCredentialScope{scope}) })
}
func (s failedCredentialScope) SessionDAO() store.SessionDAO {
	return failedCredentialDAO{s.SessionScope.SessionDAO()}
}
func (d failedCredentialDAO) LockCredential(context.Context, model.Principal, time.Time) error {
	return errCredentialStore
}

func TestDeletionRejectsInvalidCredentialsAndStorageFailure(t *testing.T) {
	f := newBoundBot(t)
	ctx := context.Background()
	request := store.DeleteBot{Version: f.bound.Bot.Version, DeletionID: uuid.NewString()}
	d := botservice.NewDeletions(f.db, nil, f.engine)
	invalid := f.p
	invalid.Kind = model.CredentialKind("invalid")
	_, err := d.DeleteBot(ctx, invalid, f.bound.Bot.ID, request)
	expectFault(t, err, "forbidden")
	failed := botservice.NewDeletions(failedCredentialWriter{f.db}, nil, f.engine)
	_, err = failed.DeleteBot(ctx, f.p, f.bound.Bot.ID, request)
	if !errors.Is(err, errCredentialStore) {
		t.Fatalf("database failure hidden: %v", err)
	}
	if _, err = f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err = d.DeleteBot(ctx, f.p, f.bound.Bot.ID, request)
	expectFault(t, err, "unauthenticated")
}

func TestDeletionVersionExhaustionKeepsBarrierAbsent(t *testing.T) {
	f := newBoundBot(t)
	ctx := context.Background()
	const maxVersion = int64(9223372036854775807)
	if _, err := f.db.Pool.Exec(ctx, `UPDATE bots SET version=$2 WHERE id=$1`, f.bound.Bot.ID, maxVersion); err != nil {
		t.Fatal(err)
	}
	d := botservice.NewDeletions(f.db, nil, f.engine)
	_, err := d.DeleteBot(ctx, f.p, f.bound.Bot.ID, store.DeleteBot{Version: maxVersion, DeletionID: uuid.NewString()})
	expectFault(t, err, "version_exhausted")
	var deleted bool
	if err = f.db.Pool.QueryRow(ctx, `SELECT deletion IS NOT NULL FROM bots WHERE id=$1`, f.bound.Bot.ID).Scan(&deleted); err != nil || deleted {
		t.Fatalf("barrier changed: %v %v", deleted, err)
	}
}
