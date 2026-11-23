package local

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"syscall"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
)

var _ filestorage.ArchiveBlockStorage = (*Storage)(nil)
var _ filestorage.ArchiveBlockDeleter = (*Storage)(nil)
var _ filestorage.ArchiveStagingDeleter = (*Storage)(nil)

// PutArchiveBlock publishes a synced temporary inode with an atomic hard link.
// Link fails if the destination exists, including across Storage instances.
func (s *Storage) PutArchiveBlock(ctx context.Context, namespace sessionarchive.Namespace, fileID string, offset int64, data []byte) (result error) {
	outcome := filestorage.NotPublished
	defer func() {
		if result != nil {
			result = &filestorage.PublicationError{Outcome: outcome, Cause: result}
		}
	}()
	name, err := namespace.BlockPath(fileID, offset)
	if err != nil {
		return err
	}
	if len(data) == 0 || int64(len(data)) > sessionarchive.BlockSize {
		return fmt.Errorf("%w: invalid archive block length", filestorage.ErrInvalidAddress)
	}
	address, err := checkedAddress(ctx, sessionarchive.Bucket, name)
	if err != nil {
		return err
	}
	file, temporary, err := s.beginPut(ctx, address)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, s.discard(temporary)) }()
	_, err = io.Copy(file, contextReader{ctx: ctx, reader: bytes.NewReader(data)})
	if err == nil {
		err = filestorage.GateError(ctx)
	}
	if err == nil {
		err = s.fileSync(file)
	}
	if err = errors.Join(err, file.Close()); err != nil {
		return err
	}

	s.namespace.Lock()
	defer s.namespace.Unlock()
	if err = s.checkSpelling(address); err != nil {
		return err
	}
	if err = verifyMutation(ctx); err != nil {
		return err
	}
	outcome = filestorage.PublicationUnknown
	err = s.root.Link(temporary, address)
	if errors.Is(err, fs.ErrExist) {
		// A failed Link cannot have replaced the destination. Verify the opened
		// inode and repeat the durability barriers even after an interrupted peer.
		outcome = filestorage.NotPublished
		if err = s.verifyExistingArchiveBlock(ctx, address, data); err != nil {
			return err
		}
		outcome = filestorage.Published
	} else if err != nil {
		return err
	} else {
		outcome = filestorage.Published
	}
	return s.syncArchiveBlockParents(ctx, address)
}

func (s *Storage) verifyExistingArchiveBlock(ctx context.Context, address string, data []byte) (result error) {
	before, err := s.root.Lstat(address)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return fmt.Errorf("%w: %s", filestorage.ErrNotRegular, address)
	}
	file, err := s.root.Open(address)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, file.Close()) }()
	opened, err := file.Stat()
	if err != nil {
		return err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return filestorage.ErrPathConflict
	}
	if opened.Size() != int64(len(data)) {
		return filestorage.ErrArchiveBlockConflict
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(contextReader{ctx: ctx, reader: file}, int64(len(data))+1))
	if err != nil {
		return err
	}
	expected := sha256.Sum256(data)
	if size != int64(len(data)) || !bytes.Equal(hash.Sum(nil), expected[:]) {
		return filestorage.ErrArchiveBlockConflict
	}
	if err = verifyMutation(ctx); err != nil {
		return err
	}
	if err = s.fileSync(file); err != nil {
		return err
	}
	after, err := s.root.Lstat(address)
	if err != nil {
		return err
	}
	if !os.SameFile(opened, after) {
		return filestorage.ErrPathConflict
	}
	return filestorage.GateError(ctx)
}

func (s *Storage) syncArchiveBlockParents(ctx context.Context, address string) error {
	for directory := path.Dir(address); ; directory = path.Dir(directory) {
		file, err := s.root.Open(directory)
		if err != nil {
			return err
		}
		if err = errors.Join(s.fileSync(file), file.Close(), filestorage.GateError(ctx)); err != nil {
			return err
		}
		if directory == "." {
			return nil
		}
	}
}

