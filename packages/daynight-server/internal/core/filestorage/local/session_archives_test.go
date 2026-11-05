package local

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

const archiveSession = "7540b06e-11f4-4a2b-94af-f3e7ea790c85"
const otherArchiveSession = "7540b06e-11f4-4a2b-94af-f3e7ea790c86"
const archiveOwner = "70b6f95f-23d4-4a9e-9f93-f24f29c066a9"
const archiveSessionPath = "users/" + archiveOwner + "/75/" + archiveSession
const otherArchiveSessionPath = "users/" + archiveOwner + "/75/" + otherArchiveSession

func testArchiveNamespace(t *testing.T, id string) sessionarchive.Namespace {
	t.Helper()
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, archiveOwner, id)
	if err != nil {
		t.Fatal(err)
	}
	return namespace
}

func TestDeleteSessionArchivesRemovesWholeNamespaceOnly(t *testing.T) {
	storage, root := newStorage(t)
	for _, name := range []string{"generation/archive.json", "orphan.json", ".daynight-upload-interrupted"} {
		put(t, storage, "session-archives", archiveSessionPath+"/"+name, []byte("history"))
	}
	put(t, storage, "session-archives", otherArchiveSessionPath+"/archive.json", []byte("other session"))
	put(t, storage, "task-attachments", archiveSessionPath+"/archive.json", []byte("task data"))
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "session-archives", archiveSessionPath)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("session directory remains: %v", err)
	}
	if got := string(read(t, storage, "session-archives", otherArchiveSessionPath+"/archive.json")); got != "other session" {
		t.Fatal(got)
	}
	if got := string(read(t, storage, "task-attachments", archiveSessionPath+"/archive.json")); got != "task data" {
		t.Fatal(got)
	}
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal("repeat cleanup:", err)
	}
}

func TestDeleteSessionArchivesRejectsInvalidScopeAndCancellation(t *testing.T) {
	storage, _ := newStorage(t)
	put(t, storage, "session-archives", archiveSessionPath+"/archive.json", []byte("history"))
	for _, id := range []string{"", ".", "..", "../task-attachments", archiveSession + "/child", strings.ToUpper(archiveSession), "not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
		namespace, _ := sessionarchive.NewNamespace(sessionarchive.Users, archiveOwner, id)
		if err := storage.DeleteSessionArchives(t.Context(), namespace); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Errorf("invalid session %q: %v", id, err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := storage.DeleteSessionArchives(ctx, testArchiveNamespace(t, archiveSession)); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled cleanup: %v", err)
	}
	if got := string(read(t, storage, "session-archives", archiveSessionPath+"/archive.json")); got != "history" {
		t.Fatal(got)
	}
}

func TestDeleteSessionArchivesRejectsSymlinksAndAllowsRepair(t *testing.T) {
	for _, suffix := range []string{"", "users", "users/" + archiveOwner, "users/" + archiveOwner + "/75", archiveSessionPath, archiveSessionPath + "/child"} {
		t.Run(suffix, func(t *testing.T) {
			storage, root := newStorage(t)
			put(t, storage, "task-attachments", "protected/data", []byte("keep"))
			protected := filepath.Join(root, "task-attachments", "protected")
			link := filepath.Join(root, "session-archives", suffix)
			if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(protected, link); err != nil {
				t.Fatal(err)
			}
			if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); !errors.Is(err, filestorage.ErrNotRegular) {
				t.Fatalf("symlink cleanup: %v", err)
			}
			if got := string(read(t, storage, "task-attachments", "protected/data")); got != "keep" {
				t.Fatal(got)
			}
			if _, err := os.Lstat(link); err != nil {
				t.Fatalf("symlink modified: %v", err)
			}
			if err := os.Remove(link); err != nil {
				t.Fatal(err)
			}
			if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
				t.Fatal("retry:", err)
			}
		})
	}
}

func TestDeleteSessionArchivesSyncFailureRemainsRetryable(t *testing.T) {
	storage, _ := newStorage(t)
	put(t, storage, "session-archives", archiveSessionPath+"/archive.json", []byte("history"))
	failure := errors.New("directory sync failed")
	storage.fileSync = func(*os.File) error { return failure }
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); !errors.Is(err, failure) {
		t.Fatalf("cleanup hid durability failure: %v", err)
	}
	storage.fileSync = (*os.File).Sync
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal("retry:", err)
	}
}

