package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"reflect"
	"slices"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
)

func (m *attachmentMigration) inspectDirectory(name string) (bool, error) {
	info, err := m.root.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, m.failure("filesystem", "A migration directory could not be inspected.", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, m.failure("unsafe_entry", "A migration directory is not a real directory.", nil)
	}
	return true, nil
}

func (m *attachmentMigration) readDirectory(ctx context.Context, name string) ([]os.DirEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, m.failure("canceled", "Migration was canceled.", err)
	}
	file, err := m.root.Open(name)
	if err != nil {
		return nil, m.failure("filesystem", "A migration directory could not be opened.", err)
	}
	entries, readErr := file.ReadDir(-1)
	if err := errors.Join(readErr, file.Close()); err != nil {
		return nil, m.failure("filesystem", "A migration directory could not be listed.", err)
	}
	slices.SortFunc(entries, func(a, b os.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	return entries, nil
}

func (m *attachmentMigration) inventory(ctx context.Context, directory string, hashes bool) ([]attachmentMigrationEntry, error) {
	result := []attachmentMigrationEntry{}
	var walk func(string) error
	walk = func(relative string) error {
		if err := ctx.Err(); err != nil {
			return m.failure("canceled", "Migration was canceled during content inventory.", err)
		}
		name := directory
		if relative != "." {
			if err := filestorage.ValidateAddress(attachmentBucket, relative); err != nil {
				return m.failure("unsafe_entry", "The attachment inventory contains an invalid relative filename.", err)
			}
			name += "/" + relative
		}
		info, err := m.root.Lstat(name)
		if err != nil {
			return m.failure("filesystem", "An attachment inventory entry could not be inspected.", err)
		}
		if info.IsDir() {
			result = append(result, attachmentMigrationEntry{Path: relative, Kind: "directory"})
			entries, err := m.readDirectory(ctx, name)
			if err != nil {
				return err
			}
			for _, entry := range entries {
				child := entry.Name()
				if relative != "." {
					child = relative + "/" + child
				}
				if err := walk(child); err != nil {
					return err
				}
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return m.failure("unsafe_entry", "The attachment inventory contains a symlink or special file.", nil)
		}
		entry := attachmentMigrationEntry{Path: relative, Kind: "file", Size: info.Size()}
		if hashes {
			file, err := m.root.Open(name)
			if err != nil {
				return m.failure("filesystem", "Attachment content could not be opened for verification.", err)
			}
			digest := sha256.New()
			count, readErr := io.CopyBuffer(digest, attachmentMigrationReader{ctx: ctx, reader: file}, make([]byte, 64*1024))
			if err := errors.Join(readErr, file.Close()); err != nil {
				return m.failure("filesystem", "Attachment content could not be read for verification.", err)
			}
			if count != entry.Size {
				return m.failure("content_changed", "Attachment content changed during verification.", nil)
			}
			entry.SHA256 = hex.EncodeToString(digest.Sum(nil))
		}
		result = append(result, entry)
		return nil
	}
	if err := walk("."); err != nil {
		return nil, err
	}
	slices.SortFunc(result, func(a, b attachmentMigrationEntry) int { return strings.Compare(a.Path, b.Path) })
	return result, nil
}

type attachmentMigrationReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader attachmentMigrationReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}

func (m *attachmentMigration) verifyTask(ctx context.Context, name string, expected []attachmentMigrationEntry, hashes bool) error {
	actual, err := m.inventory(ctx, name, hashes)
	if err != nil {
		return err
	}
	if !hashes {
		expected = slices.Clone(expected)
		for index := range expected {
			expected[index].SHA256 = ""
		}
	}
	if !reflect.DeepEqual(actual, expected) {
		return m.failure("content_changed", "The attachment directory inventory differs from the migration plan.", nil)
	}
	return nil
}

func (m *attachmentMigration) verifyTree(ctx context.Context, directory string, manifest attachmentMigrationManifest, finalLayout, hashes bool) error {
	actual, err := m.inventory(ctx, directory, hashes)
	if err != nil {
		return err
	}
	expected := []attachmentMigrationEntry{{Path: ".", Kind: "directory"}}
	parents := map[string]bool{".": true}
	for _, task := range manifest.Tasks {
		if !task.Exists {
			continue
		}
		prefix := task.TaskID
		if finalLayout {
			prefix = attachmentTaskStoragePath(task.ProjectID, task.TaskID)
			for _, parent := range []string{task.ProjectID, task.ProjectID + "/" + task.TaskID[:2]} {
				if !parents[parent] {
					expected = append(expected, attachmentMigrationEntry{Path: parent, Kind: "directory"})
					parents[parent] = true
				}
			}
		}
		for _, entry := range task.Entries {
			copy := entry
			copy.Path = prefix
			if entry.Path != "." {
				copy.Path += "/" + entry.Path
			}
			if !hashes {
				copy.SHA256 = ""
			}
			expected = append(expected, copy)
		}
	}
	slices.SortFunc(expected, func(a, b attachmentMigrationEntry) int { return strings.Compare(a.Path, b.Path) })
	if !reflect.DeepEqual(actual, expected) {
		return m.failure("content_changed", "The bucket directory inventory differs from the migration plan.", nil)
	}
	return nil
}

func (m *attachmentMigration) syncDirectory(name string) error {
	file, err := m.root.Open(name)
	if err != nil {
		return m.failure("filesystem", "A migration directory could not be opened for synchronization.", err)
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return m.failure("filesystem", "A migration directory could not be synchronized.", err)
	}
	return nil
}

func (m *attachmentMigration) writeJSON(name string, value any, replace bool) (string, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "", m.failure("operation", "A migration operation record could not be encoded.", err)
	}
	data = append(data, '\n')
	if info, err := m.root.Lstat(name); err == nil {
		if !replace || !info.Mode().IsRegular() {
			return "", m.failure("operation_conflict", "A migration operation record already exists or is unsafe.", nil)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", m.failure("filesystem", "A migration operation record could not be inspected.", err)
	}
	temporary := name + ".tmp-" + rand.Text()
	file, err := m.root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", m.failure("filesystem", "A migration operation record could not be created.", err)
	}
	_, writeErr := file.Write(data)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	writeErr = errors.Join(writeErr, file.Close())
	if writeErr != nil {
		return "", m.failure("filesystem", "A migration operation record could not be persisted.", errors.Join(writeErr, m.root.Remove(temporary)))
	}
	if err := m.root.Rename(temporary, name); err != nil {
		return "", m.failure("filesystem", "A migration operation record could not be published.", err)
	}
	if err := m.syncDirectory(path.Dir(name)); err != nil {
		return "", err
	}
	return attachmentMigrationDigest(data), nil
}

func (m *attachmentMigration) rename(ctx context.Context, source, destination string) error {
	if err := ctx.Err(); err != nil {
		return m.failure("canceled", "Migration was canceled before a directory move.", err)
	}
	if _, err := m.root.Lstat(destination); err == nil {
		return m.failure("target_conflict", "A migration target already exists; no directory was overwritten.", nil)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return m.failure("filesystem", "A migration target could not be inspected.", err)
	}
	if err := m.root.Rename(source, destination); err != nil {
		return m.failure("filesystem", "An attachment directory could not be moved.", err)
	}
	if err := m.syncDirectory(path.Dir(source)); err != nil {
		return err
	}
	return m.syncDirectory(path.Dir(destination))
}

func (m *attachmentMigration) makeParents(name string) error {
	parts := strings.Split(name, "/")
	for index := range parts {
		current := strings.Join(parts[:index+1], "/")
		exists, err := m.inspectDirectory(current)
		if err != nil {
			return err
		}
		if !exists {
			if err := m.root.Mkdir(current, 0o700); err != nil {
				return m.failure("filesystem", "A migration parent directory could not be created.", err)
			}
			if err := m.syncDirectory(path.Dir(current)); err != nil {
				return err
			}
		}
	}
	return nil
}