// DeleteArchiveBlock verifies each rooted directory before removing a regular
// block. Empty parent removals are each followed by their parent's barrier;
// absence retries repeat the barriers for every surviving ancestor.
func (s *Storage) DeleteArchiveBlock(ctx context.Context, namespace sessionarchive.Namespace, fileID string, offset int64) error {
	name, err := namespace.BlockPath(fileID, offset)
	if err != nil {
		return err
	}
	return s.deleteDurableArchiveObject(ctx, sessionarchive.Bucket, name)
}

// DeleteArchiveStaging accepts only the assembled archive content and resource
// blob address forms. The archive operation owns the decision to remove them.
func (s *Storage) DeleteArchiveStaging(ctx context.Context, bucket, name string) error {
	parts := strings.Split(name, "/")
	if bucket == sessionarchive.Bucket {
		if len(parts) != 7 || parts[4] != "files" || parts[6] != "content" {
			return filestorage.ErrInvalidAddress
		}
	} else if bucket == sessionresource.Bucket {
		if len(parts) != 6 || parts[4] != "blobs" {
			return filestorage.ErrInvalidAddress
		}
	} else {
		return filestorage.ErrInvalidAddress
	}
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Kind(parts[0]), parts[1], parts[3])
	if err != nil || namespace.Directory() != strings.Join(parts[:4], "/") {
		return filestorage.ErrInvalidAddress
	}
	if _, err = namespace.BlockPath(parts[5], 0); err != nil {
		return filestorage.ErrInvalidAddress
	}
	return s.deleteDurableArchiveObject(ctx, bucket, name)
}

func (s *Storage) deleteDurableArchiveObject(ctx context.Context, bucket, name string) (result error) {
	address, err := checkedAddress(ctx, bucket, name)
	if err != nil {
		return err
	}
	s.namespace.Lock()
	defer s.namespace.Unlock()
	if err = verifyMutation(ctx); err != nil {
		return err
	}
	components := strings.Split(address, "/")
	directories := []*os.Root{s.root}
	infos := []fs.FileInfo{nil}
	defer func() {
		for i := len(directories) - 1; i > 0; i-- {
			result = errors.Join(result, directories[i].Close())
		}
	}()
	missing := false
	for i, component := range components[:len(components)-1] {
		if err = s.checkSpelling(strings.Join(components[:i+1], "/")); err != nil {
			return err
		}
		directory, info, e := openArchiveDirectory(directories[len(directories)-1], component)
		if errors.Is(e, fs.ErrNotExist) {
			missing = true
			break
		}
		if e != nil {
			return e
		}
		directories = append(directories, directory)
		infos = append(infos, info)
	}
	if !missing {
		if err = s.checkSpelling(address); err != nil {
			return err
		}
		parent := directories[len(directories)-1]
		leaf := components[len(components)-1]
		info, e := parent.Lstat(leaf)
		if e != nil && !errors.Is(e, fs.ErrNotExist) {
			return e
		}
		if e == nil {
			if !info.Mode().IsRegular() {
				return fmt.Errorf("%w: %s", filestorage.ErrNotRegular, address)
			}
			if err = removeArchiveEntry(ctx, parent, leaf, info); err != nil {
				return err
			}
		}
	}
	prune := true
	for i := len(directories) - 1; i >= 0; i-- {
		if err = filestorage.GateError(ctx); err != nil {
			return err
		}
		if err = s.syncArchiveDirectory(directories[i]); err != nil {
			return err
		}
		// Keep the bucket itself; it may be shared by other Sessions.
		if i <= 1 || !prune {
			continue
		}
		err = removeArchiveEntry(ctx, directories[i-1], components[i-1], infos[i])
		if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
			prune = false
		} else if err != nil {
			return err
		}
	}
	return verifyMutation(ctx)
}
