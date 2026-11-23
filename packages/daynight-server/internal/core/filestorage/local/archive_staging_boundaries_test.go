//go:build linux

package local

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/google/uuid"
)

func stagingBoundaryFixture(t *testing.T) (*Storage, filestorage.ArchiveStaging, sessionarchive.Namespace, string, string) {
	t.Helper()
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := s.EnableArchiveStaging(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})
	return s, h, n, uuid.NewString(), root
}

func TestArchiveStagingRejectsInvalidAndCanceledOperations(t *testing.T) {
	s, h, n, id, root := stagingBoundaryFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.AcquireArchiveStaging(ctx, n, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled acquire: %v", err)
	}
	if _, err := s.AcquireArchiveStaging(t.Context(), sessionarchive.Namespace{}, false); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid namespace: %v", err)
	}
	if err := h.Create(ctx, id); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled create: %v", err)
	}
	if err := h.Create(t.Context(), "../bad"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid create: %v", err)
	}
	if _, err := h.Observe(t.Context(), "../bad", 4); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid observation: %v", err)
	}
	if err := h.Delete(t.Context(), id); err != nil {
		t.Fatalf("missing staging directory cleanup: %v", err)
	}
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []struct {
		expected int64
		data     string
	}{{0, ""}, {0, "bad"}, {5, "bad"}, {-1, "bad"}} {
		if _, err := h.Append(t.Context(), id, 4, bad.expected, []byte(bad.data)); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
			t.Fatalf("invalid append %+v: %v", bad, err)
		}
	}
	if _, err := h.Append(t.Context(), uuid.NewString(), 4, 0, []byte("data")); !errors.Is(err, filestorage.ErrArchiveStagingMissing) {
		t.Fatalf("missing append: %v", err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
		t.Fatalf("wrong durable offset: %v", err)
	}
	if _, err := h.Observe(t.Context(), id, 3); !errors.Is(err, filestorage.ErrArchiveStagingCorrupt) {
		t.Fatalf("overlong staging: %v", err)
	}
	missing := uuid.NewString()
	if err := h.Delete(t.Context(), missing); err != nil {
		t.Fatalf("idempotent missing delete: %v", err)
	}
	stage, err := filestorage.ArchiveStagingPath(n, id)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, sessionarchive.Bucket, stage))
	if err != nil || string(got) != "data" {
		t.Fatalf("invalid requests changed data: %q %v", got, err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Observe(t.Context(), id, 4); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed handle: %v", err)
	}
}