func TestDeleteSessionArchivesManyObjectsAndEmptyNamespace(t *testing.T) {
	storage, root := newStorage(t)
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal("missing bucket:", err)
	}
	directory := filepath.Join(root, "session-archives", archiveSessionPath)
	if err := os.MkdirAll(filepath.Join(directory, "empty"), 0o700); err != nil {
		t.Fatal(err)
	}
	for i := range 130 {
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("%03d.json", i)), []byte("orphan"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("session directory remains: %v", err)
	}
}

func TestDeleteSessionArchivesPermissionFailureCanRetry(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory write permissions")
	}
	storage, root := newStorage(t)
	put(t, storage, "session-archives", archiveSessionPath+"/archive.json", []byte("history"))
	directory := filepath.Join(root, "session-archives", archiveSessionPath)
	if err := os.Chmod(directory, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o700) })
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("cleanup hid directory permission error: %v", err)
	}
	if got := string(read(t, storage, "session-archives", archiveSessionPath+"/archive.json")); got != "history" {
		t.Fatal(got)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal("retry:", err)
	}
}

func TestDeleteSessionArchivesRejectsNonDirectoryNamespace(t *testing.T) {
	storage, _ := newStorage(t)
	put(t, storage, "session-archives", archiveSessionPath, []byte("unexpected object"))
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("accepted non-directory namespace: %v", err)
	}
	if got := string(read(t, storage, "session-archives", archiveSessionPath)); got != "unexpected object" {
		t.Fatal(got)
	}
}

func TestDeleteSessionArchivesPreservesOtherOwnersKindsAndShards(t *testing.T) {
	storage, root := newStorage(t)
	otherOwner := "70b6f95f-23d4-4a9e-9f93-f24f29c066a8"
	otherShard := "8540b06e-11f4-4a2b-94af-f3e7ea790c85"
	var namespaces []sessionarchive.Namespace
	for _, components := range []struct {
		kind    sessionarchive.Kind
		owner   string
		session string
	}{{sessionarchive.Users, archiveOwner, archiveSession}, {sessionarchive.Projects, archiveOwner, archiveSession}, {sessionarchive.Users, otherOwner, archiveSession}, {sessionarchive.Users, archiveOwner, otherShard}} {
		namespace, err := sessionarchive.NewNamespace(components.kind, components.owner, components.session)
		if err != nil {
			t.Fatal(err)
		}
		namespaces = append(namespaces, namespace)
		put(t, storage, sessionarchive.Bucket, namespace.Directory()+"/history.json", []byte("keep"))
	}
	if err := storage.DeleteSessionArchives(t.Context(), namespaces[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, sessionarchive.Bucket, archiveSessionPath)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Session directory remains: %v", err)
	}
	for _, namespace := range namespaces[1:] {
		if got := string(read(t, storage, sessionarchive.Bucket, namespace.Directory()+"/history.json")); got != "keep" {
			t.Fatal("unrelated namespace changed", got)
		}
	}
}

func TestDeleteSessionArchivesPreservesExistingUnrelatedNamespace(t *testing.T) {
	storage, _ := newStorage(t)
	existing := archiveSession + "/orphan.json"
	current := archiveSessionPath + "/history.json"
	put(t, storage, sessionarchive.Bucket, existing, []byte("existing bytes"))
	put(t, storage, sessionarchive.Bucket, current, []byte("current bytes"))
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Open(t.Context(), sessionarchive.Bucket, current); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("current archive namespace remains: %v", err)
	}
	if got := string(read(t, storage, sessionarchive.Bucket, existing)); got != "existing bytes" {
		t.Fatalf("cleanup changed an existing unrelated namespace: %q", got)
	}
	if err := storage.DeleteSessionArchives(t.Context(), testArchiveNamespace(t, archiveSession)); err != nil {
		t.Fatal("repeated cleanup:", err)
	}
	if got := string(read(t, storage, sessionarchive.Bucket, existing)); got != "existing bytes" {
		t.Fatalf("repeated cleanup changed an existing unrelated namespace: %q", got)
	}
}

func TestDeleteSessionArchivesRejectsZeroNamespace(t *testing.T) {
	storage, _ := newStorage(t)
	if err := storage.DeleteSessionArchives(t.Context(), sessionarchive.Namespace{}); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("zero namespace accepted: %v", err)
	}
}

