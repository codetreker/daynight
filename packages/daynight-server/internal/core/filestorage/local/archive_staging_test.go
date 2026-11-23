//go:build linux

package local

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

func archivePersistentRoot(t *testing.T) string {
	t.Helper()
	base, err := filepath.Abs("../../../../../../.tmp")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(base, 0o700); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "archive-volume-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	return root
}

func TestArchiveStagingContract(t *testing.T) {
	s, err := New(archivePersistentRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("unverified volume: %v", err)
	}
	if err = s.EnableArchiveStaging(t.Context(), false); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("unattested volume: %v", err)
	}
	if err = s.EnableArchiveStaging(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	if other, err := os.OpenRoot("/dev/shm"); err == nil {
		if e := s.checkArchiveMount(other); !errors.Is(e, ErrArchiveVolumeUnverified) {
			t.Errorf("different mount accepted: %v", e)
		}
		if err := other.Close(); err != nil {
			t.Error(err)
		}
	}
	guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	fileID := uuid.NewString()
	if err = guard.Create(t.Context(), fileID); err != nil {
		t.Fatal(err)
	}
	if err = guard.Create(t.Context(), fileID); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("conditional create: %v", err)
	}
	body := bytes.Repeat([]byte{0xa5}, 512*1024)
	total := int64(len(body) + 4)
	if _, err = guard.Append(t.Context(), fileID, total, 1, body); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
		t.Fatalf("wrong offset: %v", err)
	}
	if _, err = guard.Append(t.Context(), fileID, total, 0, body); err != nil {
		t.Fatal(err)
	}
	if offset, err := guard.Observe(t.Context(), fileID, total); err != nil || offset != int64(len(body)) {
		t.Fatalf("offset: %d %v", offset, err)
	}
	if _, err = guard.Append(t.Context(), fileID, total, int64(len(body)), []byte("tail")); err != nil {
		t.Fatal(err)
	}
	object, err := guard.Open(t.Context(), fileID, total)
	if err != nil {
		t.Fatal(err)
	}
	if err = guard.Delete(t.Context(), fileID); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("mutation while reading: %v", err)
	}
	got, err := io.ReadAll(object.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err = object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, append(body, []byte("tail")...)) {
		t.Fatal("incorrect bytes")
	}
	if err = guard.Delete(t.Context(), fileID); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("frozen capability: %v", err)
	}
	path := n.Directory() + "/files/" + fileID + "/content"
	if _, err = guard.Publish(t.Context(), fileID, total, sessionarchive.Bucket, path); err != nil {
		t.Fatal(err)
	}
	resourcePath := n.Directory() + "/blobs/" + fileID
	if _, err = guard.Publish(t.Context(), fileID, total, "session-resources", resourcePath); err != nil {
		t.Fatal(err)
	}
	resourceBytes, err := os.ReadFile(filepath.Join(s.root.Name(), "session-resources", resourcePath))
	if err != nil || !bytes.Equal(resourceBytes, got) {
		t.Fatalf("resource publication: %v", err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
	stagingPath, err := filestorage.ArchiveStagingPath(n, fileID)
	if err != nil {
		t.Fatal(err)
	}
	stageInfo, err := os.Stat(filepath.Join(s.root.Name(), sessionarchive.Bucket, stagingPath))
	if err != nil {
		t.Fatal(err)
	}
	publishedInfo, err := os.Stat(filepath.Join(s.root.Name(), sessionarchive.Bucket, path))
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(stageInfo, publishedInfo) {
		t.Fatal("published inode aliases staging")
	}
	guard, err = s.AcquireArchiveStaging(t.Context(), n, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = guard.Delete(t.Context(), fileID); err != nil {
		t.Fatal(err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveBackupRejectsSymlink(t *testing.T) {
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	fileID := uuid.NewString()
	path, err := filestorage.ArchiveStagingPath(n, fileID)
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(root, sessionarchive.Bucket, filepath.FromSlash(n.Directory()))
	if err = os.MkdirAll(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(root, "other")
	if err = os.Mkdir(other, 0o700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(other, fileID), []byte("other"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(other, filepath.Join(parent, ".staging")); err != nil {
		t.Fatal(err)
	}
	if obj, err := s.OpenArchiveStaging(t.Context(), n, fileID); !errors.Is(err, filestorage.ErrNotRegular) {
		if obj.Body != nil {
			_ = obj.Body.Close()
		}
		t.Fatalf("accepted staging symlink for %s: %v", path, err)
	}
}

func TestArchiveStagingRejectsTmpfs(t *testing.T) {
	root := "/dev/shm"
	if _, err := os.Stat(root); err != nil {
		t.Skip("no tmpfs mount")
	}
	var stat unix.Statfs_t
	if err := unix.Statfs(root, &stat); err != nil || uint64(stat.Type) != unix.TMPFS_MAGIC {
		t.Skip("no tmpfs mount")
	}
	f, err := os.CreateTemp(root, "daynight-tmpfs-check-")
	if err != nil {
		t.Skipf("tmpfs unavailable: %v", err)
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	root, err = os.MkdirTemp(root, "daynight-tmpfs-check-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.EnableArchiveStaging(t.Context(), true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("tmpfs enabled: %v", err)
	}
}

func TestArchiveStagingRejectsHardLinkedFile(t *testing.T) {
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
	fileID := uuid.NewString()
	guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = guard.Create(t.Context(), fileID); err != nil {
		t.Fatal(err)
	}
	path, err := filestorage.ArchiveStagingPath(n, fileID)
	if err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "foreign-alias")
	if err = os.Link(filepath.Join(root, sessionarchive.Bucket, filepath.FromSlash(path)), alias); err != nil {
		t.Fatal(err)
	}
	if _, err = guard.Observe(t.Context(), fileID, 4); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("observe accepted linked file: %v", err)
	}
	if _, err = guard.Append(t.Context(), fileID, 4, 0, []byte("test")); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("append accepted linked file: %v", err)
	}
	if _, err = guard.Open(t.Context(), fileID, 4); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("open accepted linked file: %v", err)
	}
	if err = guard.Delete(t.Context(), fileID); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("delete accepted linked file: %v", err)
	}
	if _, err = s.OpenArchiveStaging(t.Context(), n, fileID); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("backup accepted linked file: %v", err)
	}
	if err = os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if _, err = guard.Append(t.Context(), fileID, 4, 0, []byte("test")); err != nil {
		t.Fatal(err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveBackupRejectsDifferentMount(t *testing.T) {
	s, err := New(archivePersistentRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	mount, err := archiveReadRootMount(s.root)
	if err != nil {
		t.Fatal(err)
	}
	other, err := os.OpenRoot("/dev/shm")
	if err != nil {
		t.Skipf("no alternate mount: %v", err)
	}
	defer other.Close()
	if err = archiveReadDirectoryMount(mount, other); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("foreign directory mount accepted: %v", err)
	}
	file, err := other.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err = archiveReadFileMount(mount, file); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("foreign file mount accepted: %v", err)
	}
}

func TestArchiveStagingPublishRejectsAliases(t *testing.T) {
	for _, tc := range []struct {
		name, bucket string
		prepare      func(*testing.T, string, sessionarchive.Namespace, string)
	}{
		{"archive parent symlink", sessionarchive.Bucket, func(t *testing.T, root string, n sessionarchive.Namespace, id string) {
			session := filepath.Join(root, sessionarchive.Bucket, n.Directory())
			if err := os.Symlink(filepath.Join(session, ".staging"), filepath.Join(session, "files")); err != nil {
				t.Fatal(err)
			}
		}},
		{"archive target symlink", sessionarchive.Bucket, func(t *testing.T, root string, n sessionarchive.Namespace, id string) {
			session := filepath.Join(root, sessionarchive.Bucket, n.Directory())
			target := filepath.Join(session, "files", id)
			if err := os.MkdirAll(target, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(session, ".staging", id), filepath.Join(target, "content")); err != nil {
				t.Fatal(err)
			}
		}},
		{"resource parent symlink", "session-resources", func(t *testing.T, root string, n sessionarchive.Namespace, id string) {
			parent := filepath.Join(root, "session-resources")
			if err := os.Mkdir(parent, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(root, sessionarchive.Bucket, "users"), filepath.Join(parent, "users")); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
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
			id := uuid.NewString()
			guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Close()
			if err = guard.Create(t.Context(), id); err != nil {
				t.Fatal(err)
			}
			if _, err = guard.Append(t.Context(), id, 4, 0, []byte("safe")); err != nil {
				t.Fatal(err)
			}
			tc.prepare(t, root, n, id)
			path := n.Directory() + "/files/" + id + "/content"
			if tc.bucket == "session-resources" {
				path = n.Directory() + "/blobs/" + id
			}
			_, err = guard.Publish(t.Context(), id, 4, tc.bucket, path)
			if !errors.Is(err, filestorage.ErrNotRegular) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
				t.Fatalf("alias published: %v", err)
			}
			stage, err := filestorage.ArchiveStagingPath(n, id)
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(root, sessionarchive.Bucket, stage))
			if err != nil || string(got) != "safe" {
				t.Fatalf("stage changed: %q %v", got, err)
			}
		})
	}
}

func TestArchiveStagingExcludesWholeResourceCleanup(t *testing.T) {
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	other, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err = s.EnableArchiveStaging(t.Context(), true); err != nil {
		t.Fatal(err)
	}
	owner, session, file := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, owner, session)
	if err != nil {
		t.Fatal(err)
	}
	resources, err := sessionresource.NewNamespace("", owner, session)
	if err != nil {
		t.Fatal(err)
	}
	guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = guard.Create(t.Context(), file); err != nil {
		t.Fatal(err)
	}
	if _, err = guard.Append(t.Context(), file, 4, 0, []byte("safe")); err != nil {
		t.Fatal(err)
	}
	resourcePath := n.Directory() + "/blobs/" + file
	if _, err = guard.Publish(t.Context(), file, 4, sessionresource.Bucket, resourcePath); err != nil {
		t.Fatal(err)
	}
	if err = other.DeleteSessionResources(t.Context(), resources); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("resource cleanup bypassed active staging: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(root, sessionresource.Bucket, resourcePath))
	if err != nil || string(got) != "safe" {
		t.Fatalf("resource changed while protected: %q %v", got, err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
	if err = other.DeleteSessionResources(t.Context(), resources); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, sessionresource.Bucket, resourcePath)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("cleanup did not remove resource: %v", err)
	}
}

func TestResourceCleanupDoesNotCreateArchiveNamespace(t *testing.T) {
	root := archivePersistentRoot(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	owner, session := uuid.NewString(), uuid.NewString()
	n, err := sessionresource.NewNamespace("", owner, session)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteSessionResources(t.Context(), n); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, sessionarchive.Bucket)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("resource cleanup created archive root: %v", err)
	}
}

func TestArchiveDirectorySyncFailureCanRetry(t *testing.T) {
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
	failure := errors.New("injected directory barrier failure")
	rootInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	var rootBarriers int
	s.fileSync = func(f *os.File) error {
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(info, rootInfo) {
			rootBarriers++
			if rootBarriers == 1 {
				return failure
			}
		}
		return f.Sync()
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, failure) {
		t.Fatalf("initial sync failure: %v", err)
	}
	if _, err = os.Stat(filepath.Join(root, sessionarchive.Bucket)); err != nil {
		t.Fatalf("expected retained directory: %v", err)
	}
	guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	if rootBarriers < 2 {
		t.Fatal("retry omitted parent barrier")
	}
	fileID := uuid.NewString()
	if err = guard.Create(t.Context(), fileID); err != nil {
		t.Fatal(err)
	}
	if _, err = guard.Append(t.Context(), fileID, 4, 0, []byte("safe")); err != nil {
		t.Fatal(err)
	}
	sessionInfo, err := os.Stat(filepath.Join(root, sessionarchive.Bucket, n.Directory()))
	if err != nil {
		t.Fatal(err)
	}
	var sessionBarriers int
	s.fileSync = func(f *os.File) error {
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(info, sessionInfo) {
			sessionBarriers++
			if sessionBarriers == 1 {
				return failure
			}
		}
		return f.Sync()
	}
	path := n.Directory() + "/files/" + fileID + "/content"
	if _, err = guard.Publish(t.Context(), fileID, 4, sessionarchive.Bucket, path); !errors.Is(err, failure) {
		t.Fatalf("initial publication sync failure: %v", err)
	}
	if _, err = os.Stat(filepath.Join(root, sessionarchive.Bucket, n.Directory(), "files")); err != nil {
		t.Fatalf("expected retained target directory: %v", err)
	}
	if _, err = guard.Publish(t.Context(), fileID, 4, sessionarchive.Bucket, path); err != nil {
		t.Fatal(err)
	}
	if sessionBarriers < 2 {
		t.Fatal("publication retry omitted parent barrier")
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveExistingNamespaceRequiresDurabilityBarriers(t *testing.T) {
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
	if _, err = s.AcquireArchiveStaging(t.Context(), n, false); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing observation: %v", err)
	}
	if _, err = os.Stat(filepath.Join(root, sessionarchive.Bucket)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("observation created namespace: %v", err)
	}
	guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected adopted-ancestor sync failure")
	var barriers int
	s.fileSync = func(f *os.File) error {
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(info, rootInfo) {
			barriers++
			if barriers == 1 {
				return failure
			}
		}
		return f.Sync()
	}
	if _, err = s.AcquireArchiveStaging(t.Context(), n, false); !errors.Is(err, failure) {
		t.Fatalf("existing namespace admitted without barrier: %v", err)
	}
	guard, err = s.AcquireArchiveStaging(t.Context(), n, false)
	if err != nil {
		t.Fatal(err)
	}
	if barriers < 2 {
		t.Fatal("retry omitted ancestor barrier")
	}
	fileID := uuid.NewString()
	if _, err = guard.Observe(t.Context(), fileID, 4); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("observation accepted missing file: %v", err)
	}
	if err = guard.Create(t.Context(), fileID); err != nil {
		t.Fatal(err)
	}
	if _, err = guard.Append(t.Context(), fileID, 4, 0, []byte("safe")); err != nil {
		t.Fatal(err)
	}
	if err = guard.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveAdoptsEmptyAfterUncertainCreate(t *testing.T) {
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
	guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	stageDir := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging")
	if err = os.Mkdir(stageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	stageInfo, err := os.Stat(stageDir)
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected staging directory sync failure")
	var dirBarriers int
	s.fileSync = func(f *os.File) error {
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if os.SameFile(info, stageInfo) {
			dirBarriers++
			if dirBarriers == 1 {
				return failure
			}
		}
		return f.Sync()
	}
	id := uuid.NewString()
	if err = guard.Create(t.Context(), id); !errors.Is(err, failure) {
		t.Fatalf("expected uncertain create: %v", err)
	}
	if err = guard.Create(t.Context(), id); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("repeat create overwrote existing object: %v", err)
	}
	if err = guard.AdoptEmpty(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	if dirBarriers < 2 {
		t.Fatal("adoption omitted parent directory barrier")
	}
	if err = guard.AdoptEmpty(t.Context(), uuid.NewString()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("adoption created absent object: %v", err)
	}
	if _, err = guard.Append(t.Context(), id, 4, 0, []byte("safe")); err != nil {
		t.Fatal(err)
	}
	if err = guard.AdoptEmpty(t.Context(), id); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
		t.Fatalf("adoption accepted nonempty object: %v", err)
	}
	path, err := filestorage.ArchiveStagingPath(n, id)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, sessionarchive.Bucket, path))
	if err != nil || string(got) != "safe" {
		t.Fatalf("adoption modified content: %q %v", got, err)
	}
}

func TestArchiveAdoptEmptySyncFailureCanRetry(t *testing.T) {
	for _, target := range []string{"file", "directory"} {
		t.Run(target, func(t *testing.T) {
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
			guard, err := s.AcquireArchiveStaging(t.Context(), n, true)
			if err != nil {
				t.Fatal(err)
			}
			defer guard.Close()
			id := uuid.NewString()
			if err = guard.Create(t.Context(), id); err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(root, sessionarchive.Bucket, n.Directory(), ".staging")
			selected := stage
			if target == "file" {
				selected = filepath.Join(stage, id)
			}
			selectedInfo, err := os.Stat(selected)
			if err != nil {
				t.Fatal(err)
			}
			failure := errors.New("injected adoption sync failure")
			var attempts int
			s.fileSync = func(f *os.File) error {
				info, e := f.Stat()
				if e != nil {
					return e
				}
				if os.SameFile(info, selectedInfo) {
					attempts++
					if attempts == 1 {
						return failure
					}
				}
				return f.Sync()
			}
			if err = guard.AdoptEmpty(t.Context(), id); !errors.Is(err, failure) {
				t.Fatalf("uncompleted %s barrier was accepted: %v", target, err)
			}
			if err = guard.AdoptEmpty(t.Context(), id); err != nil {
				t.Fatalf("retry: %v", err)
			}
			if attempts < 2 {
				t.Fatalf("%s barrier was not repeated", target)
			}
			info, err := os.Stat(filepath.Join(stage, id))
			if err != nil || info.Size() != 0 {
				t.Fatalf("adoption modified empty object: %v", err)
			}
		})
	}
}
