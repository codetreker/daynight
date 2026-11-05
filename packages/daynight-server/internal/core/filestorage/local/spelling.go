package local

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

// The caller holds namespace until its filesystem operation completes. Directory
// entries, rather than Unicode folding, determine the filesystem's actual names.
func (s *Storage) checkSpelling(address string) error {
	if !s.exactSpelling {
		return nil
	}
	parent := "."
	for _, segment := range strings.Split(address, "/") {
		candidate := path.Join(parent, segment)
		if _, err := s.root.Lstat(candidate); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		directory, err := s.root.Open(parent)
		if err != nil {
			return err
		}
		entries, readErr := directory.ReadDir(-1)
		if err := errors.Join(readErr, directory.Close()); err != nil {
			return err
		}
		found := false
		for _, entry := range entries {
			if entry.Name() == segment {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("%w: %s", filestorage.ErrPathConflict, candidate)
		}
		parent = candidate
	}
	return nil
}
