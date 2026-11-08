package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
)

// DeleteSessionArchives never accepts a caller-selected bucket or path prefix.
// Directory handles confine every recursive operation to the selected Session;
// unlike ordinary object access, cleanup rejects symlink directory aliases.
func (s *Storage) DeleteSessionArchives(ctx context.Context, namespace sessionarchive.Namespace) (result error) {
	if err := namespace.Validate(); err != nil {
		return fmt.Errorf("%w: %w", filestorage.ErrInvalidAddress, err)
	}
	components := append([]string{sessionarchive.Bucket}, strings.Split(namespace.Directory(), "/")...)
	return s.deleteNamespace(ctx, components)
}

func (s *Storage) deleteNamespace(ctx context.Context, components []string) (result error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.namespace.Lock()
	defer s.namespace.Unlock()
	directories := []*os.Root{s.root}
	var sessionInfo fs.FileInfo
	defer func() {
		for i := len(directories) - 1; i > 0; i-- {
			result = errors.Join(result, directories[i].Close())
		}
	}()
	for i, component := range components {
		if err := s.checkSpelling(strings.Join(components[:i+1], "/")); err != nil {
			return err
		}
		directory, info, err := openArchiveDirectory(directories[i], component)
		if errors.Is(err, fs.ErrNotExist) {
			return s.syncArchiveDirectory(directories[i])
		}
		if err != nil {
			return err
		}
		directories = append(directories, directory)
		sessionInfo = info
	}
	last := len(directories) - 1
	if err := removeArchiveContents(ctx, directories[last]); err != nil {
		return err
	}
	if err := removeArchiveEntry(ctx, directories[last-1], components[last-1], sessionInfo); err != nil {
		return err
	}
	// A retry repeats this barrier even after the Session directory disappeared.
	return s.syncArchiveDirectory(directories[last-1])
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
