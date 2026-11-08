package session

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

var errInjectedCompletion = errors.New("injected transaction completion failure")

type completionWriter struct {
	store.SessionWriter
	mu     sync.Mutex
	mode   string
	cancel context.CancelFunc
}

func (w *completionWriter) inject(mode string, cancel context.CancelFunc) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.mode, w.cancel = mode, cancel
}

func (w *completionWriter) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	w.mu.Lock()
	mode, cancel := w.mode, w.cancel
	w.mode, w.cancel = "", nil
	w.mu.Unlock()
	if mode == "" {
		return w.SessionWriter.WriteSession(ctx, work)
	}
	reached := false
	completion, err := w.SessionWriter.WriteSession(ctx, func(scope store.SessionScope) error {
		if err := work(scope); err != nil {
			return err
		}
		reached = true
		switch mode {
		case "cancel":
			cancel()
			return ctx.Err()
		case "unknown":
			return errInjectedCompletion
		default:
			return nil
		}
	})
	if !reached {
		return completion, err
	}
	switch mode {
	case "committed_cleanup":
		if err != nil || completion.Outcome != store.TransactionCommitted {
			return completion, err
		}
		return completion, &store.TransactionError{Phase: "cleanup", Cause: errInjectedCompletion, Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true}
	case "unknown_committed":
		if err != nil || completion.Outcome != store.TransactionCommitted {
			return completion, err
		}
		return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Cause: errInjectedCompletion, Outcome: store.TransactionUnknown, CommitAttempted: true}
	case "unknown":
		if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, errInjectedCompletion) {
			return completion, err
		}
		return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Cause: errInjectedCompletion, Outcome: store.TransactionUnknown, CommitAttempted: true}
	default:
		return completion, err
	}
}

func TestSessionWriterCompletionControlsLivePublication(t *testing.T) {
	for _, mode := range []string{"committed_cleanup", "unknown", "unknown_committed", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			db, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(db.Close)
			owner := testsupport.ServicePrincipal(t, db)
			credentialID := uuid.NewString()
			hash := sha256.Sum256([]byte(credentialID))
			if _, err = db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'completion',now(),now()+interval '1 day')`, credentialID, owner.UserID, hash[:]); err != nil {
				t.Fatal(err)
			}
			principal := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: credentialID}
			writer := &completionWriter{SessionWriter: db}
			engine := sessioncore.NewEngine(nil)
			t.Cleanup(func() {
				stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := engine.Stop(stopCtx); err != nil {
					t.Error(err)
				}
			})
			svc := New(writer, engine)
			registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
			snapshot, err := svc.RegisterTest(ctx, principal, registration)
			if err != nil {
				t.Fatal(err)
			}
			grant, err := svc.Grant(ctx, principal, "", "", snapshot.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: snapshot.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
			if err != nil {
				t.Fatal(err)
			}
			hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
			connectCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			writer.inject(mode, cancel)
			_, err = svc.Connect(connectCtx, grant.Token, hello, uuid.NewString())
			if mode == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation was not returned: %v", err)
				}
			} else if !errors.Is(err, errInjectedCompletion) {
				t.Fatalf("injected completion error was not returned: %v", err)
			}
			checkCtx, checkCancel := context.WithTimeout(ctx, 3*time.Second)
			defer checkCancel()
			observed, _, _, err := svc.BrowserPoll(checkCtx, principal, "", "", snapshot.SessionID, "")
			if err != nil {
				t.Fatalf("subsequent read could not acquire the cell: %v", err)
			}
			if mode == "committed_cleanup" {
				if observed.ConnectionState != "synchronizing" || observed.ConnectionEpoch != "1" {
					t.Fatalf("committed live state was not published: %+v", observed)
				}
				var durable string
				if err = db.Pool.QueryRow(checkCtx, `SELECT snapshot->>'connectionState' FROM task_sessions WHERE id=$1`, snapshot.SessionID).Scan(&durable); err != nil || durable != "disconnected" {
					t.Fatalf("durable snapshot should not contain live state: %q %v", durable, err)
				}
				return
			}
			if mode == "unknown_committed" {
				if observed.ConnectionState != "disconnected" || observed.ConnectionEpoch != "1" {
					t.Fatalf("unknown commit published a live draft: %+v", observed)
				}
				if _, err := svc.Connect(checkCtx, grant.Token, hello, uuid.NewString()); err == nil {
					t.Fatal("an unknown committed connection was automatically replayable")
				}
				return
			}
			if observed.ConnectionState != "disconnected" || observed.ConnectionEpoch != "0" {
				t.Fatalf("unconfirmed draft became visible: %+v", observed)
			}
			retry, err := svc.Connect(checkCtx, grant.Token, hello, uuid.NewString())
			if err != nil || retry.ConnectionEpoch != "1" {
				t.Fatalf("rolled-back connection could not retry: %+v %v", retry, err)
			}
		})
	}
}
