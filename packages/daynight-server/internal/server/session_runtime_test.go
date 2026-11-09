package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSessionShutdownDisconnectsControllerBeforeStoppingEngine(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.controller(t, uuid.NewString())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f.mu.Lock()
	connected := f.writes.instance != "" && f.writes.connectionExpiry != nil
	before := f.writes.disconnected
	f.mu.Unlock()
	if !connected {
		t.Fatal("controller connection DAO was not called")
	}
	if err := f.application.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	after := f.writes.disconnected
	f.mu.Unlock()
	if after != before+1 {
		t.Fatalf("shutdown disconnect calls=%d, want%d", after-before, 1)
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
			if err := dependencies.Store.Ready(context.Background()); !errors.Is(err, os.ErrClosed) {
				t.Fatal("completed shutdown retained database")
			}
		})
	}
}
