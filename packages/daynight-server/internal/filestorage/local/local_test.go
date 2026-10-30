package local

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
)

func newStorage(t *testing.T) (*Storage, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "storage")
	storage, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := storage.Close(); err != nil {
			t.Error(err)
		}
	})
	return storage, root
}

func put(t *testing.T, storage *Storage, bucket, path string, content []byte) {
	t.Helper()
	info, err := storage.Put(t.Context(), bucket, path, bytes.NewReader(content))
	if err != nil || info.Size != int64(len(content)) {
		t.Fatalf("Put: info=%+v err=%v", info, err)
	}
}

func read(t *testing.T, storage *Storage, bucket, path string) []byte {
	t.Helper()
	object, err := storage.Open(t.Context(), bucket, path)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	if err := errors.Join(readErr, object.Body.Close()); err != nil {
		t.Fatal(err)
	}
	if object.Info.Size != int64(len(content)) {
		t.Fatalf("Info.Size=%d, actual=%d", object.Info.Size, len(content))
	}
	return content
}

func TestFilesRetainAddressesAndBytes(t *testing.T) {
	storage, root := newStorage(t)
	content := bytes.Repeat([]byte{0, 0xff, '\n', 'a'}, 20_000)
	put(t, storage, "attachments", "Task/docs/Design 文档.md", content)
	if got := read(t, storage, "attachments", "Task/docs/Design 文档.md"); !bytes.Equal(got, content) {
		t.Fatal("binary bytes changed")
	}
	physical, err := os.ReadFile(filepath.Join(root, "attachments", "Task", "docs", "Design 文档.md"))
	if err != nil || !bytes.Equal(physical, content) {
		t.Fatalf("physical real path content: %v", err)
	}
	put(t, storage, "other", "Task/docs/Design 文档.md", []byte("other bucket"))
	if got := string(read(t, storage, "other", "Task/docs/Design 文档.md")); got != "other bucket" {
		t.Fatal(got)
	}
	if got := read(t, storage, "attachments", "Task/docs/Design 文档.md"); !bytes.Equal(got, content) {
		t.Fatal("case or bucket alias")
	}
	assertNoTemporary(t, root)
}

func TestOverwritePublishesCompleteFileAndKeepsOpenReader(t *testing.T) {
	storage, root := newStorage(t)
	put(t, storage, "bucket", "docs/file", []byte("old content"))
	old, err := storage.Open(t.Context(), "bucket", "docs/file")
	if err != nil {
		t.Fatal(err)
	}
	source := &observingReader{Reader: strings.NewReader("new"), observe: func() {
		if got := string(read(t, storage, "bucket", "docs/file")); got != "old content" {
			t.Errorf("published unfinished file: %q", got)
		}
	}}
	if _, err := storage.Put(t.Context(), "bucket", "docs/file", source); err != nil {
		t.Fatal(err)
	}
	if source.closed {
		t.Fatal("Put closed caller reader")
	}
	if got := string(read(t, storage, "bucket", "docs/file")); got != "new" {
		t.Fatal(got)
	}
	oldContent, err := io.ReadAll(old.Body)
	if err := errors.Join(err, old.Body.Close()); err != nil || string(oldContent) != "old content" || old.Info.Size != 11 {
		t.Fatalf("open reader changed: %q %+v %v", oldContent, old.Info, err)
	}
	put(t, storage, "bucket", "docs/file", nil)
	if len(read(t, storage, "bucket", "docs/file")) != 0 {
		t.Fatal("empty overwrite retained bytes")
	}
	assertNoTemporary(t, root)
}

type observingReader struct {
	*strings.Reader
	observe func()
	closed  bool
}

func (r *observingReader) Read(buffer []byte) (int, error) {
	r.observe()
	return r.Reader.Read(buffer)
}

func (r *observingReader) Close() error {
	r.closed = true
	return nil
}

