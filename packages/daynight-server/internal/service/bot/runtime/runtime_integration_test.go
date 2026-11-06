package runtime_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	botruntime "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot/runtime"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type botFixture struct {
	db     *postgres.Store
	p      model.Principal
	svc    *sessionservice.Service
	engine *sessioncore.Engine
	bound  sessioncore.BotRegistrationResult
}

func newBoundBot(t *testing.T) botFixture {
	t.Helper()
	ctx := context.Background()
	db, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
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

func runtimeWriter(db store.SessionWriter) sessioncore.TransactionRunner {
	return func(ctx context.Context, op *sessioncore.Operation, fn func(store.SessionScope) error) error {
		completion, err := db.WriteSession(ctx, fn)
		op.Finish(completion.Outcome)
		return err
	}
}
func requireRuntimeFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

var errRuntimeStage = errors.New("runtime stage failed")

type injectWriter struct {
	store.SessionWriter
	point string
	calls int
}
type injectScope struct {
	store.SessionScope
	writer *injectWriter
}
type injectDAO struct {
	store.SessionDAO
	writer *injectWriter
}
type injectBot struct {
	store.BotWriteDAO
	writer *injectWriter
}

func (w *injectWriter) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	return w.SessionWriter.WriteSession(ctx, func(scope store.SessionScope) error { return fn(injectScope{scope, w}) })
}
func (s injectScope) SessionDAO() store.SessionDAO {
	return injectDAO{s.SessionScope.SessionDAO(), s.writer}
}
func (s injectScope) BotDAO() store.BotWriteDAO { return injectBot{s.SessionScope.BotDAO(), s.writer} }
func (d injectDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.writer.calls++
	if d.writer.point == "credential2" && d.writer.calls == 2 {
		return errRuntimeStage
	}
	return d.SessionDAO.LockCredential(ctx, p, now)
}
func (d injectDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	if d.writer.point == "session" {
		return store.SessionRecord{}, errRuntimeStage
	}
	return d.SessionDAO.LockSession(ctx, id)
}
func (d injectBot) Bot(ctx context.Context, id string) (model.Bot, error) {
	if d.writer.point == "bot" {
		return model.Bot{}, errRuntimeStage
	}
	return d.BotWriteDAO.Bot(ctx, id)
}

type traceWriter struct {
	store.SessionWriter
	calls []string
}
type traceScope struct {
	store.SessionScope
	writer *traceWriter
}
type traceSession struct {
	store.SessionDAO
	writer *traceWriter
}
type traceBot struct {
	store.BotWriteDAO
	writer *traceWriter
}

func (w *traceWriter) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	return w.SessionWriter.WriteSession(ctx, func(scope store.SessionScope) error { return fn(traceScope{scope, w}) })
}
func (s traceScope) SessionDAO() store.SessionDAO {
	return traceSession{s.SessionScope.SessionDAO(), s.writer}
}
func (s traceScope) BotDAO() store.BotWriteDAO { return traceBot{s.SessionScope.BotDAO(), s.writer} }
func (d traceSession) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.writer.calls = append(d.writer.calls, "credential:"+p.CredentialID)
	return d.SessionDAO.LockCredential(ctx, p, now)
}
func (d traceSession) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	d.writer.calls = append(d.writer.calls, "session:"+id)
	return d.SessionDAO.LockSession(ctx, id)
}
func (d traceBot) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.writer.calls = append(d.writer.calls, "bot:"+id)
	return d.BotWriteDAO.Bot(ctx, id)
}

