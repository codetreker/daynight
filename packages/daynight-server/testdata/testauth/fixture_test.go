package testauth

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeFixtureProcess struct {
	signal func(os.Signal) error
	kill   func() error
}

func (p fakeFixtureProcess) Signal(value os.Signal) error { return p.signal(value) }
func (p fakeFixtureProcess) Kill() error                  { return p.kill() }

func TestStopFixtureProcess(t *testing.T) {
	t.Run("already exited", func(t *testing.T) {
		done := make(chan struct{})
		close(done)
		calls := 0
		process := fakeFixtureProcess{signal: func(os.Signal) error { calls++; return nil }, kill: func() error { calls++; return nil }}
		stopped, err := stopFixtureProcess(process, done, true, time.Millisecond, time.Millisecond)
		if !stopped || err != nil || calls != 0 {
			t.Fatal("already exited fixture was signaled or not reaped")
		}
	})
	t.Run("graceful exit", func(t *testing.T) {
		done := make(chan struct{})
		killed := false
		process := fakeFixtureProcess{signal: func(os.Signal) error { close(done); return nil }, kill: func() error { killed = true; return nil }}
		stopped, err := stopFixtureProcess(process, done, true, time.Millisecond, time.Millisecond)
		if !stopped || err != nil || killed {
			t.Fatal("graceful fixture exit was not confirmed")
		}
	})
	t.Run("forced exit", func(t *testing.T) {
		done := make(chan struct{})
		process := fakeFixtureProcess{signal: func(os.Signal) error { return nil }, kill: func() error { close(done); return nil }}
		stopped, err := stopFixtureProcess(process, done, true, time.Millisecond, time.Millisecond)
		if !stopped || err == nil || !strings.Contains(err.Error(), "graceful shutdown") {
			t.Fatal("forced fixture exit was not reported")
		}
	})
	t.Run("kill failure and no exit", func(t *testing.T) {
		done := make(chan struct{})
		failure := errors.New("kill failed")
		process := fakeFixtureProcess{signal: func(os.Signal) error { return nil }, kill: func() error { return failure }}
		stopped, err := stopFixtureProcess(process, done, true, time.Millisecond, time.Millisecond)
		if stopped || !errors.Is(err, failure) || !strings.Contains(err.Error(), "could not be reaped") {
			t.Fatal("unconfirmed fixture exit was not preserved")
		}
	})
}

func TestFixtureCleanupGuard(t *testing.T) {
	done := make(chan struct{})
	calls := 0
	process := fakeFixtureProcess{signal: func(os.Signal) error { calls++; return nil }, kill: func() error { calls++; return nil }}
	stopped, err := stopFixtureProcess(process, done, false, time.Millisecond, time.Millisecond)
	if stopped || err == nil || calls != 0 {
		t.Fatal("a live owning service did not retain the gateway")
	}
	directory := filepath.Join(t.TempDir(), "owned")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	ownerStopped := false
	fixture := &Fixture{started: true, exited: done, directory: directory, canStop: func() bool { return ownerStopped }}
	if fixture.CleanupConfirmed() {
		t.Fatal("running fixture claimed cleanup")
	}
	close(done)
	if fixture.canRemoveDirectory() {
		t.Fatal("exited gateway bypassed a live owning service")
	}
	if err := removeFixtureDirectory(directory, fixture.canRemoveDirectory()); err == nil {
		t.Fatal("live owner permitted directory removal")
	}
	if _, err := os.Stat(directory); err != nil {
		t.Fatal("live owner did not retain the fixture directory")
	}
	ownerStopped = true
	if !fixture.canRemoveDirectory() || fixture.CleanupConfirmed() {
		t.Fatal("stopped gateway with directory should be removable, not removed")
	}
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	if !fixture.CleanupConfirmed() {
		t.Fatal("stopped and removed fixture did not confirm cleanup")
	}
}

func TestFixtureDirectoryRequiresStoppedProcess(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "owned")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := removeFixtureDirectory(directory, false); err == nil {
		t.Fatal("active fixture directory was removed")
	}
	if _, err := os.Stat(directory); err != nil {
		t.Fatal("unconfirmed fixture directory was not retained")
	}
	if err := removeFixtureDirectory(directory, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stopped fixture directory was not removed")
	}
}
