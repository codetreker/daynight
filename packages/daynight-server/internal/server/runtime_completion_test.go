package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
)

type completedAppTestCloseError struct{ cause error }

func (e completedAppTestCloseError) Error() string { return e.cause.Error() }
func (e completedAppTestCloseError) Unwrap() error { return e.cause }
func (e completedAppTestCloseError) Closed() bool  { return true }

func TestCompletedApplicationFailuresReleaseOnceAndRetainCauses(t *testing.T) {
	for _, delayed := range []bool{false, true} {
		t.Run(strconv.FormatBool(delayed), func(t *testing.T) {
			drainFailure, closeFailure := errors.New("usage flush failed"), errors.New("files close failed")
			started, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var drains, closes atomic.Int32
			runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 20*time.Millisecond, testLogger(), http.NotFoundHandler(), nil, nil,
				func(context.Context) error {
					drains.Add(1)
					close(started)
					if delayed {
						<-release
					}
					close(returned)
					return completedRelayTestError{drainFailure}
				}, func(context.Context) error {
					closes.Add(1)
					return completedAppTestCloseError{closeFailure}
				})
			if err != nil {
				t.Fatal(err)
			}
			if delayed {
				ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
				err = runtime.Close(ctx)
				cancel()
				if !errors.Is(err, context.DeadlineExceeded) || closes.Load() != 0 {
					t.Fatalf("unfinished application released resources: %v", err)
				}
				await(t, started)
				close(release)
				await(t, returned)
			}
			for range 2 {
				err = runtime.Close(context.Background())
				if !errors.Is(err, drainFailure) || !errors.Is(err, closeFailure) || !runtime.appDrained || !runtime.appClosed {
					t.Fatalf("completion facts or original causes were lost: %v", err)
				}
			}
			if drains.Load() != 1 || closes.Load() != 1 {
				t.Fatalf("completed work repeated: drains=%d closes=%d", drains.Load(), closes.Load())
			}
		})
	}
}

func TestApplicationCompletionRequiresWholeResult(t *testing.T) {
	failure := errors.New("another producer did not stop")
	var drains, closes atomic.Int32
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil,
		func(context.Context) error {
			if drains.Add(1) == 1 {
				return errors.Join(completedRelayTestError{errors.New("recorder stopped")}, failure)
			}
			return nil
		}, func(context.Context) error { closes.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Close(context.Background()); !errors.Is(err, failure) || runtime.appDrained || closes.Load() != 0 {
		t.Fatalf("nested recorder completion was treated as application completion: %v", err)
	}
	if err := runtime.Close(context.Background()); !errors.Is(err, failure) || !runtime.appDrained || closes.Load() != 1 {
		t.Fatalf("retry lost cause or retained finished resources: %v", err)
	}
}

type runtimeUsageWriter func(context.Context, []model.CredentialUsageEvent) (store.Completion, error)

func (f runtimeUsageWriter) WriteCredentialUsage(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
	return f(ctx, events)
}

func TestRuntimeGraceAcceptsLateUsageBeforeApplicationSeal(t *testing.T) {
	root, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, proceed, relayStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(proceed) }) }
	defer release()
	written := make(chan model.CredentialUsageEvent, 1)
	event := model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: "00000000-0000-4000-8000-000000000001", SubjectID: "00000000-0000-4000-8000-000000000002", At: time.Now().UTC().Truncate(time.Microsecond)}
	recorder, err := credentialusage.New(runtimeUsageWriter(func(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
		if root.Err() == nil || ctx.Err() != nil || len(events) != 1 {
			t.Errorf("late event did not use independent application work context: root=%v work=%v events=%v", root.Err(), ctx.Err(), events)
		}
		written <- events[0]
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}), testLogger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Production backend identity is verified by service's OpenApp tests; this
	// transport proof uses the real App lifecycle with only its writer controlled.
	app := service.NewModules(config.Config{}, nil, nil, nil, nil)
	app.CredentialUsage = recorder
	if err := app.Start(root); err != nil {
		t.Fatal(err)
	}
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-proceed
		admission, err := app.CredentialUsage.Record(credentialusage.WithSource(r.Context(), usage.SourceHTTPPAT), event)
		if err != nil || admission != usage.Accepted {
			t.Errorf("HTTP grace rejected late event: admission=%v err=%v", admission, err)
		}
		w.WriteHeader(http.StatusNoContent)
	}), func(context.Context) error { close(relayStarted); return nil }, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		_ = app.Close(context.Background())
		t.Fatal(err)
	}
	t.Cleanup(func() {
		release()
		cancel()
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = runtime.Close(ctx)
	})
	running := make(chan error, 1)
	go func() { running <- runtime.Run(root) }()
	response := make(chan int, 1)
	go func() {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + runtime.Address())
		if err != nil {
			response <- 0
			return
		}
		_ = res.Body.Close()
		response <- res.StatusCode
	}()
	await(t, entered)
	cancel()
	await(t, relayStarted)
	if state := recorder.Snapshot().State; state != "running" {
		t.Fatalf("recorder sealed before admitted handler stopped: %s", state)
	}
	release()
	if status := await(t, response); status != http.StatusNoContent {
		t.Fatalf("late admitted request failed: %d", status)
	}
	if actual := await(t, written); actual != event {
		t.Fatalf("writer event=%+v want=%+v", actual, event)
	}
	if err := await(t, running); err != nil {
		t.Fatal(err)
	}
	if state := recorder.Snapshot().State; state != "stopped" || !app.ProducersStopped() || !runtime.appClosed {
		t.Fatalf("late event application did not complete: state=%s appClosed=%v", state, runtime.appClosed)
	}
}