func TestArchiveStagingFileAndDirectoryFailuresRemainVisible(t *testing.T) {
	s, h, n, id, root := stagingBoundaryFixture(t)
	stage := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging")
	if err := os.Symlink(root, stage); err != nil {
		t.Fatal(err)
	}
	if err := h.Create(t.Context(), id); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("staging symlink: %v", err)
	}
	if err := os.Remove(stage); err != nil {
		t.Fatal(err)
	}
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(stage, id)
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("file sync failed")
	s.fileSync = func(f *os.File) error {
		got, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(info, got) {
			return failure
		}
		return f.Sync()
	}
	if _, err := h.Observe(t.Context(), id, 4); !errors.Is(err, failure) {
		t.Fatalf("status hid sync failure: %v", err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); !errors.Is(err, failure) {
		t.Fatalf("append hid sync failure: %v", err)
	}
	s.fileSync = (*os.File).Sync
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, file); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Observe(t.Context(), id, 4); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("file symlink: %v", err)
	}
	if err := h.Delete(t.Context(), id); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("delete file symlink: %v", err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := h.Delete(t.Context(), id); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveStagingReadOnlyObservesPairedBackup(t *testing.T) {
	_, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := OpenReadOnly(root)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	object, err := r.OpenArchiveStaging(t.Context(), n, id)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(object.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err = object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if string(data) != "data" || object.Info.Size != 4 {
		t.Fatalf("backup read %q size=%d", data, object.Info.Size)
	}
	if _, err = r.OpenArchiveStaging(t.Context(), n, "invalid"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid id: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err = r.OpenArchiveStaging(ctx, n, id); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled read: %v", err)
	}
	if _, err = r.OpenArchiveStaging(t.Context(), n, uuid.NewString()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing read: %v", err)
	}
}

func TestArchivePublicationProtectsTargetsAndReportsOutcome(t *testing.T) {
	s, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	target := n.Directory() + "/files/" + id + "/content"
	for _, bad := range []struct{ file, bucket, path string }{
		{"invalid", sessionarchive.Bucket, target}, {id, "wrong", target}, {id, sessionarchive.Bucket, n.Directory() + "/files/foreign/content"}, {id, "session-resources", n.Directory() + "/blobs/foreign"},
	} {
		_, err := h.Publish(t.Context(), bad.file, 4, bad.bucket, bad.path)
		if !errors.Is(err, filestorage.ErrInvalidAddress) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
			t.Fatalf("invalid target %+v: %v", bad, err)
		}
	}
	dest := filepath.Join(root, sessionarchive.Bucket, n.Directory(), "files", id)
	if err := os.MkdirAll(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(root, "foreign")
	if err := os.WriteFile(foreign, []byte("foreign"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(foreign, filepath.Join(dest, "content")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Publish(t.Context(), id, 4, sessionarchive.Bucket, target); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("hardlinked destination: %v", err)
	}
	if err := os.Remove(filepath.Join(dest, "content")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dest, "content"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging", id)
	stageInfo, err := os.Stat(stage)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("publication file sync failed")
	s.fileSync = func(f *os.File) error {
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if info.Mode().IsRegular() && !os.SameFile(info, stageInfo) {
			return failure
		}
		return f.Sync()
	}
	if _, err = h.Publish(t.Context(), id, 4, sessionarchive.Bucket, target); !errors.Is(err, failure) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatalf("sync failure outcome: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "content"))
	if err != nil || string(got) != "old" {
		t.Fatalf("failed publish changed target: %q %v", got, err)
	}
	s.fileSync = (*os.File).Sync
	if _, err = h.Publish(t.Context(), id, 4, sessionarchive.Bucket, target); err != nil {
		t.Fatal(err)
	}
	got, err = os.ReadFile(filepath.Join(dest, "content"))
	if err != nil || string(got) != "data" {
		t.Fatalf("successful publish: %q %v", got, err)
	}
	got, err = os.ReadFile(foreign)
	if err != nil || string(got) != "foreign" {
		t.Fatalf("foreign alias changed: %q %v", got, err)
	}
}

func TestArchivePublicationFailureAfterRenameReportsPublished(t *testing.T) {
	s, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	target := n.Directory() + "/files/" + id + "/content"
	dest := filepath.Join(root, sessionarchive.Bucket, n.Directory(), "files", id)
	if err := os.MkdirAll(dest, 0o700); err != nil {
		t.Fatal(err)
	}
	dirInfo, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("post-publication directory sync failed")
	calls := 0
	s.fileSync = func(f *os.File) error {
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(info, dirInfo) {
			calls++
			if calls == 2 {
				return failure
			}
		}
		return f.Sync()
	}
	_, err = h.Publish(t.Context(), id, 4, sessionarchive.Bucket, target)
	if !errors.Is(err, failure) || filestorage.PublicationOutcome(err) != filestorage.Published {
		t.Fatalf("post-rename outcome: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "content"))
	if err != nil || string(got) != "data" {
		t.Fatalf("published bytes: %q %v", got, err)
	}
}

func TestArchivePublicationRequiresCompleteExistingStaging(t *testing.T) {
	_, h, n, id, _ := stagingBoundaryFixture(t)
	target := n.Directory() + "/files/" + id + "/content"
	if _, err := h.Publish(t.Context(), id, 4, sessionarchive.Bucket, target); !errors.Is(err, filestorage.ErrArchiveStagingMissing) {
		t.Fatalf("missing staging: %v", err)
	}
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Publish(t.Context(), id, 4, sessionarchive.Bucket, target); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
		t.Fatalf("incomplete staging: %v", err)
	}
	if err := h.Create(t.Context(), uuid.NewString()); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("open read did not freeze handle: %v", err)
	}
	if err := h.AdoptEmpty(t.Context(), id); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("frozen adoption: %v", err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("frozen append: %v", err)
	}
}

func TestArchiveAppendSyncFailureRequiresOffsetObservation(t *testing.T) {
	s, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging", id)
	stageInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("appended data sync failed")
	calls := 0
	s.fileSync = func(f *os.File) error {
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(info, stageInfo) {
			calls++
			if calls == 2 {
				return failure
			}
		}
		return f.Sync()
	}
	if _, err = h.Append(t.Context(), id, 4, 0, []byte("data")); !errors.Is(err, failure) {
		t.Fatalf("append failure hidden: %v", err)
	}
	s.fileSync = (*os.File).Sync
	offset, err := h.Observe(t.Context(), id, 4)
	if err != nil || offset != 4 {
		t.Fatalf("reconciliation offset=%d err=%v", offset, err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "data" {
		t.Fatalf("received bytes=%q err=%v", got, err)
	}
}

func TestArchiveAcquireRespectsRootLockAndUnsafePaths(t *testing.T) {
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.EnableArchiveStaging(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	lock, err := s.root.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			if err := lock.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	if err = lockArchiveDirectory(lock); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("root contention: %v", err)
	}
	err = errors.Join(unlockArchiveDirectory(lock), lock.Close())
	closed = true
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(root, filepath.Join(root, sessionarchive.Bucket)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("archive namespace symlink: %v", err)
	}
	if err = os.Remove(filepath.Join(root, sessionarchive.Bucket)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	previous := s.fileSync
	s.fileSync = func(f *os.File) error { cancel(); return previous(f) }
	if _, err = s.AcquireArchiveStaging(ctx, n, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled initialization: %v", err)
	}
	s.fileSync = previous
	guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveAdoptionRejectsInvalidIdentityAndCorruptObjects(t *testing.T) {
	_, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.AdoptEmpty(t.Context(), "../bad"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid identity: %v", err)
	}
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging", id)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, path); err != nil {
		t.Fatal(err)
	}
	if err := h.AdoptEmpty(t.Context(), id); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("symlink adoption: %v", err)
	}
}

func TestArchiveMountChecksRejectClosedAndForeignDescriptors(t *testing.T) {
	s, _, _, _, _ := stagingBoundaryFixture(t)
	file, err := s.root.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = archiveMountID(file); err == nil {
		t.Fatal("closed mount descriptor accepted")
	}
	if err = s.checkArchiveFileMount(file); err == nil {
		t.Fatal("closed file mount accepted")
	}
	dir, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = dir.Close(); err != nil {
		t.Fatal(err)
	}
	if err = archiveReadDirectoryMount(1, dir); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed directory: %v", err)
	}
	foreign, err := os.Open("/dev/shm")
	if err != nil {
		t.Skipf("no alternate mount: %v", err)
	}
	defer foreign.Close()
	if err = s.checkArchiveFileMount(foreign); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("foreign mount accepted: %v", err)
	}
}

func TestArchiveVolumeRequiresWorkingProcessProbe(t *testing.T) {
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	t.Setenv("PATH", "")
	if err = s.EnableArchiveStaging(t.Context(), true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("missing probe accepted: %v", err)
	}
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("failed probe left capability enabled: %v", err)
	}
}

func TestArchivePublicationRejectsUnreadableExistingTarget(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	_, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	path := n.Directory() + "/files/" + id + "/content"
	dest := filepath.Join(root, sessionarchive.Bucket, path)
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, []byte("old"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dest, 0o600) })
	if _, err := h.Publish(t.Context(), id, 4, sessionarchive.Bucket, path); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("unreadable target accepted: %v", err)
	}
	if err := os.Chmod(dest, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(dest); err != nil || string(got) != "old" {
		t.Fatalf("target changed: %q %v", got, err)
	}
}

func TestArchiveAcquireRejectsUnwritableNamespace(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.EnableArchiveStaging(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	bucket := filepath.Join(root, sessionarchive.Bucket)
	if err = os.Mkdir(bucket, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(bucket, 0o700) })
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("unwritable namespace: %v", err)
	}
	if err = os.Chmod(bucket, 0o700); err != nil {
		t.Fatal(err)
	}
	h, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveAdoptionRejectsFileChangedDuringSync(t *testing.T) {
	s, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging", id)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	s.fileSync = func(f *os.File) error {
		stat, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(stat, info) {
			if _, e = f.Write([]byte("x")); e != nil {
				return e
			}
		}
		return f.Sync()
	}
	if err = h.AdoptEmpty(t.Context(), id); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
		t.Fatalf("changed file adopted: %v", err)
	}
	s.fileSync = (*os.File).Sync
	if got, err := os.ReadFile(path); err != nil || string(got) != "x" {
		t.Fatalf("external byte not retained: %q %v", got, err)
	}
}

func TestArchiveClosedResourcesCannotBeEnabledOrPublished(t *testing.T) {
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if err = s.EnableArchiveStaging(t.Context(), true); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed root enabled: %v", err)
	}
	other, _, _, _, _ := stagingBoundaryFixture(t)
	dir, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = dir.Close(); err != nil {
		t.Fatal(err)
	}
	guard := &ArchiveStaging{storage: other}
	if err = guard.validPublishTarget(dir, "content"); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed target directory accepted: %v", err)
	}
}

