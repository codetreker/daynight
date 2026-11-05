package local

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestCaseDistinctAddressesAndBytes(t *testing.T) {
	storage, root := newStorage(t)
	if storage.exactSpelling {
		if runtime.GOOS != "darwin" {
			t.Fatal("Linux storage must provide case-sensitive names")
		}
		t.Skip("Case-distinct storage is covered on Linux and explicit case-sensitive macOS volumes")
	}
	put(t, storage, "attachments", "Task/docs/Design 文档.md", []byte("upper"))
	put(t, storage, "attachments", "Task/docs/design 文档.md", []byte("lower"))
	put(t, storage, "attachments", "task/docs/Design 文档.md", []byte("other task"))
	for name, expected := range map[string]string{
		"Task/docs/Design 文档.md": "upper",
		"Task/docs/design 文档.md": "lower",
		"task/docs/Design 文档.md": "other task",
	} {
		if actual := string(read(t, storage, "attachments", name)); actual != expected {
			t.Fatalf("%s: %q", name, actual)
		}
	}
	assertNoTemporary(t, root)
}

func TestExactSpellingKeepsOrdinaryStorageOperations(t *testing.T) {
	storage, root := newStorage(t)
	// Exercise the same directory-entry checks on Linux without pretending that
	// its filesystem aliases names; actual alias refusals run on macOS below.
	storage.exactSpelling = true
	put(t, storage, "bucket", "Docs/Design 文档.md", []byte("initial"))
	put(t, storage, "bucket", "Docs/Design 文档.md", []byte("replacement"))
	if actual := string(read(t, storage, "bucket", "Docs/Design 文档.md")); actual != "replacement" {
		t.Fatal(actual)
	}
	if _, err := storage.Open(t.Context(), "bucket", "Docs/missing"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing read: %v", err)
	}
	if err := storage.Delete(t.Context(), "bucket", "Docs/missing"); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Put(t.Context(), "bucket", "Docs/Design 文档.md/child", strings.NewReader("invalid")); err == nil {
		t.Fatal("accepted a file as parent")
	}
	if err := storage.Delete(t.Context(), "bucket", "Docs/Design 文档.md"); err != nil {
		t.Fatal(err)
	}
	assertNoTemporary(t, root)
}

func requireAliasingFilesystem(t *testing.T, storage *Storage) {
	t.Helper()
	if !storage.exactSpelling {
		t.Skip("Requires the real case-insensitive filesystem used by native macOS development")
	}
}

func TestAliasedNamesCannotOverwriteReadOrDeleteAnotherFile(t *testing.T) {
	for _, alias := range []struct{ bucket, name string }{
		{"Bucket", "Docs/File.txt"},
		{"bucket", "docs/File.txt"},
		{"bucket", "Docs/file.txt"},
	} {
		t.Run(alias.bucket+"/"+alias.name, func(t *testing.T) {
			storage, root := newStorage(t)
			requireAliasingFilesystem(t, storage)
			original := []byte{0, 1, 255, '\n'}
			put(t, storage, "bucket", "Docs/File.txt", original)
			reads := 0
			source := &observingReader{Reader: strings.NewReader("corrupt"), observe: func() { reads++ }}
			if _, err := storage.Put(t.Context(), alias.bucket, alias.name, source); !errors.Is(err, filestorage.ErrPathConflict) {
				t.Fatalf("alias overwrite: %v", err)
			}
			if reads != 0 {
				t.Fatal("read an upload body after detecting its conflicting name")
			}
			if _, err := storage.Open(t.Context(), alias.bucket, alias.name); !errors.Is(err, filestorage.ErrPathConflict) {
				t.Fatalf("alias read: %v", err)
			}
			if err := storage.Delete(t.Context(), alias.bucket, alias.name); !errors.Is(err, filestorage.ErrPathConflict) {
				t.Fatalf("alias delete: %v", err)
			}
			if actual := read(t, storage, "bucket", "Docs/File.txt"); !bytes.Equal(actual, original) {
				t.Fatal("an alias changed the existing bytes")
			}
			assertNoTemporary(t, root)
		})
	}
}

func TestAliasRefusalDoesNotPruneExistingEmptyDirectory(t *testing.T) {
	storage, root := newStorage(t)
	requireAliasingFilesystem(t, storage)
	directory := filepath.Join(root, "bucket", "Empty")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Put(t.Context(), "bucket", "empty/file", strings.NewReader("rejected")); !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("alias upload: %v", err)
	}
	if info, err := os.Stat(directory); err != nil || !info.IsDir() {
		t.Fatalf("refused upload removed an existing directory: %v", err)
	}
	assertNoTemporary(t, root)
}

func TestConcurrentCaseAliasCannotReplacePublishedWinner(t *testing.T) {
	for _, names := range [][2]string{{"File", "file"}, {"file", "File"}} {
		t.Run(names[0], func(t *testing.T) {
			storage, root := newStorage(t)
			requireAliasingFilesystem(t, storage)
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			t.Cleanup(unblock)
			result := make(chan error, 1)
			source := &barrierReader{reader: strings.NewReader("late content"), started: started, release: release}
			go func() {
				_, err := storage.Put(t.Context(), "bucket", names[0], source)
				result <- err
			}()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("pending upload did not start")
			}
			put(t, storage, "bucket", names[1], []byte("winner"))
			unblock()
			select {
			case err := <-result:
				if !errors.Is(err, filestorage.ErrPathConflict) {
					t.Fatalf("late alias publication: %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("pending upload did not finish")
			}
			if actual := string(read(t, storage, "bucket", names[1])); actual != "winner" {
				t.Fatal(actual)
			}
			if _, err := storage.Open(t.Context(), "bucket", names[0]); !errors.Is(err, filestorage.ErrPathConflict) {
				t.Fatalf("late alias became readable: %v", err)
			}
			assertNoTemporary(t, root)
		})
	}
}

func TestNativeStorageReopensOrdinaryDirectoryWithoutChangingBytes(t *testing.T) {
	root := filepath.Join(t.TempDir(), "storage")
	storage, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("ordinary native storage\x00\n")
	put(t, storage, "bucket", "docs/file", content)
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := reopened.Close(); err != nil {
			t.Error(err)
		}
	}()
	if actual := read(t, reopened, "bucket", "docs/file"); !bytes.Equal(actual, content) {
		t.Fatal("reopening changed stored bytes")
	}
	assertNoTemporary(t, root)
}

func TestExactSpellingRefusesUnreadableParentDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permission checks")
	}
	storage, root := newStorage(t)
	storage.exactSpelling = true
	put(t, storage, "bucket", "file", []byte("private"))
	parent := filepath.Join(root, "bucket")
	if err := os.Chmod(parent, 0o100); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(parent, 0o700); err != nil {
			t.Error(err)
		}
	})
	if _, err := storage.Open(t.Context(), "bucket", "file"); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("unreadable parent: %v", err)
	}
}
