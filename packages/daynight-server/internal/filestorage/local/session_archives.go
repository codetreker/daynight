package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"

	"github.com/google/uuid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
)

// DeleteSessionArchives never accepts a caller-selected bucket or path prefix.
// Directory handles confine every recursive operation to the selected Session;
// unlike ordinary object access, cleanup rejects symlink directory aliases.
func (s *Storage) DeleteSessionArchives(ctx context.Context, sessionID string) (result error) {
	id, err := uuid.Parse(sessionID)
	if err != nil || id == uuid.Nil || id.String() != sessionID {
		return fmt.Errorf("%w: session ID must be a nonzero canonical UUID", filestorage.ErrInvalidAddress)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.namespace.Lock()
	defer s.namespace.Unlock()
	if err := s.checkSpelling("session-archives"); err != nil {
		return err
	}
	bucket, _, err := openArchiveDirectory(s.root, "session-archives")
	if errors.Is(err, fs.ErrNotExist) {
		return s.syncArchiveDirectory(s.root)
	}
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, bucket.Close()) }()
	if err := s.checkSpelling("session-archives/" + sessionID); err != nil {
		return err
	}
	session, info, err := openArchiveDirectory(bucket, sessionID)
	if errors.Is(err, fs.ErrNotExist) {
		return s.syncArchiveDirectory(bucket)
	}
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, session.Close()) }()
	if err := removeArchiveContents(ctx, session); err != nil {
		return err
	}
	if err := removeArchiveEntry(ctx, bucket, sessionID, info); err != nil {
		return err
	}
	// A retry must repeat this barrier even when the previous attempt removed
	// the namespace but could not make that removal durable.
	return s.syncArchiveDirectory(bucket)
}

func openArchiveDirectory(parent *os.Root, name string) (*os.Root, fs.FileInfo, error) {
	info, err := parent.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !info.IsDir() {
		return nil, nil, fmt.Errorf("%w: %s", filestorage.ErrNotRegular, name)
	}
	directory, err := parent.OpenRoot(name)
	if err != nil {
		return nil, nil, err
	}
	opened, err := directory.Stat(".")
	if err == nil && !os.SameFile(info, opened) {
		err = fmt.Errorf("%w: %s changed while opening", filestorage.ErrPathConflict, name)
	}
	if err != nil {
		return nil, nil, errors.Join(err, directory.Close())
	}
	return directory, info, nil
}

func removeArchiveContents(ctx context.Context, directory *os.Root) (result error) {
	file, err := directory.Open(".")
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, file.Close()) }()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, err := file.ReadDir(128)
		if err != nil && err != io.EOF {
			return err
		}
		for _, entry := range entries {
			if err := removeArchiveChild(ctx, directory, entry.Name()); err != nil {
				return err
			}
		}
		if err == io.EOF {
			return nil
		}
	}
}

func removeArchiveChild(ctx context.Context, directory *os.Root, name string) error {
	info, err := directory.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		child, opened, err := openArchiveDirectory(directory, name)
		if err != nil {
			return err
		}
		if err := errors.Join(removeArchiveContents(ctx, child), child.Close()); err != nil {
			return err
		}
		info = opened
	} else if !info.Mode().IsRegular() {
		return fmt.Errorf("%w: %s", filestorage.ErrNotRegular, name)
	}
	return removeArchiveEntry(ctx, directory, name, info)
}

func removeArchiveEntry(ctx context.Context, directory *os.Root, name string, expected fs.FileInfo) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	current, err := directory.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !os.SameFile(expected, current) {
		return fmt.Errorf("%w: %s changed before removal", filestorage.ErrPathConflict, name)
	}
	return directory.Remove(name)
}

func (s *Storage) syncArchiveDirectory(directory *os.Root) error {
	file, err := directory.Open(".")
	if err != nil {
		return err
	}
	return errors.Join(s.fileSync(file), file.Close())
}