func TestDeleteOnlySpecifiedRegularFile(t *testing.T) {
	storage, _ := newStorage(t)
	put(t, storage, "bucket", "docs/a", []byte("a"))
	put(t, storage, "bucket", "docs/b", []byte("b"))
	if err := storage.Delete(t.Context(), "bucket", "docs/a"); err != nil {
		t.Fatal(err)
	}
	if err := storage.Delete(t.Context(), "bucket", "docs/a"); err != nil {
		t.Fatal("missing delete: ", err)
	}
	if _, err := storage.Open(t.Context(), "bucket", "docs/a"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("deleted file open: %v", err)
	}
	if got := string(read(t, storage, "bucket", "docs/b")); got != "b" {
		t.Fatal(got)
	}
	if err := storage.Delete(t.Context(), "bucket", "docs"); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("directory delete: %v", err)
	}
	if _, err := storage.Open(t.Context(), "bucket", "docs"); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("directory open: %v", err)
	}
	if _, err := storage.Put(t.Context(), "bucket", "docs", strings.NewReader("bad")); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("directory overwrite: %v", err)
	}
	if _, err := storage.Put(t.Context(), "bucket", "docs/b/child", strings.NewReader("bad")); err == nil {
		t.Fatal("file accepted as directory")
	}
	if got := string(read(t, storage, "bucket", "docs/b")); got != "b" {
		t.Fatalf("rejected descendant upload changed file: %q", got)
	}
}

func TestRejectedDescendantPutPreservesPublishedFiles(t *testing.T) {
	storage, root := newStorage(t)
	put(t, storage, "bucket", "docs/b", []byte("keep original bytes"))
	put(t, storage, "bucket", "docs/sibling", []byte("keep sibling bytes"))
	for _, name := range []string{"docs/b/child", "docs/b/child/grandchild"} {
		if _, err := storage.Put(t.Context(), "bucket", name, strings.NewReader("rejected")); err == nil {
			t.Fatalf("file accepted as a parent directory: %s", name)
		}
	}
	if got := string(read(t, storage, "bucket", "docs/b")); got != "keep original bytes" {
		t.Fatalf("original file changed: %q", got)
	}
	if got := string(read(t, storage, "bucket", "docs/sibling")); got != "keep sibling bytes" {
		t.Fatalf("sibling file changed: %q", got)
	}
	assertNoTemporary(t, root)
}

func TestAncestorCleanupPreservesSymbolicLinks(t *testing.T) {
	storage, root := newStorage(t)
	put(t, storage, "bucket", "real/sibling", []byte("keep sibling bytes"))
	alias := filepath.Join(root, "bucket", "alias")
	if err := os.Symlink("real", alias); err != nil {
		t.Fatal(err)
	}
	put(t, storage, "bucket", "alias/child", []byte("child"))
	if err := storage.Delete(t.Context(), "bucket", "alias/child"); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(alias); err != nil || target != "real" {
		t.Fatalf("cleanup changed ancestor symlink: %q %v", target, err)
	}
	if got := string(read(t, storage, "bucket", "real/sibling")); got != "keep sibling bytes" {
		t.Fatalf("cleanup changed sibling: %q", got)
	}
	assertNoTemporary(t, root)
}

