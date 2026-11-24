package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type archiveRuntimeStore struct {
	store.Transactions
	store.ArchiveCleanupStore
	entered chan struct{}
	release chan struct{}
	exited  chan struct{}
}

type botCleanupRuntimeStore struct {
	store.Transactions
	store.ArchiveCleanupStore
	dao *botCleanupRuntimeDAO
}
type botCleanupRuntimeDAO struct {
	store.SessionDAO
	entered chan struct{}
	release chan struct{}
}
type botCleanupRuntimeScope struct {
	store.SessionScope
	dao *botCleanupRuntimeDAO
}

func (s botCleanupRuntimeScope) SessionDAO() store.SessionDAO { return s.dao }
func (s *botCleanupRuntimeStore) ListArchiveCleanup(context.Context, string, int) ([]store.ArchiveCleanupTarget, error) {
	return nil, errors.New("archive scan unavailable")
}
func (s *botCleanupRuntimeStore) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	if err := work(botCleanupRuntimeScope{dao: s.dao}); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (d *botCleanupRuntimeDAO) BotHistoryReclaimSessions(ctx context.Context, after string, limit int) ([]string, error) {
	if after != "" || limit != 32 {
		return nil, errors.New("unexpected Bot cleanup scan")
	}
	close(d.entered)
	<-ctx.Done()
	<-d.release
	return nil, ctx.Err()
}

func TestBotHistoryCleanupApplicationStartsDespiteArchiveFailureAndDrains(t *testing.T) {
	dao := &botCleanupRuntimeDAO{entered: make(chan struct{}), release: make(chan struct{})}
	db := &botCleanupRuntimeStore{dao: dao}
	app := NewModules(config.Config{Session: config.DefaultConfig().Session}, db, nil, nil, nil)
	if err := app.assembleArchiveCleanup(db, nil, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	t.Cleanup(func() {
		select {
		case <-dao.release:
		default:
			close(dao.release)
		}
		if err := app.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	if err := app.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-dao.entered:
	case <-ctx.Done():
		t.Fatal("Bot cleanup did not start", ctx.Err())
	}
	app.CancelWork()
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if err := app.Drain(stopped); !errors.Is(err, context.Canceled) {
		t.Fatal("application drained before Bot maintenance exited", err)
	}
	close(dao.release)
	if err := app.Drain(ctx); err != nil {
		t.Fatal(err)
	}
}

func (s *archiveRuntimeStore) ListArchiveCleanup(ctx context.Context, cursor string, limit int) ([]store.ArchiveCleanupTarget, error) {
	if cursor != "" || limit != 32 {
		return nil, errors.New("unexpected archive scan")
	}
	close(s.entered)
	<-ctx.Done()
	<-s.release
	close(s.exited)
	return nil, ctx.Err()
}

func TestArchiveCleanupApplicationLifecycle(t *testing.T) {
	db := &archiveRuntimeStore{entered: make(chan struct{}), release: make(chan struct{}), exited: make(chan struct{})}
	app := NewModules(config.Config{Session: config.DefaultConfig().Session}, db, nil, nil, nil)
	if err := app.assembleArchiveCleanup(db, nil, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, finish := context.WithTimeout(context.Background(), 5*time.Second)
		defer finish()
		select {
		case <-db.release:
		default:
			close(db.release)
		}
		if err := app.Close(cleanup); err != nil {
			t.Error(err)
		}
	})
	if err := app.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-db.entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := app.Start(ctx); err == nil {
		t.Fatal("duplicate worker start succeeded")
	}
	app.CancelWork()
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if err := app.Drain(stopped); !errors.Is(err, context.Canceled) {
		t.Fatalf("premature drain: %v", err)
	}
	close(db.release)
	if err := app.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-db.exited:
	default:
		t.Fatal("dependencies released before cleanup exit")
	}
	if err := app.Start(ctx); err == nil {
		t.Fatal("started after drain")
	}
}

func TestArchiveCleanupAssemblyRequiresCapability(t *testing.T) {
	app := &App{}
	if err := app.assembleArchiveCleanup(nil, nil, nil); err == nil || app.archiveCleanup != nil {
		t.Fatalf("missing store: %v", err)
	}
}