func TestArchiveCleanupClosedDirectoryDoesNotReportSuccess(t *testing.T) {
	path := t.TempDir()
	if err := os.WriteFile(filepath.Join(path, "history.json"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	directory, err := os.OpenRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := directory.Lstat("history.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := directory.Close(); err != nil {
		t.Fatal(err)
	}
	storage := &Storage{fileSync: (*os.File).Sync}
	for name, operation := range map[string]func() error{
		"enumerate": func() error { return removeArchiveContents(t.Context(), directory) },
		"child":     func() error { return removeArchiveChild(t.Context(), directory, "history.json") },
		"entry":     func() error { return removeArchiveEntry(t.Context(), directory, "history.json", info) },
		"sync":      func() error { return storage.syncArchiveDirectory(directory) },
	} {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, os.ErrClosed) {
				t.Fatalf("closed directory was not reported: %v", err)
			}
		})
	}
	if got, err := os.ReadFile(filepath.Join(path, "history.json")); err != nil || string(got) != "keep" {
		t.Fatalf("failed cleanup changed history: %q %v", got, err)
	}
}

func TestArchiveCleanupMissingChildAndEntryAreIdempotent(t *testing.T) {
	directory, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := directory.WriteFile("history.json", []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := directory.Lstat("history.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := directory.Remove("history.json"); err != nil {
		t.Fatal(err)
	}
	if err := removeArchiveChild(t.Context(), directory, "history.json"); err != nil {
		t.Fatalf("missing child was not idempotent: %v", err)
	}
	if err := removeArchiveEntry(t.Context(), directory, "history.json", info); err != nil {
		t.Fatalf("entry removed by another cleanup was not idempotent: %v", err)
	}
}

func TestArchiveCleanupPreservesEntryReplacedAfterInspection(t *testing.T) {
	path := t.TempDir()
	directory, err := os.OpenRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := directory.WriteFile("history.json", []byte("inspected"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := directory.Lstat("history.json")
	if err != nil {
		t.Fatal(err)
	}
	// Retain the old inode so replacement cannot accidentally reuse its identity.
	if err := directory.Rename("history.json", "original.json"); err != nil {
		t.Fatal(err)
	}
	if err := directory.WriteFile("history.json", []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeArchiveEntry(t.Context(), directory, "history.json", info); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("replaced entry was not refused: %v", err)
	}
	for name, want := range map[string]string{"history.json": "replacement", "original.json": "inspected"} {
		if got, err := os.ReadFile(filepath.Join(path, name)); err != nil || string(got) != want {
			t.Fatalf("cleanup modified %s: %q %v", name, got, err)
		}
	}
}

func TestArchiveCleanupCancellationPreservesInspectedEntries(t *testing.T) {
	path := t.TempDir()
	directory, err := os.OpenRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := directory.Mkdir("nested", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := directory.WriteFile("nested/history.json", []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := directory.Lstat("nested/history.json")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := removeArchiveChild(ctx, directory, "nested"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled recursive cleanup: %v", err)
	}
	if err := removeArchiveEntry(ctx, directory, "nested/history.json", info); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled inspected entry removal: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(path, "nested/history.json")); err != nil || string(got) != "keep" {
		t.Fatalf("canceled cleanup changed history: %q %v", got, err)
	}
}

func TestArchiveCleanupUnreadableDirectoryPreservesHistory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory read permissions")
	}
	path := t.TempDir()
	directory, err := os.OpenRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := directory.Mkdir("nested", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := directory.WriteFile("nested/history.json", []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(path, "nested")
	if err := os.Chmod(nested, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(nested, 0o700) })
	opened, _, err := openArchiveDirectory(directory, "nested")
	if opened != nil {
		_ = opened.Close()
	}
	if !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("unreadable directory admitted for cleanup: %v", err)
	}
	if err := removeArchiveChild(t.Context(), directory, "nested"); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("unreadable child cleanup hid failure: %v", err)
	}
	if err := os.Chmod(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(nested, "history.json")); err != nil || string(got) != "keep" {
		t.Fatalf("failed cleanup changed history: %q %v", got, err)
	}
	if err := removeArchiveChild(t.Context(), directory, "nested"); err != nil {
		t.Fatalf("cleanup could not retry after permission repair: %v", err)
	}
}
