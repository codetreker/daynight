package local

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
)

// Publish copies validated staging bytes into a distinct inode. Its target is
// the same Session and file ID; ancestors are opened as directories without
// symlinks or mount crossings. The caller retains the staging capability and
// business admission through verification, publication and reconciliation.
func (s *ArchiveStaging) Publish(ctx context.Context, fileID string, total int64, bucket, path string) (info filestorage.FileInfo, result error) {
	outcome := filestorage.NotPublished
	defer func() {
		if result != nil {
			result = &filestorage.PublicationError{Outcome: outcome, Cause: result}
		}
	}()
	if _, err := filestorage.ArchiveStagingPath(s.namespace, fileID); err != nil {
		return info, err
	}
	var root *os.Root
	var components []string
	switch bucket {
	case sessionarchive.Bucket:
		if path != s.namespace.Directory()+"/files/"+fileID+"/content" {
			return info, filestorage.ErrInvalidAddress
		}
		root = s.root
		components = []string{"files", fileID, "content"}
	case sessionresource.Bucket:
		if path != s.namespace.Directory()+"/blobs/"+fileID {
			return info, filestorage.ErrInvalidAddress
		}
		root = s.storage.root
		components = append([]string{sessionresource.Bucket}, strings.Split(path, "/")...)
	default:
		return info, filestorage.ErrInvalidAddress
	}
	object, err := s.Open(ctx, fileID, total)
	if err != nil {
		return info, err
	}
	defer func() { result = errors.Join(result, object.Body.Close()) }()
	if object.Info.Size != total {
		return info, filestorage.ErrArchiveStagingOffset
	}
	parent := root
	var opened []*os.Root
	defer func() {
		for i := len(opened) - 1; i >= 0; i-- {
			result = errors.Join(result, opened[i].Close())
		}
	}()
	for _, name := range components[:len(components)-1] {
		if err = s.storage.checkArchiveMount(parent); err != nil {
			return info, err
		}
		if err = filestorage.GateError(ctx); err != nil {
			return info, err
		}
		dir, _, e := openArchiveDirectory(parent, name)
		if errors.Is(e, fs.ErrNotExist) {
			if e = verifyMutation(ctx); e != nil {
				return info, e
			}
			if e = parent.Mkdir(name, 0o700); e != nil && !errors.Is(e, fs.ErrExist) {
				return info, e
			}
			dir, _, e = openArchiveDirectory(parent, name)
		}
		if e != nil {
			return info, e
		}
		opened = append(opened, dir)
		if e = s.storage.checkArchiveMount(dir); e != nil {
			return info, e
		}
		if e = errors.Join(s.storage.syncArchiveDirectory(parent), s.storage.syncArchiveDirectory(dir)); e != nil {
			return info, e
		}
		parent = dir
	}
	name := components[len(components)-1]
	// Never replace a symlink, special file, mounted file or multiply-linked
	// object. The latter also prevents aliases to any protected staging inode.
	if err = s.validPublishTarget(parent, name); err != nil {
		return info, err
	}
	if err = verifyMutation(ctx); err != nil {
		return info, err
	}
	temporary := ".daynight-upload-" + rand.Text()
	file, err := parent.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return info, err
	}
	defer func() {
		if temporary != "" {
			removeErr := parent.Remove(temporary)
			if errors.Is(removeErr, fs.ErrNotExist) {
				removeErr = nil
			}
			result = errors.Join(result, removeErr, s.storage.syncArchiveDirectory(parent))
		}
	}()
	size, copyErr := io.Copy(file, object.Body)
	if copyErr == nil && size != total {
		copyErr = io.ErrUnexpectedEOF
	}
	if copyErr == nil {
		copyErr = filestorage.GateError(ctx)
	}
	if copyErr == nil {
		copyErr = s.storage.fileSync(file)
	}
	if err = errors.Join(copyErr, file.Close()); err != nil {
		return info, err
	}
	if err = s.validPublishTarget(parent, name); err != nil {
		return info, err
	}
	if err = verifyMutation(ctx); err != nil {
		return info, err
	}
	outcome = filestorage.PublicationUnknown
	if err = parent.Rename(temporary, name); err != nil {
		return info, err
	}
	outcome = filestorage.Published
	temporary = ""
	if err = s.storage.syncArchiveDirectory(parent); err != nil {
		return info, err
	}
	if err = filestorage.GateError(ctx); err != nil {
		return info, err
	}
	return filestorage.FileInfo{Size: size}, nil
}

func (s *ArchiveStaging) validPublishTarget(parent *os.Root, name string) (result error) {
	if err := s.storage.checkArchiveMount(parent); err != nil {
		return err
	}
	before, err := parent.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return fmt.Errorf("%w: %s", filestorage.ErrNotRegular, name)
	}
	file, err := parent.Open(name)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, file.Close()) }()
	after, err := file.Stat()
	if err != nil {
		return err
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return filestorage.ErrPathConflict
	}
	if err = s.storage.checkArchiveFileMount(file); err != nil {
		return err
	}
	return verifyArchiveStagingFile(file)
}
