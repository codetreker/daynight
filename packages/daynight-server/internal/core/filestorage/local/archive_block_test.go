package local

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
)

func blockNamespace(t *testing.T) sessionarchive.Namespace {
	t.Helper()
	n, err := sessionarchive.NewNamespace(sessionarchive.Projects, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestArchiveBlockPublishAndReuse(t *testing.T) {
	s, root := newStorage(t)
	n, id := blockNamespace(t), uuid.NewString()
	data := []byte("immutable block")
	if err := s.PutArchiveBlock(t.Context(), n, id, 0, data); err != nil {
		t.Fatal(err)
	}
	var syncs []bool
	s.fileSync = func(file *os.File) error {
		info, err := file.Stat()
		if err != nil {
			return err
		}
		syncs = append(syncs, info.IsDir())
		return file.Sync()
	}
	if err := s.PutArchiveBlock(t.Context(), n, id, 0, data); err != nil {
		t.Fatal(err)
	}
	if len(syncs) < 3 || syncs[0] || syncs[1] || !syncs[2] {
		t.Fatalf("reuse did not sync temporary, existing inode and directories: %v", syncs)
	}
	for _, different := range [][]byte{[]byte("immutable blocK"), []byte("short")} {
		err := s.PutArchiveBlock(t.Context(), n, id, 0, different)
		if !errors.Is(err, filestorage.ErrArchiveBlockConflict) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
			t.Fatalf("conflicting block: %v", err)
		}
	}
	name, err := n.BlockPath(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, s, sessionarchive.Bucket, name); string(got) != string(data) {
		t.Fatalf("existing bytes replaced: %q", got)
	}
	assertNoTemporary(t, root)
}

func TestArchiveBlockConcurrentNoReplaceAcrossStorageInstances(t *testing.T) {
	first, root := newStorage(t)
	second, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	n, id := blockNamespace(t), uuid.NewString()
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	for _, s := range []*Storage{first, second} {
		s.fileSync = func(file *os.File) error {
			info, e := file.Stat()
			if e != nil {
				return e
			}
			if !info.IsDir() {
				ready <- struct{}{}
				<-release
			}
			return file.Sync()
		}
	}
	results := make([]error, 2)
	var wg sync.WaitGroup
	for i, s := range []*Storage{first, second} {
		wg.Add(1)
		go func(i int, storage *Storage) {
			defer wg.Done()
			results[i] = storage.PutArchiveBlock(t.Context(), n, id, 0, []byte(fmt.Sprintf("candidate-%d", i)))
		}(i, s)
	}
	<-ready
	<-ready
	close(release)
	wg.Wait()
	winner := -1
	for i, err := range results {
		if err == nil {
			if winner != -1 {
				t.Fatalf("both conflicting writes succeeded: %v", results)
			}
			winner = i
		} else if !errors.Is(err, filestorage.ErrArchiveBlockConflict) {
			t.Fatalf("unexpected result: %v", results)
		}
	}
	if winner == -1 {
		t.Fatalf("no winning publication: %v", results)
	}
	name, _ := n.BlockPath(id, 0)
	if got := string(read(t, first, sessionarchive.Bucket, name)); got != fmt.Sprintf("candidate-%d", winner) {
		t.Fatalf("stored %q, winner %d", got, winner)
	}
	assertNoTemporary(t, root)
}

func TestArchiveBlockFailuresKeepOutcomeAndBytes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		failAt int
		want   filestorage.Publication
	}{
		{"file sync", 1, filestorage.NotPublished},
		{"directory sync", 2, filestorage.Published},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, root := newStorage(t)
			n, id := blockNamespace(t), uuid.NewString()
			failure := errors.New("sync failure")
			calls := 0
			s.fileSync = func(file *os.File) error {
				calls++
				if calls == tc.failAt {
					return failure
				}
				return file.Sync()
			}
			err := s.PutArchiveBlock(t.Context(), n, id, 0, []byte("data"))
			if !errors.Is(err, failure) || filestorage.PublicationOutcome(err) != tc.want {
				t.Fatalf("outcome %q, error %v", filestorage.PublicationOutcome(err), err)
			}
			s.fileSync = (*os.File).Sync
			if err = s.PutArchiveBlock(t.Context(), n, id, 0, []byte("data")); err != nil {
				t.Fatalf("reconcile: %v", err)
			}
			assertNoTemporary(t, root)
		})
	}
	storage, _ := newStorage(t)
	n, id := blockNamespace(t), uuid.NewString()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := storage.PutArchiveBlock(ctx, n, id, 0, []byte("data")); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	for _, invalid := range []struct {
		n      sessionarchive.Namespace
		id     string
		offset int64
		data   []byte
	}{
		{sessionarchive.Namespace{}, id, 0, []byte("a")}, {n, id, 1, []byte("a")}, {n, id, 0, nil},
		{n, id, 0, make([]byte, sessionarchive.BlockSize+1)},
	} {
		if err := storage.PutArchiveBlock(t.Context(), invalid.n, invalid.id, invalid.offset, invalid.data); err == nil {
			t.Fatalf("invalid block accepted: %+v", invalid)
		}
	}
}