func TestRuntimeLocksCredentialBotSessionAndRechecksCredentials(t *testing.T) {
	f := newBoundBot(t)
	ctx := context.Background()
	current := f.p
	current.CredentialID = uuid.NewString()
	hash := sha256.Sum256([]byte(current.CredentialID))
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'current',now(),now()+interval '1 day')`, current.CredentialID, current.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	writer := &traceWriter{SessionWriter: f.db}
	runtime := botruntime.NewRuntime(f.engine, runtimeWriter(writer))
	called := false
	err := runtime.Run(ctx, current, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, nil, func(_ *sessioncore.Operation, _ store.SessionScope, _ model.Bot, access *sessioncore.Access, _ func(model.Principal) error) error {
		called = access != nil
		return nil
	})
	want := []string{"credential:" + current.CredentialID, "bot:" + f.bound.Bot.ID, "session:" + *f.bound.Bot.SessionID, "credential:" + current.CredentialID, "credential:" + f.p.CredentialID}
	if err != nil || !called || !reflect.DeepEqual(writer.calls, want) {
		t.Fatalf("runtime locks: called=%v, got %v, want %v, err=%v", called, writer.calls, want, err)
	}
}

func TestRuntimeUsesBoundBotAndRechecksCredential(t *testing.T) {
	f := newBoundBot(t)
	ctx := context.Background()
	runtime := botruntime.NewRuntime(f.engine, runtimeWriter(f.db))
	var order []string
	err := runtime.Run(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, func(bot model.Bot) error { order = append(order, "prepare"); return nil }, func(bot model.Bot, access *sessioncore.Access) error {
		if access == nil {
			t.Fatal("missing bound session")
		}
		order = append(order, "check")
		return nil
	}, func(op *sessioncore.Operation, scope store.SessionScope, bot model.Bot, access *sessioncore.Access, recheck func(model.Principal) error) error {
		order = append(order, "work")
		return recheck(f.p)
	})
	if err != nil || len(order) != 3 || order[0] != "prepare" || order[1] != "check" || order[2] != "work" {
		t.Fatalf("runtime: %v %v", order, err)
	}
	work := func(*sessioncore.Operation, store.SessionScope, model.Bot, *sessioncore.Access, func(model.Principal) error) error {
		t.Error("rejected runtime reached work")
		return nil
	}
	if err = runtime.Run(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, func(model.Bot) error { return errRuntimeStage }, nil, work); !errors.Is(err, errRuntimeStage) {
		t.Fatalf("prepare: %v", err)
	}
	if err = runtime.Run(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, func(model.Bot, *sessioncore.Access) error { return errRuntimeStage }, work); !errors.Is(err, errRuntimeStage) {
		t.Fatalf("binding check: %v", err)
	}
	invalid := f.p
	invalid.Kind = model.SessionCredential
	err = runtime.Run(ctx, invalid, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, nil, work)
	requireRuntimeFault(t, err, "forbidden")
	invalid = f.p
	invalid.CredentialID = uuid.NewString()
	err = runtime.Run(ctx, invalid, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, nil, work)
	requireRuntimeFault(t, err, "unauthenticated")
	err = runtime.Run(ctx, f.p, f.bound.Bot.WorkerID, uuid.NewString(), nil, nil, work)
	requireRuntimeFault(t, err, "not_found")
	err = runtime.Run(ctx, f.p, uuid.NewString(), f.bound.Bot.ID, nil, nil, work)
	requireRuntimeFault(t, err, "forbidden")
	for _, point := range []string{"bot", "session", "credential2"} {
		t.Run(point, func(t *testing.T) {
			writer := &injectWriter{SessionWriter: f.db, point: point}
			r := botruntime.NewRuntime(f.engine, runtimeWriter(writer))
			err := r.Run(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, nil, work)
			if !errors.Is(err, errRuntimeStage) {
				t.Fatalf("storage failure: %v", err)
			}
		})
	}
	replacement := uuid.NewString()
	hash := sha256.Sum256([]byte(replacement))
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'replacement',now(),now()+interval '1 day')`, replacement, f.p.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	renewed := f.p
	renewed.CredentialID = replacement
	err = runtime.Run(ctx, renewed, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, nil, work)
	requireRuntimeFault(t, err, "unauthenticated")
}

func TestRuntimeRejectsDeletedBotAndStoppedEngine(t *testing.T) {
	f := newBoundBot(t)
	ctx := context.Background()
	d := botservice.NewDeletions(f.db, nil, f.engine)
	if _, err := d.DeleteBot(ctx, f.p, f.bound.Bot.ID, store.DeleteBot{Version: f.bound.Bot.Version, DeletionID: uuid.NewString()}); err != nil {
		t.Fatal(err)
	}
	runtime := botruntime.NewRuntime(f.engine, runtimeWriter(f.db))
	work := func(*sessioncore.Operation, store.SessionScope, model.Bot, *sessioncore.Access, func(model.Principal) error) error {
		t.Error("deleted bot reached work")
		return nil
	}
	err := runtime.Run(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, nil, work)
	requireRuntimeFault(t, err, "resource_conflict")
	if err = f.engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	err = runtime.Run(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, nil, nil, work)
	requireRuntimeFault(t, err, "service_unavailable")
}
