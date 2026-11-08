package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSessionShutdownPersistsControllerDisconnectBeforeStoppingEngine(t *testing.T) {
	f := sessionHTTPSetup(t)
	_, snapshot := f.controller(t, uuid.NewString())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var connected bool
	if err := f.db.Pool.QueryRow(ctx, `SELECT connection_expires_at IS NOT NULL FROM task_sessions WHERE id=$1`, snapshot.SessionID).Scan(&connected); err != nil || !connected {
		t.Fatalf("controller connection was not persisted: connected=%v error=%v", connected, err)
	}
	if err := f.application.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT connection_expires_at IS NOT NULL FROM task_sessions WHERE id=$1`, snapshot.SessionID).Scan(&connected); err != nil || connected {
		t.Fatalf("shutdown did not persist controller disconnect: connected=%v error=%v", connected, err)
	}
	if err := f.application.engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if op, err := f.application.engine.BeginOperation(); err == nil {
		op.Close()
		t.Fatal("shutdown left Session engine accepting operations")
	}
}

func TestSessionRuntimeShutsRelayBeforeDependencies(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(strconv.FormatBool(fail), func(t *testing.T) {
			called := false
			sentinel := errors.New("relay drain failed")
			runtime, dependencies := startRuntimeTest(t, testConfig(t), func(*runtimeTestResources) http.Handler { return http.NotFoundHandler() })
			runtime.shutdownHandler = func(ctx context.Context) error {
				called = true
				if err := dependencies.Store.Ready(ctx); err != nil {
					t.Errorf("database closed before relay: %v", err)
				}
				if _, err := dependencies.Files.Put(ctx, uuid.NewString(), "shutdown.txt", strings.NewReader("relay still owns resources")); err != nil {
					t.Errorf("files closed before relay: %v", err)
				}
				if fail {
					return sentinel
				}
				return nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			err := runtime.Run(ctx)
			if !called {
				t.Fatal("relay shutdown hook not called")
			}
			if fail {
				if !errors.Is(err, sentinel) {
					t.Fatalf("shutdown error lost: %v", err)
				}
				if err := dependencies.Store.Ready(context.Background()); err != nil {
					t.Fatalf("failed relay released database: %v", err)
				}
				fail = false
				if err := runtime.Close(context.Background()); !errors.Is(err, sentinel) {
					t.Fatalf("retry lost prior relay failure: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if _, err := dependencies.Store.Pool.Acquire(context.Background()); err == nil {
				t.Fatal("completed shutdown retained database")
			}
		})
	}
}