type archiveBlockGateFailsOnReuse struct{ calls int }

func (*archiveBlockGateFailsOnReuse) Close() error { return nil }
func (*archiveBlockGateFailsOnReuse) GateContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return ctx, func() {}
}
func (g *archiveBlockGateFailsOnReuse) VerifyGate(context.Context) error {
	g.calls++
	if g.calls == 2 {
		return filestorage.ErrGateLost
	}
	return nil
}

func TestArchiveBlockReuseRequiresInodeSyncAndCurrentGate(t *testing.T) {
	for _, kind := range []string{"inode sync", "gate lost"} {
		t.Run(kind, func(t *testing.T) {
			s, root := newStorage(t)
			n, id := blockNamespace(t), uuid.NewString()
			data := []byte("durable original")
			if err := s.PutArchiveBlock(t.Context(), n, id, 0, data); err != nil {
				t.Fatal(err)
			}
			failure := errors.New("existing inode sync failed")
			calls := 0
			gate := &archiveBlockGateFailsOnReuse{}
			ctx := t.Context()
			if kind == "inode sync" {
				s.fileSync = func(file *os.File) error {
					calls++
					// The temporary inode is synced first; the second sync is the
					// existing inode whose durability the retry must prove.
					if calls == 2 {
						return failure
					}
					return file.Sync()
				}
			} else {
				var cancel context.CancelFunc
				ctx, cancel = filestorage.GateContext(ctx, gate)
				defer cancel()
				failure = filestorage.ErrGateLost
			}
			err := s.PutArchiveBlock(ctx, n, id, 0, data)
			if !errors.Is(err, failure) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
				t.Fatalf("unconfirmed reuse: %v", err)
			}
			if kind == "gate lost" && gate.calls != 2 {
				t.Fatalf("gate was not rechecked before reuse: %d", gate.calls)
			}
			s.fileSync = (*os.File).Sync
			if err = s.PutArchiveBlock(t.Context(), n, id, 0, data); err != nil {
				t.Fatalf("reuse retry: %v", err)
			}
			name, _ := n.BlockPath(id, 0)
			if got := read(t, s, sessionarchive.Bucket, name); string(got) != string(data) {
				t.Fatalf("retry changed original: %q", got)
			}
			assertNoTemporary(t, root)
		})
	}
}

func TestArchiveBlockReuseRejectsCancelledReadAndSymlink(t *testing.T) {
	s, root := newStorage(t)
	n, id := blockNamespace(t), uuid.NewString()
	data := []byte("durable original")
	if err := s.PutArchiveBlock(t.Context(), n, id, 0, data); err != nil {
		t.Fatal(err)
	}
	name, _ := n.BlockPath(id, 0)
	address := sessionarchive.Bucket + "/" + name
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	s.namespace.Lock()
	err := s.verifyExistingArchiveBlock(ctx, address, data)
	s.namespace.Unlock()
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled verification: %v", err)
	}
	fullPath := filepath.Join(root, filepath.FromSlash(address))
	if err := os.Remove(fullPath); err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(root, "protected")
	if err := os.WriteFile(protected, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(protected, fullPath); err != nil {
		t.Fatal(err)
	}
	s.namespace.Lock()
	err = s.verifyExistingArchiveBlock(t.Context(), address, data)
	s.namespace.Unlock()
	if !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("existing symlink accepted: %v", err)
	}
	if got, err := os.ReadFile(protected); err != nil || string(got) != string(data) {
		t.Fatalf("protected file changed: %q, %v", got, err)
	}
}