func TestInvalidAndCanceledOperations(t *testing.T) {
	storage, root := newStorage(t)
	for _, operation := range []func(context.Context, string) error{
		func(ctx context.Context, name string) error {
			_, err := storage.Put(ctx, "bucket", name, strings.NewReader("x"))
			return err
		},
		func(ctx context.Context, name string) error { _, err := storage.Open(ctx, "bucket", name); return err },
		func(ctx context.Context, name string) error { return storage.Delete(ctx, "bucket", name) },
	} {
		if err := operation(t.Context(), "../outside"); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if err := operation(ctx, "file"); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	source := &observingReader{Reader: strings.NewReader("partial"), observe: cancel}
	if _, err := storage.Put(ctx, "bucket", "file", source); !errors.Is(err, context.Canceled) {
		t.Fatalf("mid-copy cancel: %v", err)
	}
	if _, err := storage.Open(t.Context(), "bucket", "file"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("canceled new file exists: %v", err)
	}
	put(t, storage, "bucket", "file", []byte("keep"))
	readCtx, readCancel := context.WithCancel(t.Context())
	object, err := storage.Open(readCtx, "bucket", "file")
	if err != nil {
		t.Fatal(err)
	}
	readCancel()
	if _, err := io.Copy(io.Discard, object.Body); !errors.Is(err, context.Canceled) {
		t.Fatalf("stream cancel: %v", err)
	}
	if err := object.Body.Close(); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	assertNoTemporary(t, root)
}

func TestReaderFailureKeepsExistingFileAndCleansTemporary(t *testing.T) {
	storage, root := newStorage(t)
	put(t, storage, "bucket", "file", []byte("keep"))
	wantErr := errors.New("input failed")
	if _, err := storage.Put(t.Context(), "bucket", "file", io.MultiReader(strings.NewReader("partial"), errorReader{wantErr})); !errors.Is(err, wantErr) {
		t.Fatal(err)
	}
	if got := string(read(t, storage, "bucket", "file")); got != "keep" {
		t.Fatal(got)
	}
	assertNoTemporary(t, root)
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

func TestSymlinksCannotEscapeOrBeDeletedAsFiles(t *testing.T) {
	storage, root := newStorage(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "keep"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error {
			_, err := storage.Put(t.Context(), "escape", "keep", strings.NewReader("changed"))
			return err
		},
		func() error { _, err := storage.Open(t.Context(), "escape", "keep"); return err },
		func() error { return storage.Delete(t.Context(), "escape", "keep") },
	} {
		if err := operation(); err == nil {
			t.Fatal("escaped root")
		}
	}
	put(t, storage, "bucket", "file", []byte("inside"))
	if err := os.Symlink("file", filepath.Join(root, "bucket", "alias")); err != nil {
		t.Fatal(err)
	}
	if err := storage.Delete(t.Context(), "bucket", "alias"); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("deleted symlink: %v", err)
	}
	if _, err := storage.Put(t.Context(), "bucket", "alias", strings.NewReader("replace")); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("replaced symlink: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(outside, "keep")); err != nil || string(got) != "outside" {
		t.Fatalf("outside changed: %q %v", got, err)
	}
}

func TestNewAndClosedRootErrors(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(file); err == nil {
		t.Fatal("accepted regular file root")
	}
	storage, err := New(filepath.Join(directory, "storage"))
	if err != nil {
		t.Fatal(err)
	}
	put(t, storage, "bucket", "file", []byte("existing"))
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Put(t.Context(), "bucket", "file", strings.NewReader("x")); err == nil {
		t.Fatal("Put on closed root succeeded")
	}
	if _, err := storage.Open(t.Context(), "bucket", "file"); err == nil {
		t.Fatal("Open on closed root succeeded")
	}
	if err := storage.Delete(t.Context(), "bucket", "file"); err == nil {
		t.Fatal("Delete on closed root succeeded")
	}
	if _, err := checkCaseSensitive(storage.root); err == nil {
		t.Fatal("case probe on closed root succeeded")
	}
}

func TestPermissionFailuresRemainIdentifiable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses filesystem permission checks")
	}
	for _, mode := range []fs.FileMode{0, 0o500} {
		directory := t.TempDir()
		if err := os.Chmod(directory, mode); err != nil {
			t.Fatal(err)
		}
		_, err := New(directory)
		if restoreErr := os.Chmod(directory, 0o700); restoreErr != nil {
			t.Fatal(restoreErr)
		}
		if !errors.Is(err, fs.ErrPermission) {
			t.Fatalf("New under mode %o: %v", mode, err)
		}
	}
	storage, root := newStorage(t)
	put(t, storage, "bucket", "file", []byte("read protected"))
	filename := filepath.Join(root, "bucket", "file")
	if err := os.Chmod(filename, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Open(t.Context(), "bucket", "file"); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("Open permission: %v", err)
	}
	protected := filepath.Join(root, "bucket", "protected")
	if err := os.Mkdir(protected, 0); err != nil {
		t.Fatal(err)
	}
	_, protectedErr := storage.Put(t.Context(), "bucket", "protected", strings.NewReader("replacement"))
	if err := os.Chmod(protected, 0o700); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(protectedErr, fs.ErrPermission) {
		t.Fatalf("unreadable directory reuse: %v", protectedErr)
	}
	parent := filepath.Join(root, "bucket")
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(parent, 0o700); err != nil {
			t.Error(err)
		}
	})
	if _, err := storage.Put(t.Context(), "bucket", "file", strings.NewReader("bad")); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("Put permission: %v", err)
	}
	if _, err := storage.Put(t.Context(), "bucket", "new/file", strings.NewReader("bad")); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("new directory permission: %v", err)
	}
	if err := storage.Delete(t.Context(), "bucket", "file"); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("Delete permission: %v", err)
	}
	if err := createProbeFile(storage.root, "bucket/probe"); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("probe permission: %v", err)
	}
}