type releasedRecoveryWriter struct {
	store.ArchiveCleanupStore
	completion store.Completion
	cause      error
	scope      store.ArchiveCleanupScope
	calls      int
}

func (d *releasedRecoveryWriter) WriteArchiveCleanup(_ context.Context, _ store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
	d.calls++
	if d.cause != nil {
		return d.completion, d.cause
	}
	if err := work(d.scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return d.completion, nil
}
func TestReleasedUploadRecoveryTransactionCompletion(t *testing.T) {
	for _, scenario := range []string{"committed", "unknown", "write-error", "work-error", "stopped"} {
		t.Run(scenario, func(t *testing.T) {
			engine := sessioncore.NewEngine(nil)
			app := &App{Application: &application.Application{Engine: engine}}
			t.Cleanup(func() {
				if err := engine.Stop(context.Background()); err != nil {
					t.Error(err)
				}
			})
			failure := errors.New("controlled failure")
			db := &releasedRecoveryWriter{completion: store.Completion{Outcome: store.TransactionCommitted}}
			if scenario == "unknown" {
				db.completion.Outcome = store.TransactionUnknown
			}
			if scenario == "write-error" {
				db.cause = failure
				db.completion.Outcome = store.TransactionNotCommitted
			}
			if scenario == "stopped" {
				if err := engine.Stop(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			called := 0
			err := app.writeReleasedUploadRecovery(t.Context(), db, store.ArchiveCleanupTarget{}, func(op *sessioncore.Operation, scope store.ArchiveCleanupScope) error {
				called++
				if op == nil || scope != db.scope {
					t.Fatal("wrong operation or scope")
				}
				if scenario == "work-error" {
					return failure
				}
				return nil
			})
			switch scenario {
			case "committed":
				if err != nil || called != 1 {
					t.Fatal(err, called)
				}
			case "write-error", "work-error":
				if !errors.Is(err, failure) {
					t.Fatal(err)
				}
			case "unknown", "stopped":
				if err == nil {
					t.Fatal("unconfirmed transaction accepted")
				}
			}
			if scenario == "stopped" && db.calls != 0 {
				t.Fatal("storage called after stop")
			}
		})
	}
}

type recoveryScopeFixture struct {
	store.ArchiveCleanupScope
	target store.ArchiveCleanupTarget
	dao    store.SessionDAO
}

func (s recoveryScopeFixture) Target() store.ArchiveCleanupTarget { return s.target }
func (s recoveryScopeFixture) SessionDAO() store.SessionDAO       { return s.dao }

type recoveryDAOFixture struct {
	store.SessionDAO
	record store.SessionRecord
}

func (d recoveryDAOFixture) LockSession(context.Context, string) (store.SessionRecord, error) {
	return d.record, nil
}
func (d recoveryDAOFixture) SessionArchive(context.Context, string) (sp.ArchiveStatus, string, error) {
	return sp.ArchiveStatus{State: "pending"}, "", nil
}
func TestReleasedUploadRecoveryCallbackSkipsUnreadyArchive(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	engine := sessioncore.NewEngine(files)
	defer engine.Stop(context.Background())
	execution := sessioncore.NewExecution(engine, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	app := &App{Application: &application.Application{Engine: engine, Sessions: &sessionservice.Service{Execution: execution}}}
	target := store.ArchiveCleanupTarget{SessionID: "10000000-0000-4000-8000-000000000001", OwnerID: "10000000-0000-4000-8000-000000000002"}
	scope := recoveryScopeFixture{target: target, dao: recoveryDAOFixture{record: store.SessionRecord{Owner: target.OwnerID, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: target.SessionID}}}}}}
	db := &releasedRecoveryWriter{completion: store.Completion{Outcome: store.TransactionCommitted}, scope: scope}
	if err = app.releasedUploadRecovery(db)(t.Context(), target); err != nil || db.calls != 1 {
		t.Fatal(err, db.calls)
	}
}