type revokedArchiveBlockGate struct{}

func (revokedArchiveBlockGate) Close() error { return nil }
func (revokedArchiveBlockGate) GateContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return ctx, func() {}
}
func (revokedArchiveBlockGate) VerifyGate(context.Context) error { return filestorage.ErrGateLost }

func TestArchiveBlockRejectsLostGateAndSymlink(t *testing.T) {
	s, root := newStorage(t)
	n, id := blockNamespace(t), uuid.NewString()
	ctx, cancel := filestorage.GateContext(t.Context(), revokedArchiveBlockGate{})
	defer cancel()
	err := s.PutArchiveBlock(ctx, n, id, 0, []byte("data"))
	if !errors.Is(err, filestorage.ErrGateLost) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatalf("lost gate: %v", err)
	}
	name, _ := n.BlockPath(id, 0)
	if _, err = s.Open(t.Context(), sessionarchive.Bucket, name); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("lost gate published a block: %v", err)
	}
	assertNoTemporary(t, root)
	address := filepath.Join(root, sessionarchive.Bucket, filepath.FromSlash(name))
	if err = os.MkdirAll(filepath.Dir(address), 0o700); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(filepath.Join(root, "outside"), address); err != nil {
		t.Fatal(err)
	}
	err = s.PutArchiveBlock(t.Context(), n, id, 0, []byte("data"))
	if !errors.Is(err, filestorage.ErrNotRegular) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatalf("symlink accepted: %v", err)
	}
	assertNoTemporary(t, root)
}

