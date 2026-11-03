package local

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
)

func TestRootInitializationDoesNotIgnoreSyncFailures(t *testing.T) {
	for _, failRoot := range []bool{false, true} {
		for _, failure := range []error{fs.ErrPermission, errors.New("directory I/O failure")} {
			t.Run(fmt.Sprintf("root=%t/error=%s", failRoot, failure), func(t *testing.T) {
				parent, err := filepath.EvalSymlinks(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				root := filepath.Join(parent, "storage")
				if err := os.Mkdir(root, 0o700); err != nil {
					t.Fatal(err)
				}
				target := parent
				if failRoot {
					target = root
				}
				storage, err := newWithDirectorySync(root, func(file *os.File) error {
					if file.Name() == target {
						return failure
					}
					return file.Sync()
				})
				if storage != nil {
					storage.Close()
					t.Fatal("synchronization failure returned writable storage")
				}
				if !errors.Is(err, failure) {
					t.Fatalf("synchronization failure was ignored: %v", err)
				}
			})
		}
	}
}

func TestRootInitializationContinuesAboveUnreadableAncestor(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses filesystem permission checks")
	}
	for _, mode := range []fs.FileMode{0o111, 0o311} {
		t.Run(fmt.Sprintf("%o", mode), func(t *testing.T) {
			parent, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			ancestor := filepath.Join(parent, "restricted")
			root := filepath.Join(ancestor, "storage")
			if err := os.MkdirAll(root, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(ancestor, mode); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.Chmod(ancestor, 0o700); err != nil {
					t.Error(err)
				}
			})
			if file, err := os.Open(ancestor); err == nil {
				file.Close()
				t.Skip("filesystem does not enforce search-only directory permissions")
			} else if !errors.Is(err, fs.ErrPermission) {
				t.Fatal(err)
			}
			barriers := map[string]bool{}
			storage, err := newWithDirectorySync(root, func(file *os.File) error {
				barriers[file.Name()] = true
				return file.Sync()
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := storage.Close(); err != nil {
				t.Fatal(err)
			}
			if !barriers[parent] || !barriers[root] || barriers[ancestor] {
				t.Fatalf("incorrect barriers around unreadable ancestor: %v", barriers)
			}
			missing := filepath.Join(ancestor, "new-storage")
			if storage, err := New(missing); storage != nil || !errors.Is(err, fs.ErrPermission) {
				if storage != nil {
					storage.Close()
				}
				t.Fatalf("created root without a readable parent: %v", err)
			}
			if _, err := os.Stat(missing); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("left a directory with an unsynchronized unreadable parent: %v", err)
			}
		})
	}
}

func TestConcurrentRootInitializationPersistsExistingDirectoryChain(t *testing.T) {
	for _, depth := range []int{1, 3} {
		for _, alias := range []bool{false, true} {
			t.Run(fmt.Sprintf("depth=%d/symlink=%t", depth, alias), func(t *testing.T) {
				parent, err := filepath.EvalSymlinks(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				first := filepath.Join(parent, "first")
				root := first
				for range depth - 1 {
					root = filepath.Join(root, "nested")
				}
				created := make(chan struct{})
				release := make(chan struct{})
				finished := make(chan error, 1)
				done := make(chan struct{})
				failure := errors.New("creator parent sync failed")
				var once sync.Once
				resume := func() { once.Do(func() { close(release) }) }
				go func() {
					defer close(done)
					storage, err := newWithDirectorySync(root, func(file *os.File) error {
						if file.Name() == parent {
							// The first mkdir is visible, but its parent entry has not
							// passed its persistence barrier. A second caller can adopt it.
							close(created)
							<-release
							return failure
						}
						return file.Sync()
					})
					if storage != nil {
						err = errors.Join(err, storage.Close())
					}
					finished <- err
				}()
				t.Cleanup(func() {
					resume()
					<-done
				})
				select {
				case <-created:
				case err := <-finished:
					t.Fatal("creator did not reach the pending directory barrier:", err)
				case <-t.Context().Done():
					t.Fatal(t.Context().Err())
				}
				requestedRoot := root
				if alias {
					link := filepath.Join(parent, "alias")
					if err := os.Symlink(first, link); err != nil {
						t.Fatal(err)
					}
					relative, err := filepath.Rel(first, root)
					if err != nil {
						t.Fatal(err)
					}
					requestedRoot = filepath.Join(link, relative)
				}
				var barriers = map[string]bool{}
				storage, err := newWithDirectorySync(requestedRoot, func(file *os.File) error {
					if err := file.Sync(); err != nil {
						return err
					}
					barriers[file.Name()] = true
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := storage.Close(); err != nil {
						t.Error(err)
					}
				})
				for directory := root; ; directory = filepath.Dir(directory) {
					if !barriers[directory] {
						t.Fatalf("storage became writable before directory entry barrier: %s", directory)
					}
					if directory == parent {
						break
					}
				}
				put(t, storage, "archives", "session/file", []byte("retained archive"))
				resume()
				select {
				case err := <-finished:
					if !errors.Is(err, failure) || !errors.Is(err, syscall.ENOTEMPTY) {
						t.Fatalf("creator must preserve a now-populated directory: %v", err)
					}
				case <-t.Context().Done():
					t.Fatal(t.Context().Err())
				}
				// A failed creator cannot remove this populated tree. Retrying an
				// existing root must still perform the same ancestor barriers.
				barriers = map[string]bool{}
				retried, err := newWithDirectorySync(requestedRoot, func(file *os.File) error {
					barriers[file.Name()] = true
					return file.Sync()
				})
				if err != nil {
					t.Fatal(err)
				}
				defer retried.Close()
				if !barriers[parent] || !barriers[first] || !barriers[root] {
					t.Fatalf("retry skipped existing directory barriers: %v", barriers)
				}
				if got := string(read(t, retried, "archives", "session/file")); got != "retained archive" {
					t.Fatal(got)
				}
			})
		}
	}
}
