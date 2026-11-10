package session

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type imageRecoveryStorage struct {
	filestorage.Storage
	try func(context.Context, string) (io.Closer, error)
}

func (s imageRecoveryStorage) TryAcquireResidency(ctx context.Context, key string) (io.Closer, error) {
	return s.try(ctx, key)
}

type imageRecoveryCloser func() error

func (f imageRecoveryCloser) Close() error { return f() }

func TestImageLeaseRecoverySkipsLiveOwnersAndRetainsGateThroughConfirmedRelease(t *testing.T) {
	root := t.TempDir()
	first, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	other, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	gate, err := first.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session-resource-lease/live")
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	engine := NewEngine(other)
	leases := []store.SessionResourceLease{{SessionID: "session", ID: "live"}, {SessionID: "other-session", ID: "orphan"}}
	var calls []string
	err = engine.RecoverMediaLeases(t.Context(), leases, func(ctx context.Context, id, lease string) error {
		calls = append(calls, id+"/"+lease)
		_, e := filestorage.TryAcquireMediaLease(ctx, first, "session-resource-lease/"+lease)
		if !errors.Is(e, filestorage.ErrGateBusy) {
			t.Fatalf("release ran without retaining exact gate: %v", e)
		}
		return nil
	})
	if err != nil || !reflect.DeepEqual(calls, []string{"other-session/orphan"}) {
		t.Fatalf("recovery %v: %v", calls, err)
	}
	resumed, err := filestorage.TryAcquireMediaLease(t.Context(), first, "session-resource-lease/orphan")
	if err != nil {
		t.Fatal("confirmed release retained gate", err)
	}
	if err = resumed.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestImageLeaseRecoveryRetainsUnknownCompletionAndCleanupFailures(t *testing.T) {
	cause, closeFailure := errors.New("lease deletion completion unknown"), errors.New("gate close failed")
	for _, point := range []string{"acquire", "release", "close", "both"} {
		t.Run(point, func(t *testing.T) {
			calls := []string{}
			files := imageRecoveryStorage{try: func(ctx context.Context, key string) (io.Closer, error) {
				if ctx != t.Context() || key != "media-lease/session-resource-lease/original" {
					t.Fatal("gate identity changed", key)
				}
				calls = append(calls, "acquire")
				if point == "acquire" {
					return nil, cause
				}
				return imageRecoveryCloser(func() error {
					calls = append(calls, "close")
					if point == "close" || point == "both" {
						return closeFailure
					}
					return nil
				}), nil
			}}
			err := NewEngine(files).RecoverMediaLeases(t.Context(), []store.SessionResourceLease{{SessionID: "session", ID: "original"}, {SessionID: "other", ID: "unvisited"}}, func(ctx context.Context, id, lease string) error {
				calls = append(calls, "release")
				if id != "session" || lease != "original" {
					t.Fatal("release identity changed")
				}
				if point == "release" || point == "both" {
					return cause
				}
				return nil
			})
			if (point == "acquire" || point == "release" || point == "both") && !errors.Is(err, cause) {
				t.Fatal("unknown failure lost", err)
			}
			if (point == "close" || point == "both") && !errors.Is(err, closeFailure) {
				t.Fatal("cleanup failure lost", err)
			}
			want := []string{"acquire", "release", "close"}
			if point == "acquire" {
				want = []string{"acquire"}
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("continued after uncertain recovery: %v", calls)
			}
		})
	}
}

func TestImageIORecoversBeforeRegisteringNewOwnerAndRejectsFailedRecovery(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	engine := NewEngine(files)
	cause := errors.New("recovery transaction unknown")
	engine.SetMediaLeaseRecovery(func(ctx context.Context) error { return cause })
	if _, _, err = engine.beginImageIO(t.Context(), "session", "new"); !errors.Is(err, cause) {
		t.Fatal("failed recovery admitted I/O", err)
	}
	if engine.activeOperations != 0 || len(engine.mediaWork.work) != 0 {
		t.Fatal("failed recovery leaked operation")
	}
	called := false
	engine.SetMediaLeaseRecovery(func(ctx context.Context) error {
		called = true
		if len(engine.mediaWork.work) != 0 {
			t.Fatal("new owner registered before recovery")
		}
		gate, e := filestorage.TryAcquireMediaLease(ctx, files, "session-resource-lease/new")
		if e != nil {
			return e
		}
		return gate.Close()
	})
	_, finish, err := engine.beginImageIO(t.Context(), "session", "new")
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("ordinary admission omitted recovery")
	}
	if err = finish(); err != nil {
		t.Fatal(err)
	}
}

func TestImageIOShutdownCancelsRecoveryBeforeAcquiringItsNewGate(t *testing.T) {
	engine := NewEngine(nil)
	started, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	cleanupFailure := errors.New("media recovery cleanup unknown")
	engine.SetMediaLeaseRecovery(func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(canceled)
		<-release
		return errors.Join(ctx.Err(), cleanupFailure)
	})
	result := make(chan error, 1)
	go func() { _, _, err := engine.beginImageIO(t.Context(), "session", "new"); result <- err }()
	<-started
	stopped := make(chan error, 1)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	go func() { stopped <- engine.Stop(ctx) }()
	<-canceled
	select {
	case err := <-stopped:
		t.Fatal("shutdown released resources before recovery exited", err)
	default:
	}
	close(release)
	if err := <-result; !errors.Is(err, context.Canceled) || !errors.Is(err, cleanupFailure) {
		t.Fatal("shutdown lost recovery failure", err)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	if len(engine.mediaWork.work) != 0 {
		t.Fatal("shutdown admitted a new I/O owner")
	}
}