func TestDeleteArchiveBlockPreservesOtherBlocksAndConfirmsAbsence(t *testing.T) {
	s, _ := newStorage(t)
	n, id := blockNamespace(t), uuid.NewString()
	if err := s.PutArchiveBlock(t.Context(), n, id, 0, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := s.PutArchiveBlock(t.Context(), n, id, sessionarchive.BlockSize, []byte("second")); err != nil {
		t.Fatal(err)
	}
	count := 0
	s.fileSync = func(file *os.File) error {
		info, err := file.Stat()
		if err != nil || !info.IsDir() {
			t.Fatalf("expected directory barrier: %v", err)
		}
		count++
		return file.Sync()
	}
	if err := s.DeleteArchiveBlock(t.Context(), n, id, 0); err != nil {
		t.Fatal(err)
	}
	if count < 2 {
		t.Fatal("deletion did not sync parent directories", count)
	}
	first, _ := n.BlockPath(id, 0)
	if obj, err := s.Open(t.Context(), sessionarchive.Bucket, first); !errors.Is(err, fs.ErrNotExist) {
		if err == nil {
			_ = obj.Body.Close()
		}
		t.Fatal("deleted block remains", err)
	}
	second, _ := n.BlockPath(id, sessionarchive.BlockSize)
	if got := read(t, s, sessionarchive.Bucket, second); string(got) != "second" {
		t.Fatal("another block changed", string(got))
	}
	count = 0
	if err := s.DeleteArchiveBlock(t.Context(), n, id, 0); err != nil || count < 2 {
		t.Fatal("missing block lacked durability barriers", count, err)
	}
}

func TestDeleteArchiveBlockSyncFailureRemainsRetryable(t *testing.T) {
	for _, failAt := range []int{1, 2} {
		t.Run(fmt.Sprintf("barrier-%d", failAt), func(t *testing.T) {
			s, _ := newStorage(t)
			n, id := blockNamespace(t), uuid.NewString()
			if err := s.PutArchiveBlock(t.Context(), n, id, 0, []byte("data")); err != nil {
				t.Fatal(err)
			}
			failure := errors.New("directory sync failed")
			calls := 0
			s.fileSync = func(file *os.File) error {
				calls++
				if calls == failAt {
					return failure
				}
				return file.Sync()
			}
			if err := s.DeleteArchiveBlock(t.Context(), n, id, 0); !errors.Is(err, failure) {
				t.Fatal("failed sync reported durable deletion", err)
			}
			calls = 0
			s.fileSync = func(*os.File) error { calls++; return failure }
			if err := s.DeleteArchiveBlock(t.Context(), n, id, 0); !errors.Is(err, failure) || calls != 1 {
				t.Fatal("absence retry bypassed the barrier", calls, err)
			}
			s.fileSync = (*os.File).Sync
			if err := s.DeleteArchiveBlock(t.Context(), n, id, 0); err != nil {
				t.Fatal("retry failed", err)
			}
		})
	}
}

func TestDeleteArchiveBlockRejectsLostGateAndAliases(t *testing.T) {
	s, root := newStorage(t)
	n, id := blockNamespace(t), uuid.NewString()
	if err := s.PutArchiveBlock(t.Context(), n, id, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := filestorage.GateContext(t.Context(), revokedArchiveBlockGate{})
	defer cancel()
	if err := s.DeleteArchiveBlock(ctx, n, id, 0); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatal("lost gate allowed deletion", err)
	}
	name, _ := n.BlockPath(id, 0)
	if got := read(t, s, sessionarchive.Bucket, name); string(got) != "data" {
		t.Fatal("lost gate removed block", string(got))
	}
	address := filepath.Join(root, sessionarchive.Bucket, filepath.FromSlash(name))
	if err := os.Remove(address); err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(root, "protected")
	if err := os.WriteFile(protected, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(protected, address); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteArchiveBlock(t.Context(), n, id, 0); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatal("symlink accepted", err)
	}
	if got, err := os.ReadFile(protected); err != nil || string(got) != "keep" {
		t.Fatal("protected file changed", string(got), err)
	}
	if err := s.DeleteArchiveBlock(t.Context(), n, id, 1); err == nil {
		t.Fatal("unaligned offset accepted")
	}
}

func TestDeleteArchiveStagingUsesDurableAbsenceForEachBucket(t *testing.T) {
	for _, kind := range []string{"archive", "resource"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := newStorage(t)
			project, session, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
			var bucket, name, other string
			if kind == "archive" {
				n, err := sessionarchive.NewNamespace(sessionarchive.Projects, project, session)
				if err != nil {
					t.Fatal(err)
				}
				bucket = sessionarchive.Bucket
				name = n.Directory() + "/files/" + id + "/content"
				other = n.Directory() + "/files/" + uuid.NewString() + "/content"
			} else {
				n, err := sessionresource.NewNamespace(project, "", session)
				if err != nil {
					t.Fatal(err)
				}
				bucket = sessionresource.Bucket
				name, _ = n.BlobPath(id)
				other, _ = n.BlobPath(uuid.NewString())
			}
			put(t, s, bucket, name, []byte("candidate"))
			put(t, s, bucket, other, []byte("keep"))
			failure := errors.New("sync failed")
			calls := 0
			s.fileSync = func(*os.File) error { calls++; return failure }
			if err := s.DeleteArchiveStaging(t.Context(), bucket, name); !errors.Is(err, failure) {
				t.Fatal("sync failure hidden", err)
			}
			if err := s.DeleteArchiveStaging(t.Context(), bucket, name); !errors.Is(err, failure) || calls != 2 {
				t.Fatal("missing retry skipped sync", calls, err)
			}
			s.fileSync = (*os.File).Sync
			if err := s.DeleteArchiveStaging(t.Context(), bucket, name); err != nil {
				t.Fatal(err)
			}
			if got := read(t, s, bucket, other); string(got) != "keep" {
				t.Fatal("other object changed", string(got))
			}
		})
	}
}

func TestDeleteArchiveStagingRejectsOtherAddresses(t *testing.T) {
	s, _ := newStorage(t)
	n, id := blockNamespace(t), uuid.NewString()
	for _, candidate := range []struct{ bucket, path string }{
		{"other", n.Directory() + "/files/" + id + "/content"},
		{sessionarchive.Bucket, n.Directory() + "/files/" + id + "/chunks/0"},
		{sessionarchive.Bucket, n.Directory() + "/files/" + id + "/../content"},
		{sessionresource.Bucket, n.Directory() + "/uploads/" + id},
		{sessionresource.Bucket, n.Directory() + "/blobs/not-a-uuid"},
	} {
		if err := s.DeleteArchiveStaging(t.Context(), candidate.bucket, candidate.path); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("invalid address accepted: %+v: %v", candidate, err)
		}
	}
}
