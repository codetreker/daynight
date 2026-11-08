package mcpdownload

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/google/uuid"
)

type pausedStorage struct {
	filestorage.TransferStorage
	started chan struct{}
	release chan struct{}
}

func (s *pausedStorage) PutTransfer(ctx context.Context, n filestorage.TransferNamespace, id string, body io.Reader) (filestorage.FileInfo, error) {
	close(s.started)
	select {
	case <-ctx.Done():
		return filestorage.FileInfo{}, ctx.Err()
	case <-s.release:
		return s.TransferStorage.PutTransfer(ctx, n, id, body)
	}
}
func TestStreamUTF8Classification(t *testing.T) {
	for _, data := range [][]byte{[]byte("abc界😀"), []byte("abc\xff"), []byte("abc\xe7\x95"), []byte("\xef\xbf\xbd"), {}} {
		for split := 0; split <= len(data); split++ {
			v := &utf8Stream{}
			_, _ = v.Write(data[:split])
			_, _ = v.Write(data[split:])
			if v.Valid() != utf8.Valid(data) {
				t.Fatalf("%q at %d: %v", data, split, v.Valid())
			}
		}
	}
}
func TestAutoChecksEntireSnapshot(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("ascii then \xff"))
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	f.read(t, in)
	in.Action = "chunk"
	in.Offset = "0"
	in.MaxBytes = 3
	r := f.read(t, in)
	if r["text"] != nil || r["requiresExplicitBinaryRead"] != true || r["contentIncluded"] != false {
		t.Fatalf("binary suffix: %#v", r)
	}
	f.put(t, []byte("界"))
	in.Action = "open"
	in.TransferID = uuid.NewString()
	in.MaxBytes = 0
	f.read(t, in)
	in.Action = "chunk"
	in.Offset = "0"
	in.MaxBytes = 1
	if _, err := f.service.Read(t.Context(), f.actor, in); err == nil {
		t.Fatal("incomplete character must fail")
	}
}
func TestSnapshotRenewsAndJoinsBeforePublication(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("text"))
	f.service.renewInterval = 10 * time.Millisecond
	wrapped := &pausedStorage{TransferStorage: f.service.files, started: make(chan struct{}), release: make(chan struct{})}
	f.service.files = wrapped
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	result := make(chan error, 1)
	go func() { _, err := f.service.Read(t.Context(), f.actor, in); result <- err }()
	select {
	case <-wrapped.started:
	case <-time.After(5 * time.Second):
		t.Fatal("copy did not start")
	}
	before, err := f.lifecycle.LookupBound(t.Context(), f.actor, in.TransferID)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		now, err := f.lifecycle.LookupBound(t.Context(), f.actor, in.TransferID)
		if err != nil {
			t.Fatal(err)
		}
		if now.Version > before.Version {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("renewal did not advance version")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Duplicate status renews without waiting for the blocked I/O gate.
	duplicate := f.read(t, in)
	if duplicate["state"] != "preparing" {
		t.Fatalf("duplicate: %#v", duplicate)
	}
	close(wrapped.release)
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("copy did not finish")
	}
	r := f.read(t, in)
	if r["state"] != "readable" {
		t.Fatalf("publication lost CAS race: %#v", r)
	}
}
func TestSnapshotRenewalRevocationCancelsCopy(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("text"))
	f.service.renewInterval = 10 * time.Millisecond
	wrapped := &pausedStorage{TransferStorage: f.service.files, started: make(chan struct{}), release: make(chan struct{})}
	f.service.files = wrapped
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	result := make(chan error, 1)
	go func() { _, err := f.service.Read(t.Context(), f.actor, in); result <- err }()
	select {
	case <-wrapped.started:
	case <-time.After(5 * time.Second):
		t.Fatal("copy did not start")
	}
	if _, err := f.db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("revoked copy succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revocation did not cancel copy")
	}
}
func TestFailedSourceDoesNotConsumeSlots(t *testing.T) {
	f := newFixture(t)
	in := f.input
	in.Action = "open"
	for i := 0; i < 5; i++ {
		in.TransferID = uuid.NewString()
		_, err := f.service.Read(t.Context(), f.actor, in)
		if err == nil || errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("missing source %d: %v", i, err)
		}
	}
	f.put(t, []byte("works"))
	in.TransferID = uuid.NewString()
	r := f.read(t, in)
	if r["state"] != "readable" {
		t.Fatalf("slots not reclaimed: %#v", r)
	}
}

func TestSnapshotRenewsWhileWaitingForPrivateGate(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("text"))
	f.service.renewInterval = 10 * time.Millisecond
	in := f.input
	in.Action, in.TransferID = "open", uuid.NewString()
	store := f.service.files.(filestorage.Storage)
	gate, err := store.AcquireGate(t.Context(), filestorage.PrivateGate, in.TransferID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if gate != nil {
			_ = gate.Close()
		}
	}()
	result := make(chan error, 1)
	go func() { _, err := f.service.Read(t.Context(), f.actor, in); result <- err }()
	deadline := time.Now().Add(5 * time.Second)
	var firstVersion int64
	for time.Now().Before(deadline) {
		r, err := f.lifecycle.LookupBound(t.Context(), f.actor, in.TransferID)
		if err == nil {
			if firstVersion == 0 {
				firstVersion = r.Version
			} else if r.Version > firstVersion {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	if firstVersion == 0 || time.Now().After(deadline) {
		t.Fatal("renewal did not progress while waiting for gate")
	}
	select {
	case err := <-result:
		t.Fatalf("open finished before gate release: %v", err)
	default:
	}
	if err := gate.Close(); err != nil {
		t.Fatal(err)
	}
	gate = nil
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("open did not finish")
	}
}