func TestFailedPublicationKeepsConflictingDirectory(t *testing.T) {
	storage, root := newStorage(t)
	source := &observingReader{Reader: strings.NewReader("content"), observe: func() {
		if err := os.MkdirAll(filepath.Join(root, "bucket", "file", "child"), 0o700); err != nil {
			t.Error(err)
		}
	}}
	if _, err := storage.Put(t.Context(), "bucket", "file", source); err == nil {
		t.Fatal("publication replaced directory")
	}
	if info, err := os.Stat(filepath.Join(root, "bucket", "file", "child")); err != nil || !info.IsDir() {
		t.Fatalf("conflicting directory changed: %v", err)
	}
	assertNoTemporary(t, root)
}

func TestConcurrentOverwritesNeverExposePartialContent(t *testing.T) {
	storage, root := newStorage(t)
	contents := [][]byte{
		bytes.Repeat([]byte("first"), 10_000),
		bytes.Repeat([]byte("second"), 10_000),
		bytes.Repeat([]byte("third"), 10_000),
	}
	put(t, storage, "bucket", "file", contents[0])
	var workers sync.WaitGroup
	failures := make(chan error, len(contents))
	for _, content := range contents {
		workers.Go(func() {
			for range 10 {
				if _, err := storage.Put(t.Context(), "bucket", "file", bytes.NewReader(content)); err != nil {
					failures <- err
					return
				}
			}
		})
	}
	for range 30 {
		got := read(t, storage, "bucket", "file")
		complete := false
		for _, content := range contents {
			complete = complete || bytes.Equal(got, content)
		}
		if !complete {
			t.Errorf("read incomplete content of size %d", len(got))
		}
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	assertNoTemporary(t, root)
}

func TestImplicitDirectoriesCanBecomeFiles(t *testing.T) {
	for _, initial := range []struct {
		name string
		make func(*testing.T, *Storage)
	}{
		{"deleted last descendant", func(t *testing.T, storage *Storage) {
			put(t, storage, "bucket", "docs/nested/a", []byte("old"))
			if err := storage.Delete(t.Context(), "bucket", "docs/nested/a"); err != nil {
				t.Fatal(err)
			}
		}},
		{"failed new descendant", func(t *testing.T, storage *Storage) {
			failure := errors.New("source failed")
			if _, err := storage.Put(t.Context(), "bucket", "docs/nested/a", errorReader{failure}); !errors.Is(err, failure) {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(initial.name, func(t *testing.T) {
			storage, root := newStorage(t)
			initial.make(t, storage)
			put(t, storage, "bucket", "docs", []byte("now a file"))
			if got := string(read(t, storage, "bucket", "docs")); got != "now a file" {
				t.Fatal(got)
			}
			assertNoTemporary(t, root)
		})
	}
}

func TestExistingEmptyDirectoryIsReusedOnlyAfterUploadCompletes(t *testing.T) {
	storage, root := newStorage(t)
	if err := os.MkdirAll(filepath.Join(root, "bucket", "docs"), 0o700); err != nil {
		t.Fatal(err)
	}
	source := &observingReader{Reader: strings.NewReader("replacement"), observe: func() {
		if info, err := os.Stat(filepath.Join(root, "bucket", "docs")); err != nil || !info.IsDir() {
			t.Errorf("empty target removed before content complete: %v", err)
		}
	}}
	if _, err := storage.Put(t.Context(), "bucket", "docs", source); err != nil {
		t.Fatal(err)
	}
	if got := string(read(t, storage, "bucket", "docs")); got != "replacement" {
		t.Fatal(got)
	}
}

func TestPendingChildUploadPreventsDirectoryReplacement(t *testing.T) {
	storage, root := newStorage(t)
	started, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	finish := func() { unblock.Do(func() { close(release) }) }
	t.Cleanup(finish)
	source := &barrierReader{reader: strings.NewReader("child"), started: started, release: release}
	result := make(chan error, 1)
	go func() {
		_, err := storage.Put(t.Context(), "bucket", "docs/child", source)
		result <- err
	}()
	<-started
	if _, err := storage.Put(t.Context(), "bucket", "docs", strings.NewReader("parent")); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("parent replaced pending child: %v", err)
	}
	finish()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if got := string(read(t, storage, "bucket", "docs/child")); got != "child" {
		t.Fatal(got)
	}
	assertNoTemporary(t, root)
}

func TestChildPublishedDuringParentUploadIsPreserved(t *testing.T) {
	storage, root := newStorage(t)
	if err := os.MkdirAll(filepath.Join(root, "bucket", "docs"), 0o700); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	finish := func() { unblock.Do(func() { close(release) }) }
	t.Cleanup(finish)
	source := &barrierReader{reader: strings.NewReader("parent"), started: started, release: release}
	result := make(chan error, 1)
	go func() {
		_, err := storage.Put(t.Context(), "bucket", "docs", source)
		result <- err
	}()
	<-started
	put(t, storage, "bucket", "docs/child", []byte("child"))
	finish()
	if err := <-result; !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("parent replaced published child: %v", err)
	}
	if got := string(read(t, storage, "bucket", "docs/child")); got != "child" {
		t.Fatal(got)
	}
	assertNoTemporary(t, root)
}

type barrierReader struct {
	reader  io.Reader
	started chan<- struct{}
	release <-chan struct{}
	once    sync.Once
}

func (r *barrierReader) Read(buffer []byte) (int, error) {
	r.once.Do(func() {
		close(r.started)
		<-r.release
	})
	return r.reader.Read(buffer)
}

func assertNoTemporary(t *testing.T, root string) {
	t.Helper()
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasPrefix(entry.Name(), ".daynight-") {
			t.Errorf("temporary left: %s", path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPutRequiresDurableBytesAndDirectoryPublication(t *testing.T) {
	for _, failAt := range []int{1, 2, 3, 4} {
		t.Run(fmt.Sprint(failAt), func(t *testing.T) {
			storage, root := newStorage(t)
			put(t, storage, "bucket", "session/file", []byte("old"))
			calls := 0
			syncFailure := errors.New("injected sync failure")
			storage.fileSync = func(file *os.File) error {
				calls++
				if calls == failAt {
					return syncFailure
				}
				return file.Sync()
			}
			if _, err := storage.Put(t.Context(), "bucket", "session/file", strings.NewReader("new")); !errors.Is(err, syncFailure) {
				t.Fatal("sync failure acknowledged", err)
			}
			got := string(read(t, storage, "bucket", "session/file"))
			if failAt == 1 && got != "old" {
				t.Fatal("unsynced bytes replaced old object")
			}
			if failAt > 1 && got != "new" {
				t.Fatal("published bytes lost on directory sync failure")
			}
			assertNoTemporary(t, root)
			storage.fileSync = (*os.File).Sync
			put(t, storage, "bucket", "session/file", []byte("new"))
			if got := string(read(t, storage, "bucket", "session/file")); got != "new" {
				t.Fatal(got)
			}
		})
	}
}
func TestPutSyncsNewDirectoryChainBeforeAcknowledgement(t *testing.T) {
	storage, _ := newStorage(t)
	var kinds []bool
	storage.fileSync = func(file *os.File) error {
		info, err := file.Stat()
		if err != nil {
			return err
		}
		kinds = append(kinds, info.IsDir())
		return file.Sync()
	}
	put(t, storage, "archives", "session/hash.json", []byte("archive"))
	if !reflect.DeepEqual(kinds, []bool{false, true, true, true}) {
		t.Fatalf("expected file, session, bucket and root barriers, got %v", kinds)
	}
}
