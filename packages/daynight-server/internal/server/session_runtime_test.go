package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type sessionShutdownHandler struct {
	http.Handler
	shutdown func(context.Context) error
}

func (h sessionShutdownHandler) Shutdown(ctx context.Context) error { return h.shutdown(ctx) }

func TestSessionRuntimeShutsRelayBeforeDependencies(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(strconv.FormatBool(fail), func(t *testing.T) {
			config := testConfig(t)
			called := false
			sentinel := errors.New("relay drain failed")
			runtime, err := Start(context.Background(), config, testLogger(), func(dependencies Dependencies) (http.Handler, error) {
				return sessionShutdownHandler{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }), shutdown: func(ctx context.Context) error {
					called = true
					if err := dependencies.Ready(ctx); err != nil {
						t.Errorf("database closed before relay: %v", err)
					}
					if _, err := dependencies.Files.Put(ctx, uuid.NewString(), "shutdown.txt", strings.NewReader("relay still owns resources")); err != nil {
						t.Errorf("files closed before relay: %v", err)
					}
					if fail {
						return sentinel
					}
					return nil
				}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			err = runtime.Run(ctx)
			if !called {
				t.Fatal("relay shutdown hook not called")
			}
			if fail && !errors.Is(err, sentinel) {
				t.Fatalf("shutdown error lost: %v", err)
			}
			if !fail && err != nil {
				t.Fatal(err)
			}
		})
	}
}