func TestArchiveClosedStorageCannotAcquireStaging(t *testing.T) {
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.EnableArchiveStaging(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed storage acquired: %v", err)
	}
}

func TestArchiveAdoptionCannotConfirmClosedFile(t *testing.T) {
	s, h, n, id, root := stagingBoundaryFixture(t)
	if err := h.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging", id)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	s.fileSync = func(f *os.File) error {
		stat, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(stat, info) {
			return errors.Join(f.Sync(), f.Close())
		}
		return f.Sync()
	}
	if err = h.AdoptEmpty(t.Context(), id); err == nil {
		t.Fatal("closed file adopted")
	}
	s.fileSync = (*os.File).Sync
	if err = h.AdoptEmpty(t.Context(), id); err != nil {
		t.Fatalf("adoption retry: %v", err)
	}
}

func TestArchiveObservationDoesNotTreatInaccessibleStagingAsMissing(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	_, guard, namespace, id, root := stagingBoundaryFixture(t)
	if err := guard.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := guard.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, sessionarchive.Bucket, namespace.Directory(), ".staging")
	if err := os.Chmod(directory, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o700) })
	if _, err := guard.Observe(t.Context(), id, 4); !errors.Is(err, fs.ErrPermission) || errors.Is(err, filestorage.ErrArchiveStagingMissing) {
		t.Fatalf("inaccessible staging reported as missing: %v", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if offset, err := guard.Observe(t.Context(), id, 4); err != nil || offset != 4 {
		t.Fatalf("staging changed after access was restored: offset=%d err=%v", offset, err)
	}
	file := filepath.Join(directory, id)
	if err := os.Chmod(file, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(file, 0o600) })
	if _, err := guard.Observe(t.Context(), id, 4); !errors.Is(err, fs.ErrPermission) || errors.Is(err, filestorage.ErrArchiveStagingMissing) {
		t.Fatalf("unreadable staging file reported as missing: %v", err)
	}
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	if offset, err := guard.Observe(t.Context(), id, 4); err != nil || offset != 4 {
		t.Fatalf("staging changed after file access was restored: offset=%d err=%v", offset, err)
	}
}

type stagingExpiringPermit struct {
	checks int
	err    error
}

func (*stagingExpiringPermit) Close() error { return nil }

func (*stagingExpiringPermit) GateContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return ctx, func() {}
}

func (p *stagingExpiringPermit) CheckGate() error {
	p.checks++
	if p.checks > 1 {
		return p.err
	}
	return nil
}

func TestArchiveObservationReportsLostAdmissionInsteadOfMissing(t *testing.T) {
	for _, tc := range []struct {
		name          string
		createDir     bool
		fileAvailable bool
	}{
		{name: "missing staging directory"},
		{name: "missing staging file", createDir: true},
		{name: "present staging file", createDir: true, fileAvailable: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, guard, _, id, _ := stagingBoundaryFixture(t)
			if tc.createDir {
				if err := guard.Create(t.Context(), id); err != nil {
					t.Fatal(err)
				}
				if tc.fileAvailable {
					if _, err := guard.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
						t.Fatal(err)
					}
				} else if err := guard.Delete(t.Context(), id); err != nil {
					t.Fatal(err)
				}
			}
			lost := errors.New("archive admission lost")
			permit := &stagingExpiringPermit{err: lost}
			ctx, cancel := filestorage.GateContext(t.Context(), permit)
			defer cancel()
			if _, err := guard.Observe(ctx, id, 4); !errors.Is(err, lost) || errors.Is(err, filestorage.ErrArchiveStagingMissing) {
				t.Fatalf("lost admission was hidden: %v", err)
			}
			if tc.fileAvailable {
				if offset, err := guard.Observe(t.Context(), id, 4); err != nil || offset != 4 {
					t.Fatalf("failed observation changed staging: offset=%d err=%v", offset, err)
				}
			}
		})
	}
}

func TestArchiveOpenRejectsUnverifiedVolumeOnExistingHandle(t *testing.T) {
	s, guard, _, id, root := stagingBoundaryFixture(t)
	if err := guard.Create(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := guard.Append(t.Context(), id, 4, 0, []byte("data")); err != nil {
		t.Fatal(err)
	}
	moved := root + "-moved"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	movedBack := false
	t.Cleanup(func() {
		if !movedBack {
			if err := os.Rename(moved, root); err != nil {
				t.Error(err)
			}
		}
	})
	if err := s.EnableArchiveStaging(t.Context(), true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("reverification accepted missing volume: %v", err)
	}
	if _, err := guard.Observe(t.Context(), id, 4); !errors.Is(err, ErrArchiveVolumeUnverified) || errors.Is(err, filestorage.ErrArchiveStagingMissing) {
		t.Fatalf("existing handle treated unavailable volume as missing: %v", err)
	}
	if err := os.Rename(moved, root); err != nil {
		t.Fatal(err)
	}
	movedBack = true
	if err := s.EnableArchiveStaging(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	if offset, err := guard.Observe(t.Context(), id, 4); err != nil || offset != 4 {
		t.Fatalf("reverified volume did not retain bytes: offset=%d err=%v", offset, err)
	}
}
